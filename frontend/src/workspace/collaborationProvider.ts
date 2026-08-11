import { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

export type ProjectProviderEvent = 'sync' | 'status' | 'update' | 'reload'
export type ProjectProviderListener = (payload: unknown) => void

export interface ProjectProviderCapabilities {
  readonly realtime: boolean
  readonly awareness: boolean
  readonly durableLocal: boolean
  readonly remotePersistence: boolean
  readonly attachments: boolean
}

/** Provider-neutral lifecycle shared by local, Drive, memory-fixture, and WebSocket transports. */
export interface ProjectCollaborationProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly capabilities: ProjectProviderCapabilities
  connect(): void
  whenReady(): Promise<void>
  disconnect(): void
  destroy(): Promise<void>
  on(type: ProjectProviderEvent, callback: ProjectProviderListener): void
  off(type: ProjectProviderEvent, callback: ProjectProviderListener): void
}
