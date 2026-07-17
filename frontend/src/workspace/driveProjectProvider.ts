import type { Provider } from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  googleDriveProjectPull,
  googleDriveProjectPush,
  type DriveProjectPullResult,
} from '../tauri'
import type {
  ProjectCollaborationProvider,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'
import { LocalProjectProvider } from './localProvider'
import { createProjectDocument } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import { registerAutomationProjectDocument } from './workspaceAutomationRegistry'
import { publishDriveProjectStatus, type DriveProjectSyncStatus } from './driveProjectStatus'

const POLL_INTERVAL_MS = 3_000
const PUSH_DEBOUNCE_MS = 750

export interface DriveProjectRemote {
  pull(projectId: string, documentId: string, knownUpdateIds: string[]): Promise<DriveProjectPullResult>
  push(projectId: string, documentId: string, clientId: string, updateBase64: string): Promise<{ updateId: string }>
}

const tauriRemote: DriveProjectRemote = {
  pull: googleDriveProjectPull,
  push: googleDriveProjectPush,
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Drive returned an invalid Yjs update encoding')
  }
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * IndexedDB-backed Drive transport. Drive records are append-only, so concurrent writers never
 * replace one another. Yjs remains the only merge authority and every remote update is also
 * persisted into the local IndexedDB document.
 */
export class DriveProjectProvider implements ProjectCollaborationProvider {
  readonly awareness: Awareness
  private readonly listeners = new Map<ProjectProviderEvent, Set<ProjectProviderListener>>()
  private readonly seenUpdateIds = new Set<string>()
  private readonly clientId = crypto.randomUUID()
  private connected = false
  private generation = 0
  private pendingUpdates: Uint8Array[] = []
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private syncing: Promise<void> | null = null
  private unregisterAutomation: (() => void) | null = null
  private readyPromise: Promise<void> = Promise.resolve()
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: unknown) => void) | null = null
  private updatesAttached = false

  private readonly forwardUpdate = (update: Uint8Array, origin: unknown) => {
    this.emit('update', update)
    if (!this.connected || origin === this) return
    this.pendingUpdates.push(update)
    this.schedulePush()
  }

  constructor(
    readonly doc: Y.Doc,
    private readonly manifest: ResearchProjectManifest,
    private readonly remote: DriveProjectRemote = tauriRemote,
    private readonly local: ProjectCollaborationProvider = new LocalProjectProvider(
      doc,
      `syzygy-project-v1:${manifest.id}`,
      manifest.id,
      false,
    ),
  ) {
    this.awareness = local.awareness
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    const generation = ++this.generation
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.reportStatus({ state: 'connecting' })
    this.local.connect()
    void this.initialize(generation)
  }

  async whenReady(): Promise<void> {
    await this.readyPromise
  }

  disconnect(): void {
    this.generation += 1
    this.connected = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pollTimer = null
    this.pushTimer = null
    if (this.updatesAttached) this.doc.off('update', this.forwardUpdate)
    this.updatesAttached = false
    this.unregisterAutomation?.()
    this.unregisterAutomation = null
    this.local.disconnect()
    this.awareness.setLocalState(null)
    this.reportStatus({ state: 'disconnected' })
  }

  async destroy(): Promise<void> {
    this.disconnect()
    await this.local.destroy()
  }

  on(type: ProjectProviderEvent, callback: ProjectProviderListener): void {
    const listeners = this.listeners.get(type) ?? new Set<ProjectProviderListener>()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  off(type: ProjectProviderEvent, callback: ProjectProviderListener): void {
    this.listeners.get(type)?.delete(callback)
  }

  /** Explicit bounded synchronization hook used by deterministic tests and future UI controls. */
  async syncNow(): Promise<void> {
    if (!this.connected) throw new Error('Drive project is disconnected')
    if (this.syncing) return this.syncing
    this.syncing = this.performSync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async initialize(generation: number): Promise<void> {
    try {
      await this.local.whenReady()
      if (!this.connected || generation !== this.generation) return
      this.doc.on('update', this.forwardUpdate)
      this.updatesAttached = true
      await this.pullRemote()
      await this.pushUpdate(Y.encodeStateAsUpdate(this.doc))
      await this.flushPending()
      if (!this.connected || generation !== this.generation) return
      this.unregisterAutomation = registerAutomationProjectDocument(this.manifest.id, this.doc)
      this.emit('sync', true)
      this.reportStatus({ state: 'synced', syncedAt: Date.now() })
      this.resolveReady?.()
      this.pollTimer = setInterval(() => void this.syncNow().catch((error) => {
        this.reportStatus({ state: 'error', error: String(error) })
      }), POLL_INTERVAL_MS)
    } catch (error) {
      if (!this.connected || generation !== this.generation) return
      this.reportStatus({ state: 'error', error: String(error) })
      this.rejectReady?.(error)
    }
  }

  private async performSync(): Promise<void> {
    await this.pullRemote()
    await this.flushPending()
    this.emit('reload', { transport: 'drive', syncedAt: Date.now() })
    this.reportStatus({ state: 'synced', syncedAt: Date.now() })
  }

  private async pullRemote(): Promise<void> {
    const result = await this.remote.pull(
      this.manifest.id,
      this.manifest.documentId,
      [...this.seenUpdateIds],
    )
    for (const update of result.updates) {
      if (this.seenUpdateIds.has(update.id)) continue
      const bytes = base64ToBytes(update.updateBase64)
      this.seenUpdateIds.add(update.id)
      Y.applyUpdate(this.doc, bytes, this)
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.syncNow().catch((error) => {
        this.reportStatus({ state: 'error', error: String(error) })
      })
    }, PUSH_DEBOUNCE_MS)
  }

  private async flushPending(): Promise<void> {
    if (this.pendingUpdates.length === 0) return
    const pending = this.pendingUpdates
    this.pendingUpdates = []
    try {
      await this.pushUpdate(Y.mergeUpdates(pending))
    } catch (error) {
      this.pendingUpdates = [...pending, ...this.pendingUpdates]
      throw error
    }
  }

  private async pushUpdate(update: Uint8Array): Promise<void> {
    const result = await this.remote.push(
      this.manifest.id,
      this.manifest.documentId,
      this.clientId,
      bytesToBase64(update),
    )
    this.seenUpdateIds.add(result.updateId)
  }

  private reportStatus(status: DriveProjectSyncStatus): void {
    publishDriveProjectStatus(this.manifest.id, status)
    this.emit('status', {
      status: status.state === 'synced' ? 'connected' : status.state,
      transport: 'drive',
      ...status,
    })
  }

  private emit(type: ProjectProviderEvent, payload: unknown): void {
    this.listeners.get(type)?.forEach((listener) => listener(payload))
  }
}

export function createDriveProviderFactory(manifest: ResearchProjectManifest) {
  return (id: string, docMap: Map<string, Y.Doc>): Provider => {
    const doc = createProjectDocument(manifest)
    docMap.set(id, doc)
    return new DriveProjectProvider(doc, manifest) as unknown as Provider
  }
}
