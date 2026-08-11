import type { Provider } from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  googleDriveProjectCompact,
  googleDriveProjectPull,
  googleDriveProjectPush,
  googleDriveProjectTitleCompact,
  googleDriveProjectTitleState,
  googleDriveProjectTitleUpdate,
  type DriveProjectCompactionResult,
  type DriveProjectPullResult,
  type DriveProjectTitleCompactionResult,
  type DriveProjectTitleState,
} from '../tauri'
import { useStore } from '../store'
import type {
  ProjectCollaborationProvider,
  ProjectProviderCapabilities,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'
import { LocalProjectProvider } from './localProvider'
import { createProjectDocument } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import { migrateScenarioDocument } from '../migrations'
import { registerAutomationProjectDocument } from './workspaceAutomationRegistry'
import { publishDriveProjectStatus, type DriveProjectSyncStatus } from './driveProjectStatus'
import { registerProjectPresence } from './presenceRegistry'
import { registerDriveProjectMaintenance } from './driveProjectMaintenanceRegistry'
import { clearDriveProjectTitleState, publishDriveProjectTitleState } from './driveProjectTitleStatus'

const POLL_INTERVAL_MS = 3_000
const PUSH_DEBOUNCE_MS = 750

export interface DriveProjectRemote {
  pull(projectId: string, documentId: string, knownUpdateIds: string[]): Promise<DriveProjectPullResult>
  push(projectId: string, documentId: string, clientId: string, updateBase64: string): Promise<{ updateId: string }>
  compact(
    projectId: string,
    documentId: string,
    clientId: string,
    snapshotUpdateBase64: string,
    includedUpdateIds: string[],
  ): Promise<DriveProjectCompactionResult>
  readTitle(projectId: string, documentId: string): Promise<DriveProjectTitleState>
  compactTitle(
    projectId: string,
    documentId: string,
    expectedRevisionGuards: string[],
  ): Promise<DriveProjectTitleCompactionResult>
  updateTitle(
    projectId: string,
    documentId: string,
    title: string,
    expectedRevisionGuards: string[],
    participantId: string,
    displayName: string,
    timestamp: number,
  ): Promise<DriveProjectTitleState>
}

const tauriRemote: DriveProjectRemote = {
  pull: googleDriveProjectPull,
  push: googleDriveProjectPush,
  compact: googleDriveProjectCompact,
  readTitle: googleDriveProjectTitleState,
  compactTitle: googleDriveProjectTitleCompact,
  updateTitle: googleDriveProjectTitleUpdate,
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
  readonly capabilities: ProjectProviderCapabilities = {
    realtime: false,
    awareness: false,
    durableLocal: true,
    remotePersistence: true,
    attachments: false,
  }
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
  private unregisterPresence: (() => void) | null = null
  private unregisterMaintenance: (() => void) | null = null
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
      false,
    ),
  ) {
    this.awareness = local.awareness
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.unregisterPresence = registerProjectPresence(this.manifest.id, this.awareness, 'drive-polling')
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
    this.unregisterMaintenance?.()
    this.unregisterMaintenance = null
    clearDriveProjectTitleState(this.manifest.id, this)
    this.local.disconnect()
    this.awareness.setLocalState(null)
    this.unregisterPresence?.()
    this.unregisterPresence = null
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

  /**
   * Explicit snapshot-first Drive maintenance. The native boundary archives only update IDs this
   * provider has already applied; unknown concurrent records remain active and are pulled again.
   */
  async compactNow(assertSnapshotReady?: () => void): Promise<DriveProjectCompactionResult> {
    if (!this.connected) throw new Error('Drive project is disconnected')
    await this.syncNow()
    assertSnapshotReady?.()
    const includedUpdateIds = [...this.seenUpdateIds]
    if (includedUpdateIds.length === 0) throw new Error('Drive project has no applied updates to compact')
    const result = await this.remote.compact(
      this.manifest.id,
      this.manifest.documentId,
      this.clientId,
      bytesToBase64(Y.encodeStateAsUpdate(this.doc)),
      includedUpdateIds,
    )
    this.seenUpdateIds.clear()
    this.seenUpdateIds.add(result.snapshotUpdateId)
    await this.pullRemote()
    return result
  }

  async updateTitle(
    title: string,
    expectedRevisionGuards: string[],
    participantId: string,
    displayName: string,
  ): Promise<DriveProjectTitleState> {
    if (!this.connected) throw new Error('Drive project is disconnected')
    await this.syncNow()
    const state = await this.remote.updateTitle(
      this.manifest.id,
      this.manifest.documentId,
      title,
      [...expectedRevisionGuards].sort(),
      participantId,
      displayName,
      Date.now(),
    )
    this.applyTitleState(state)
    return state
  }

  async compactTitleNow(expectedRevisionGuards: string[]): Promise<DriveProjectTitleCompactionResult> {
    if (!this.connected) throw new Error('Drive project is disconnected')
    await this.syncNow()
    const result = await this.remote.compactTitle(
      this.manifest.id,
      this.manifest.documentId,
      [...expectedRevisionGuards].sort(),
    )
    this.applyTitleState(result.state)
    return result
  }

  private async initialize(generation: number): Promise<void> {
    try {
      await this.local.whenReady()
      if (!this.connected || generation !== this.generation) return
      this.doc.on('update', this.forwardUpdate)
      this.updatesAttached = true
      await this.pullRemote()
      await this.pullTitleState()
      migrateScenarioDocument(this.doc)
      await this.pushUpdate(Y.encodeStateAsUpdate(this.doc))
      await this.flushPending()
      if (!this.connected || generation !== this.generation) return
      this.unregisterMaintenance = registerDriveProjectMaintenance(this.manifest.id, this)
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
    await this.pullTitleState()
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
      Y.applyUpdate(this.doc, bytes, this)
      this.seenUpdateIds.add(update.id)
    }
  }

  private async pullTitleState(): Promise<void> {
    const state = await this.remote.readTitle(this.manifest.id, this.manifest.documentId)
    this.applyTitleState(state)
  }

  private applyTitleState(state: DriveProjectTitleState): void {
    if (state.projectId !== this.manifest.id || state.documentId !== this.manifest.documentId) {
      throw new Error('Drive project title state identity does not match the active project')
    }
    publishDriveProjectTitleState(this.manifest.id, this, state)
    useStore.getState().applySharedProjectTitle(this.manifest.id, state.title)
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
