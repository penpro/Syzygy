import type { Awareness } from 'y-protocols/awareness'
import { inspectAwareness } from './presenceModel'

export type PresenceTransportMode = 'local-only' | 'drive-polling' | 'live'

export interface RegisteredProjectPresence {
  projectId: string
  mode: PresenceTransportMode
  awareness: Awareness
}

interface Registration {
  token: symbol
  value: RegisteredProjectPresence
}

const registrations = new Map<string, Registration>()
const listeners = new Map<string, Set<() => void>>()
const stableProjectId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value)

function emit(projectId: string): void {
  listeners.get(projectId)?.forEach((listener) => listener())
}

export function registerProjectPresence(
  projectId: string,
  awareness: Awareness,
  mode: PresenceTransportMode,
): () => void {
  if (!stableProjectId(projectId)) throw new Error('Presence registration requires a stable project ID')
  const token = Symbol(projectId)
  registrations.set(projectId, { token, value: { projectId, awareness, mode } })
  emit(projectId)
  return () => {
    if (registrations.get(projectId)?.token !== token) return
    registrations.delete(projectId)
    emit(projectId)
  }
}

export function getProjectPresence(projectId: string): RegisteredProjectPresence | null {
  return registrations.get(projectId)?.value ?? null
}

export function subscribeProjectPresence(projectId: string, listener: () => void): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<() => void>()
  projectListeners.add(listener)
  listeners.set(projectId, projectListeners)
  return () => {
    projectListeners.delete(listener)
    if (projectListeners.size === 0) listeners.delete(projectId)
  }
}

export function inspectRegisteredProjectPresence(projectId: string) {
  const registration = getProjectPresence(projectId)
  if (!registration) {
    return {
      available: false,
      mode: null,
      healthy: true,
      sessionCount: 0,
      remoteSessionCount: 0,
      invalidRecords: 0,
      truncated: false,
    }
  }
  const inspection = inspectAwareness(registration.awareness)
  return {
    available: true,
    mode: registration.mode,
    healthy: inspection.healthy,
    sessionCount: inspection.participants.length,
    remoteSessionCount: inspection.participants.filter(({ local }) => !local).length,
    invalidRecords: inspection.invalidRecords,
    truncated: inspection.truncated,
  }
}
