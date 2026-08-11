import type { Awareness } from 'y-protocols/awareness'
import type { DevicePresenceProof } from '../tauri'
import { parseDevicePresenceProof } from './deviceIdentity'

export const PRESENCE_SCHEMA_VERSION = 2 as const
export const LEGACY_PRESENCE_SCHEMA_VERSION = 1 as const
export const MAX_PRESENCE_STATES = 200

export interface PresenceParticipant {
  clientId: number
  participantId: string
  displayName: string
  focusing: boolean
  local: boolean
  deviceProof: DevicePresenceProof | null
}

export interface PresenceInspection {
  healthy: boolean
  totalRecords: number
  invalidRecords: number
  truncated: boolean
  participants: PresenceParticipant[]
}

const stableId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value)

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const displayName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value)

function readParticipant(clientId: number, state: unknown, localClientId: number): PresenceParticipant | null {
  if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId > 0xffff_ffff || !record(state) ||
    !displayName(state.name) || typeof state.focusing !== 'boolean' || !record(state.awarenessData) ||
    !record(state.awarenessData.syzygy)) return null
  const identity = state.awarenessData.syzygy
  if (!stableId(identity.participantId)) return null
  let deviceProof: DevicePresenceProof | null = null
  if (identity.schemaVersion === LEGACY_PRESENCE_SCHEMA_VERSION) {
    if (Object.keys(identity).sort().join(',') !== 'participantId,schemaVersion') return null
  } else if (identity.schemaVersion === PRESENCE_SCHEMA_VERSION) {
    if (Object.keys(identity).sort().join(',') !== 'deviceProof,participantId,schemaVersion') return null
    deviceProof = parseDevicePresenceProof(identity.deviceProof)
    if (!deviceProof) return null
  } else return null
  return {
    clientId,
    participantId: identity.participantId,
    displayName: state.name.trim(),
    focusing: state.focusing,
    local: clientId === localClientId,
    deviceProof,
  }
}

export function inspectPresenceStates(
  states: Map<number, unknown>,
  localClientId: number,
): PresenceInspection {
  const ordered = Array.from(states.entries()).sort(([left], [right]) => left - right)
  const inspected = ordered.slice(0, MAX_PRESENCE_STATES)
  const participants: PresenceParticipant[] = []
  let invalidRecords = Math.max(0, ordered.length - inspected.length)
  for (const [clientId, state] of inspected) {
    const participant = readParticipant(clientId, state, localClientId)
    if (participant) participants.push(participant)
    else invalidRecords += 1
  }
  participants.sort((left, right) =>
    Number(right.local) - Number(left.local) ||
    left.displayName.localeCompare(right.displayName) ||
    left.clientId - right.clientId)
  return {
    healthy: invalidRecords === 0,
    totalRecords: ordered.length,
    invalidRecords,
    truncated: ordered.length > MAX_PRESENCE_STATES,
    participants,
  }
}

export function inspectAwareness(awareness: Awareness): PresenceInspection {
  return inspectPresenceStates(awareness.getStates() as Map<number, unknown>, awareness.doc.clientID)
}
