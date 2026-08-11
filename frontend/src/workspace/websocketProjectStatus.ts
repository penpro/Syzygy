export type WebsocketProjectConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface WebsocketProjectStatus {
  state: WebsocketProjectConnectionState
  syncedAt?: number
  error?: string
}

interface StatusEntry {
  owner: symbol
  status: WebsocketProjectStatus
}

const entries = new Map<string, StatusEntry>()
const listeners = new Map<string, Set<() => void>>()

function emit(projectId: string): void {
  listeners.get(projectId)?.forEach((listener) => listener())
}

export function getWebsocketProjectStatus(projectId: string): WebsocketProjectStatus | null {
  const status = entries.get(projectId)?.status
  return status ? { ...status } : null
}

export function subscribeWebsocketProjectStatus(projectId: string, listener: () => void): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<() => void>()
  projectListeners.add(listener)
  listeners.set(projectId, projectListeners)
  return () => {
    projectListeners.delete(listener)
    if (projectListeners.size === 0) listeners.delete(projectId)
  }
}

export function registerWebsocketProjectStatus(projectId: string): {
  publish: (status: WebsocketProjectStatus) => void
  unregister: () => void
} {
  const owner = Symbol(projectId)
  entries.set(projectId, { owner, status: { state: 'connecting' } })
  emit(projectId)
  return {
    publish(status) {
      if (entries.get(projectId)?.owner !== owner) return
      entries.set(projectId, { owner, status: { ...status } })
      emit(projectId)
    },
    unregister() {
      if (entries.get(projectId)?.owner !== owner) return
      entries.delete(projectId)
      emit(projectId)
    },
  }
}
