import type { Provider } from '@lexical/yjs'
import { IndexeddbPersistence, storeState } from 'y-indexeddb'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createProjectDocument } from './projectModel'
import type { ResearchProjectManifest } from './schema'

type ProviderEvent = 'sync' | 'status' | 'update' | 'reload'
type Listener = (payload: unknown) => void

export class LocalProjectProvider {
  readonly awareness: Awareness
  private readonly persistence: IndexeddbPersistence
  private readonly listeners = new Map<ProviderEvent, Set<Listener>>()
  private connected = false

  constructor(
    readonly doc: Y.Doc,
    storageKey: string,
  ) {
    this.awareness = new Awareness(doc)
    this.persistence = new IndexeddbPersistence(storageKey, doc)
    doc.on('update', (update: Uint8Array) => this.emit('update', update))
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.emit('status', { status: 'connecting' })
    // Return void deliberately. Lexical's development StrictMode cleanup defers disconnecting
    // promise-returning providers and can disconnect a newer mount when the old promise settles.
    // A void lifecycle makes cleanup immediate; the readiness continuation is generation-safe.
    void this.persistence.whenSynced.then(() => {
      if (!this.connected) return
      this.emit('sync', true)
      this.emit('status', { status: 'connected' })
    })
  }

  async whenReady(): Promise<void> {
    await this.persistence.whenSynced
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.awareness.setLocalState(null)
    this.emit('status', { status: 'disconnected' })
  }

  async flush(): Promise<void> {
    await storeState(this.persistence)
  }

  async destroy(): Promise<void> {
    this.disconnect()
    this.awareness.destroy()
    await this.persistence.destroy()
  }

  async clearData(): Promise<void> {
    this.disconnect()
    this.awareness.destroy()
    await this.persistence.clearData()
  }

  on(type: ProviderEvent, callback: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  off(type: ProviderEvent, callback: Listener): void {
    this.listeners.get(type)?.delete(callback)
  }

  private emit(type: ProviderEvent, payload: unknown): void {
    this.listeners.get(type)?.forEach((listener) => listener(payload))
  }
}

export function createLocalProviderFactory(manifest: ResearchProjectManifest) {
  return (id: string, docMap: Map<string, Y.Doc>): Provider => {
    const doc = createProjectDocument(manifest)
    docMap.set(id, doc)
    const provider = new LocalProjectProvider(doc, `syzygy-project-v1:${manifest.id}`)
    // Lexical's provider contract intentionally supports several network providers. This
    // local implementation exposes the same lifecycle and awareness surface while IndexedDB
    // supplies durable offline updates; Drive and WebSocket providers can replace it later.
    return provider as unknown as Provider
  }
}
