import { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'

export type ProjectProviderEvent = 'sync' | 'status' | 'update' | 'reload'
export type ProjectProviderListener = (payload: unknown) => void

/** Provider-neutral lifecycle exercised by Memory today and future Drive/WebSocket transports. */
export interface ProjectCollaborationProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  connect(): void
  whenReady(): Promise<void>
  disconnect(): void
  destroy(): Promise<void>
  on(type: ProjectProviderEvent, callback: ProjectProviderListener): void
  off(type: ProjectProviderEvent, callback: ProjectProviderListener): void
}
