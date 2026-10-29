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
import { logError, logInfo } from '../log'

// Remote-change poll cadence. Every poll costs ~10+ Drive API queries
// (workspace validation, manifest lookup, folder resolution, listings, title
// state), and Google's "Total Query Cost / Units per minute per user" quota
// saturates with just two installations polling at seconds-scale — first hit
// physically 2026-10-29, where sustained 403s killed every reconnect. Local
// edits still reach Drive within PUSH_DEBOUNCE_MS via schedulePush; this
// interval only bounds how fast OTHER installations' changes arrive.
const POLL_INTERVAL_MS = 30_000
const PUSH_DEBOUNCE_MS = 750
// When Drive reports quota exhaustion, keep polling but much more slowly —
// hammering a saturated quota just keeps it saturated for the whole fleet.
const QUOTA_BACKOFF_MS = 90_000
// A failed connect used to leave the provider permanently dead until the
// editor remounted — one transient Drive error (a quota 403, a network blip)
// silently ended sync for the session. Connect failures now retry with capped
// exponential backoff while the provider stays connected.
const INITIAL_CONNECT_RETRY_MS = 5_000
const MAX_CONNECT_RETRY_MS = 60_000

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

/** Google's quota rejections survive sanitization as this phrase; everything
 *  else is treated as an ordinary transient error. */
function isQuotaError(error: unknown): boolean {
  return /quota exceeded/i.test(String(error))
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
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelayMs = INITIAL_CONNECT_RETRY_MS
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
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pollTimer = null
    this.pushTimer = null
    this.retryTimer = null
    this.retryDelayMs = INITIAL_CONNECT_RETRY_MS
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
      // Step breadcrumbs: initialize historically stalled silently (no error,
      // status stuck "connecting"); these mark exactly how far it got.
      const step = (name: string) =>
        logInfo('drive-provider', `init ${name} (${this.manifest.id.slice(0, 8)} gen ${generation})`)
      await this.local.whenReady()
      if (!this.connected || generation !== this.generation) return
      step('local-ready')
      if (!this.updatesAttached) {
        this.doc.on('update', this.forwardUpdate)
        this.updatesAttached = true
      }
      await this.pullRemote()
      step('pulled')
      await this.pullTitleState()
      step('title-pulled')
      migrateScenarioDocument(this.doc)
      step('migrated')
      await this.pushUpdate(Y.encodeStateAsUpdate(this.doc))
      step('pushed')
      await this.flushPending()
      step('flushed')
      if (!this.connected || generation !== this.generation) return
      this.unregisterMaintenance = registerDriveProjectMaintenance(this.manifest.id, this)
      this.unregisterAutomation = registerAutomationProjectDocument(this.manifest.id, this.doc)
      this.emit('sync', true)
      this.reportStatus({ state: 'synced', syncedAt: Date.now() })
      this.retryDelayMs = INITIAL_CONNECT_RETRY_MS
      this.resolveReady?.()
      this.schedulePoll(generation, POLL_INTERVAL_MS)
    } catch (error) {
      if (!this.connected || generation !== this.generation) return
      logError('drive-provider', `init failed (${this.manifest.id.slice(0, 8)} gen ${generation}): ${String(error).slice(0, 180)}`)
      this.reportStatus({ state: 'error', error: String(error) })
      this.rejectReady?.(error)
      // Keep trying while connected: callers awaiting whenReady still see the
      // first failure, but the session heals itself once Drive recovers
      // (update listeners are reattached idempotently via updatesAttached).
      const delay = Math.max(
        this.retryDelayMs,
        isQuotaError(error) ? QUOTA_BACKOFF_MS : 0,
      )
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_CONNECT_RETRY_MS)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        if (!this.connected || generation !== this.generation) return
        this.reportStatus({ state: 'connecting' })
        void this.initialize(generation)
      }, delay)
    }
  }

  /** Self-scheduling poll chain (not setInterval) so a quota-exhausted Drive
   *  gets a long breather instead of a steady hammer. */
  private schedulePoll(generation: number, delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      if (!this.connected || generation !== this.generation) return
      void this.syncNow()
        .then(() => {
          if (!this.connected || generation !== this.generation) return
          this.schedulePoll(generation, POLL_INTERVAL_MS)
        })
        .catch((error) => {
          if (!this.connected || generation !== this.generation) return
          this.reportStatus({ state: 'error', error: String(error) })
          this.schedulePoll(
            generation,
            isQuotaError(error) ? QUOTA_BACKOFF_MS : POLL_INTERVAL_MS,
          )
        })
    }, delay)
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
