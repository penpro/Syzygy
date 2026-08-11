import type { Provider } from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type {
  ProjectCollaborationProvider,
  ProjectProviderCapabilities,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'
import { LocalProjectProvider } from './localProvider'
import { createProjectDocument } from './projectModel'
import { registerProjectPresence } from './presenceRegistry'
import type { ResearchProjectManifest } from './schema'
import {
  normalizeWebsocketProjectBinding,
  type WebsocketProjectBinding,
} from './websocketProjectBinding'
import { registerWebsocketProjectStatus } from './websocketProjectStatus'

const READY_DEADLINE_MS = 15_000

export {
  createWebsocketRoomId,
  normalizeWebsocketProjectBinding,
  type NormalizedWebsocketProjectBinding,
  type WebsocketProjectBinding,
} from './websocketProjectBinding'

export const WEBSOCKET_PROVIDER_CAPABILITIES: ProjectProviderCapabilities = {
  realtime: true,
  awareness: true,
  durableLocal: true,
  remotePersistence: false,
  attachments: false,
}

/**
 * A real y-websocket-compatible network provider composed with the existing local IndexedDB
 * provider. The relay is replaceable and need not retain state: every client first restores its
 * local Y.Doc, then Yjs exchanges missing updates after connection or relay restart.
 */
export class WebsocketProjectProvider implements ProjectCollaborationProvider {
  readonly awareness: Awareness
  readonly capabilities = WEBSOCKET_PROVIDER_CAPABILITIES
  private readonly local: LocalProjectProvider
  private readonly remote: WebsocketProvider
  private readonly listeners = new Map<ProjectProviderEvent, Set<ProjectProviderListener>>()
  private connected = false
  private remoteReady = false
  private unregisterPresence: (() => void) | null = null
  private statusRegistration: ReturnType<typeof registerWebsocketProjectStatus> | null = null
  private readonly forwardUpdate = (update: Uint8Array) => this.emit('update', update)
  private readonly forwardStatus = (event: { status: 'connected' | 'disconnected' | 'connecting' }) => {
    this.emit('status', event)
    if (event.status !== 'connected') this.statusRegistration?.publish({ state: event.status })
  }
  private readonly forwardSync = (synced: boolean) => {
    this.remoteReady = synced
    this.emit('sync', synced)
    this.statusRegistration?.publish(synced
      ? { state: 'connected', syncedAt: Date.now() }
      : { state: 'connecting' })
  }
  private readonly forwardConnectionError = () => {
    this.emit('status', { status: 'error', error: 'Self-hosted collaboration relay is unavailable' })
    this.statusRegistration?.publish({
      state: 'error',
      error: 'Self-hosted collaboration relay is unavailable',
    })
  }

  constructor(
    readonly doc: Y.Doc,
    bindingValue: WebsocketProjectBinding,
    private readonly projectId = doc.guid,
    storageKey = `syzygy-project-v1:${projectId}`,
  ) {
    const binding = normalizeWebsocketProjectBinding(bindingValue)
    this.awareness = new Awareness(doc)
    this.local = new LocalProjectProvider(doc, storageKey, projectId, true, false)
    this.remote = new WebsocketProvider(binding.endpoint, binding.roomId, doc, {
      awareness: this.awareness,
      connect: false,
      disableBc: true,
      maxBackoffTime: 2_500,
      params: binding.access ? {
        member: binding.access.memberId,
        capability: binding.access.capability,
      } : {},
    })
    this.remote.on('status', this.forwardStatus)
    this.remote.on('sync', this.forwardSync)
    this.remote.on('connection-error', this.forwardConnectionError)
    doc.on('update', this.forwardUpdate)
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.statusRegistration?.unregister()
    this.statusRegistration = registerWebsocketProjectStatus(this.projectId)
    this.local.connect()
    this.unregisterPresence = registerProjectPresence(this.projectId, this.awareness, 'live')
    this.remote.connect()
  }

  async whenReady(): Promise<void> {
    await this.local.whenReady()
    if (this.remoteReady) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        this.remote.off('sync', onSync)
        error ? reject(error) : resolve()
      }
      const onSync = (synced: boolean) => {
        if (synced) finish()
      }
      const deadline = setTimeout(
        () => finish(new Error('Self-hosted collaboration relay did not synchronize within 15 seconds')),
        READY_DEADLINE_MS,
      )
      this.remote.on('sync', onSync)
      if (this.remoteReady) finish()
    })
  }

  disconnect(): void {
    if (!this.connected) {
      this.awareness.setLocalState(null)
      return
    }
    this.connected = false
    this.unregisterPresence?.()
    this.unregisterPresence = null
    this.remote.disconnect()
    this.local.disconnect()
    this.statusRegistration?.publish({ state: 'disconnected' })
  }

  async flush(): Promise<void> {
    await this.local.flush()
  }

  async destroy(): Promise<void> {
    this.disconnect()
    try {
      await this.local.flush()
    } finally {
      this.remote.off('status', this.forwardStatus)
      this.remote.off('sync', this.forwardSync)
      this.remote.off('connection-error', this.forwardConnectionError)
      this.remote.destroy()
      this.doc.off('update', this.forwardUpdate)
      this.awareness.destroy()
      try {
        await this.local.destroy()
      } finally {
        this.statusRegistration?.unregister()
        this.statusRegistration = null
      }
    }
  }

  on(type: ProjectProviderEvent, callback: ProjectProviderListener): void {
    const listeners = this.listeners.get(type) ?? new Set<ProjectProviderListener>()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  off(type: ProjectProviderEvent, callback: ProjectProviderListener): void {
    this.listeners.get(type)?.delete(callback)
  }

  private emit(type: ProjectProviderEvent, payload: unknown): void {
    this.listeners.get(type)?.forEach((listener) => listener(payload))
  }
}

export function createWebsocketProviderFactory(
  manifest: ResearchProjectManifest,
  binding: WebsocketProjectBinding,
) {
  const normalized = normalizeWebsocketProjectBinding(binding)
  return (id: string, docMap: Map<string, Y.Doc>): Provider => {
    const doc = createProjectDocument(manifest)
    docMap.set(id, doc)
    return new WebsocketProjectProvider(doc, normalized, manifest.id) as unknown as Provider
  }
}
