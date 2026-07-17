export type DriveProjectSyncStatus =
  | { state: 'connecting' }
  | { state: 'synced'; syncedAt: number }
  | { state: 'error'; error: string }
  | { state: 'disconnected' }

type DriveProjectStatusListener = (status: DriveProjectSyncStatus | null) => void

const statuses = new Map<string, DriveProjectSyncStatus>()
const listeners = new Map<string, Set<DriveProjectStatusListener>>()

export function publishDriveProjectStatus(projectId: string, status: DriveProjectSyncStatus): void {
  statuses.set(projectId, status)
  listeners.get(projectId)?.forEach((listener) => listener(status))
}

export function clearDriveProjectStatus(projectId: string): void {
  statuses.delete(projectId)
  listeners.get(projectId)?.forEach((listener) => listener(null))
}

export function subscribeDriveProjectStatus(
  projectId: string,
  listener: DriveProjectStatusListener,
): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<DriveProjectStatusListener>()
  projectListeners.add(listener)
  listeners.set(projectId, projectListeners)
  listener(statuses.get(projectId) ?? null)
  return () => {
    projectListeners.delete(listener)
    if (projectListeners.size === 0) listeners.delete(projectId)
  }
}
