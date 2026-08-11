import type { Provider } from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import {
  collaborationIdentitySignRelayAccess,
  type RelayAccessIdentityClaim,
  type RelayAccessIdentityProof,
} from '../tauri'
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
const SIGNED_RECONNECT_DELAY_MS = 250

export type RelayAccessSigner = (
  claim: RelayAccessIdentityClaim,
) => Promise<RelayAccessIdentityProof>

function randomNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
  private readonly binding: ReturnType<typeof normalizeWebsocketProjectBinding>
  private remote: WebsocketProvider | null = null
  private readonly listeners = new Map<ProjectProviderEvent, Set<ProjectProviderListener>>()
  private connected = false
  private destroyed = false
  private remoteReady = false
  private remoteGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
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
  private readonly forwardConnectionClose = (_event: unknown, provider: WebsocketProvider) => {
    if (this.binding.access?.schemaVersion !== 3 || provider !== this.remote || !this.connected) return
    // Stop y-websocket's built-in reconnect before its scheduled setup reuses this one-time proof.
    provider.shouldConnect = false
    queueMicrotask(() => {
      if (provider !== this.remote || !this.connected) return
      this.retireRemote(provider)
      this.remote = null
      this.remoteReady = false
      this.scheduleSignedReconnect()
    })
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
    private readonly relayAccessSigner: RelayAccessSigner = collaborationIdentitySignRelayAccess,
  ) {
    this.binding = normalizeWebsocketProjectBinding(bindingValue)
    this.awareness = new Awareness(doc)
    this.local = new LocalProjectProvider(doc, storageKey, projectId, true, false)
    if (this.binding.access?.schemaVersion !== 3) {
      this.installRemote(this.baseParams())
    }
    doc.on('update', this.forwardUpdate)
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.statusRegistration?.unregister()
    this.statusRegistration = registerWebsocketProjectStatus(this.projectId)
    this.local.connect()
    this.unregisterPresence = registerProjectPresence(this.projectId, this.awareness, 'live')
    if (this.remote) this.remote.connect()
    else void this.establishSignedRemote()
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
        this.off('sync', onSync)
        error ? reject(error) : resolve()
      }
      const onSync: ProjectProviderListener = (synced) => {
        if (synced === true) finish()
      }
      const deadline = setTimeout(
        () => finish(new Error('Self-hosted collaboration relay did not synchronize within 15 seconds')),
        READY_DEADLINE_MS,
      )
      this.on('sync', onSync)
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
    this.remoteGeneration += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.remote && this.binding.access?.schemaVersion === 3) {
      const remote = this.remote
      this.remote = null
      this.retireRemote(remote)
    } else {
      this.remote?.disconnect()
    }
    this.local.disconnect()
    this.statusRegistration?.publish({ state: 'disconnected' })
  }

  async flush(): Promise<void> {
    await this.local.flush()
  }

  async destroy(): Promise<void> {
    this.disconnect()
    this.destroyed = true
    try {
      await this.local.flush()
    } finally {
      if (this.remote) {
        const remote = this.remote
        this.remote = null
        this.retireRemote(remote)
      }
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

  private baseParams(): Record<string, string> {
    return this.binding.access ? {
      member: this.binding.access.memberId,
      capability: this.binding.access.capability,
    } : {}
  }

  private installRemote(params: Record<string, string>): WebsocketProvider {
    const remote = new WebsocketProvider(this.binding.endpoint, this.binding.roomId, this.doc, {
      awareness: this.awareness,
      connect: false,
      disableBc: true,
      maxBackoffTime: 2_500,
      params,
    })
    remote.on('status', this.forwardStatus)
    remote.on('sync', this.forwardSync)
    remote.on('connection-error', this.forwardConnectionError)
    remote.on('connection-close', this.forwardConnectionClose)
    this.remote = remote
    return remote
  }

  private retireRemote(remote: WebsocketProvider): void {
    remote.off('status', this.forwardStatus)
    remote.off('sync', this.forwardSync)
    remote.off('connection-error', this.forwardConnectionError)
    remote.off('connection-close', this.forwardConnectionClose)
    remote.destroy()
  }

  private scheduleSignedReconnect(): void {
    if (!this.connected || this.destroyed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.establishSignedRemote()
    }, SIGNED_RECONNECT_DELAY_MS)
  }

  private async establishSignedRemote(): Promise<void> {
    const access = this.binding.access
    if (access?.schemaVersion !== 3 || !this.connected || this.destroyed || this.remote) return
    const generation = ++this.remoteGeneration
    const claim: RelayAccessIdentityClaim = {
      schemaVersion: 1,
      roomId: this.binding.roomId,
      memberId: access.memberId,
      capabilityGeneration: access.capabilityGeneration,
      issuedAtMs: Date.now(),
      nonce: randomNonce(),
      capability: access.capability,
    }
    try {
      const proof = await this.relayAccessSigner(claim)
      if (!this.connected || this.destroyed || generation !== this.remoteGeneration || this.remote) return
      if (proof.schemaVersion !== 1 || proof.algorithm !== 'Ed25519' ||
        proof.keyId !== access.deviceKeyId || proof.signature.length !== 86 ||
        JSON.stringify(proof.claim) !== JSON.stringify(claim)) {
        throw new Error('This installation does not match the device key enrolled for this relay member')
      }
      const remote = this.installRemote({
        ...this.baseParams(),
        generation: String(claim.capabilityGeneration),
        issued: String(claim.issuedAtMs),
        nonce: claim.nonce,
        signature: proof.signature,
      })
      if (this.connected) remote.connect()
    } catch (error) {
      if (!this.connected || this.destroyed || generation !== this.remoteGeneration) return
      const message = error instanceof Error ? error.message : String(error)
      this.emit('status', { status: 'error', error: message })
      this.statusRegistration?.publish({ state: 'error', error: message })
      this.scheduleSignedReconnect()
    }
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
