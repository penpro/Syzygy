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

const READY_DEADLINE_MS = 15_000
const MAX_ENDPOINT_LENGTH = 2_048
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export interface WebsocketProjectBinding {
  endpoint: string
  roomId: string
}

export interface NormalizedWebsocketProjectBinding extends WebsocketProjectBinding {
  endpoint: string
}

export const WEBSOCKET_PROVIDER_CAPABILITIES: ProjectProviderCapabilities = {
  realtime: true,
  awareness: true,
  durableLocal: true,
  remotePersistence: false,
  attachments: false,
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 127
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '[::1]'
    || normalized.endsWith('.local')
    || isPrivateIpv4(normalized)
}

/**
 * The first self-hosted transport is intentionally capability-limited: plaintext WebSockets are
 * accepted only on loopback/private LAN hosts, while non-private endpoints must use TLS. Secrets,
 * query parameters, fragments, and embedded credentials never enter the persisted binding.
 */
export function normalizeWebsocketProjectBinding(
  value: WebsocketProjectBinding,
): NormalizedWebsocketProjectBinding {
  if (typeof value.endpoint !== 'string' || value.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('WebSocket collaboration endpoint is missing or too long')
  }
  let endpoint: URL
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    throw new Error('WebSocket collaboration endpoint is invalid')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error('WebSocket collaboration endpoint must use ws:// or wss://')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WebSocket collaboration endpoint cannot contain credentials, query parameters, or fragments')
  }
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    throw new Error('WebSocket collaboration endpoint cannot contain a room path')
  }
  if (endpoint.protocol === 'ws:' && !isPrivateHostname(endpoint.hostname)) {
    throw new Error('Plaintext WebSocket collaboration is limited to loopback or private LAN hosts')
  }
  if (!ROOM_ID_PATTERN.test(value.roomId)) {
    throw new Error('WebSocket collaboration room ID must be 32-128 URL-safe characters')
  }
  return {
    endpoint: endpoint.origin,
    roomId: value.roomId,
  }
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
  private readonly forwardUpdate = (update: Uint8Array) => this.emit('update', update)
  private readonly forwardStatus = (event: { status: 'connected' | 'disconnected' | 'connecting' }) => {
    this.emit('status', event)
  }
  private readonly forwardSync = (synced: boolean) => {
    this.remoteReady = synced
    this.emit('sync', synced)
  }
  private readonly forwardConnectionError = () => {
    this.emit('status', { status: 'error', error: 'Self-hosted collaboration relay is unavailable' })
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
    })
    this.remote.on('status', this.forwardStatus)
    this.remote.on('sync', this.forwardSync)
    this.remote.on('connection-error', this.forwardConnectionError)
    doc.on('update', this.forwardUpdate)
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
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
  }

  async flush(): Promise<void> {
    await this.local.flush()
  }

  async destroy(): Promise<void> {
    this.disconnect()
    await this.local.flush()
    this.remote.off('status', this.forwardStatus)
    this.remote.off('sync', this.forwardSync)
    this.remote.off('connection-error', this.forwardConnectionError)
    this.remote.destroy()
    this.doc.off('update', this.forwardUpdate)
    this.awareness.destroy()
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
