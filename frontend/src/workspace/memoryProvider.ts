import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type {
  ProjectCollaborationProvider,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'

/**
 * Deterministic in-memory transport for two-editor and partition testing. It is not persistence
 * and is not used as a product collaboration claim; Drive and WebSocket providers must pass the
 * same lifecycle/convergence behavior before their status changes.
 */
export class MemoryProjectHub {
  private readonly connected = new Set<MemoryProjectProvider>()

  join(provider: MemoryProjectProvider): void {
    // Full-state exchange makes reconnect merge offline work from both sides. Applying with the
    // hub as origin prevents the update listeners from echoing packets back into the hub.
    for (const peer of this.connected) {
      Y.applyUpdate(provider.doc, Y.encodeStateAsUpdate(peer.doc), this)
      Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(provider.doc), this)
    }
    this.connected.add(provider)
  }

  leave(provider: MemoryProjectProvider): void {
    this.connected.delete(provider)
  }

  publish(source: MemoryProjectProvider, update: Uint8Array): void {
    for (const peer of this.connected) {
      if (peer !== source) Y.applyUpdate(peer.doc, update, this)
    }
  }

  get connectedCount(): number {
    return this.connected.size
  }
}

export class MemoryProjectProvider implements ProjectCollaborationProvider {
  readonly awareness: Awareness
  private readonly listeners = new Map<ProjectProviderEvent, Set<ProjectProviderListener>>()
  private connected = false
  private readonly forwardUpdate = (update: Uint8Array, origin: unknown) => {
    this.emit('update', update)
    if (this.connected && origin !== this.hub) this.hub.publish(this, update)
  }

  constructor(
    readonly doc: Y.Doc,
    private readonly hub: MemoryProjectHub,
  ) {
    this.awareness = new Awareness(doc)
    doc.on('update', this.forwardUpdate)
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.emit('status', { status: 'connecting' })
    this.hub.join(this)
    this.emit('sync', true)
    this.emit('status', { status: 'connected' })
  }

  async whenReady(): Promise<void> {
    // Memory exchange completes synchronously during connect.
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.hub.leave(this)
    this.awareness.setLocalState(null)
    this.emit('status', { status: 'disconnected' })
  }

  async destroy(): Promise<void> {
    this.disconnect()
    this.doc.off('update', this.forwardUpdate)
    this.awareness.destroy()
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
