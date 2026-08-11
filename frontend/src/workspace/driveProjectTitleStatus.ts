import type { DriveProjectTitleState } from '../tauri'

type DriveProjectTitleListener = (state: DriveProjectTitleState | null) => void

const states = new Map<string, { source: object; state: DriveProjectTitleState }>()
const listeners = new Map<string, Set<DriveProjectTitleListener>>()

export function publishDriveProjectTitleState(
  projectId: string,
  source: object,
  state: DriveProjectTitleState,
): void {
  states.set(projectId, { source, state })
  listeners.get(projectId)?.forEach((listener) => listener(state))
}

export function clearDriveProjectTitleState(projectId: string, source: object): void {
  if (states.get(projectId)?.source !== source) return
  states.delete(projectId)
  listeners.get(projectId)?.forEach((listener) => listener(null))
}

export function currentDriveProjectTitleState(projectId: string): DriveProjectTitleState | null {
  return states.get(projectId)?.state ?? null
}

export function subscribeDriveProjectTitleState(
  projectId: string,
  listener: DriveProjectTitleListener,
): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<DriveProjectTitleListener>()
  projectListeners.add(listener)
  listeners.set(projectId, projectListeners)
  listener(states.get(projectId)?.state ?? null)
  return () => {
    projectListeners.delete(listener)
    if (projectListeners.size === 0) listeners.delete(projectId)
  }
}
