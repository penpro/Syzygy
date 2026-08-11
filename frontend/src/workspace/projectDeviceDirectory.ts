import * as Y from 'yjs'
import type { ProjectDeviceRegistrationProof } from '../tauri'
import {
  parseProjectDeviceRegistrationProof,
  projectDeviceRegistrationStorageKey,
  verifyProjectDeviceRegistrationProof,
} from './deviceIdentity'

export const PROJECT_DEVICE_REGISTRATION_PREFIX = 'collaboration-device-registration:v1:'
export const MAX_PROJECT_DEVICE_REGISTRATIONS = 200
export const MAX_PROJECT_SETTINGS_SCAN = 1_000
export const MAX_REGISTRATION_VERIFICATION_CONCURRENCY = 8

export interface ProjectDeviceRegistrationView {
  keyId: string
  publicKey: string
  participantId: string
}

export interface ProjectDeviceDirectoryDevice {
  keyId: string
  publicKey: string
  fingerprint: string
  participantIds: string[]
  registrationCount: number
  status: 'registered-device' | 'participant-claim-conflict'
}

export interface ProjectDeviceDirectoryInspection {
  healthy: boolean
  registrationCount: number
  verifiedRegistrations: ProjectDeviceRegistrationView[]
  devices: ProjectDeviceDirectoryDevice[]
  conflictingDevices: number
  invalidRecords: number
  unavailableRecords: number
  excessRecords: number
}

interface RegistrationCandidate {
  storageKey: string
  value: unknown
}

function emptyInspection(overrides: Partial<ProjectDeviceDirectoryInspection> = {}): ProjectDeviceDirectoryInspection {
  return {
    healthy: true,
    registrationCount: 0,
    verifiedRegistrations: [],
    devices: [],
    conflictingDevices: 0,
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
    ...overrides,
  }
}

function registrationCandidates(settings: Y.Map<unknown>): RegistrationCandidate[] | null {
  if (settings.size > MAX_PROJECT_SETTINGS_SCAN) return null
  return Array.from(settings.entries())
    .filter(([key]) => key.startsWith(PROJECT_DEVICE_REGISTRATION_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([storageKey, value]) => ({ storageKey, value }))
}

async function verifyCandidates(
  candidates: RegistrationCandidate[],
  projectId: string,
): Promise<{ verified: ProjectDeviceRegistrationProof[]; invalidRecords: number; unavailableRecords: number }> {
  const verified: ProjectDeviceRegistrationProof[] = []
  let invalidRecords = 0
  let unavailableRecords = 0
  for (let start = 0; start < candidates.length; start += MAX_REGISTRATION_VERIFICATION_CONCURRENCY) {
    const batch = candidates.slice(start, start + MAX_REGISTRATION_VERIFICATION_CONCURRENCY)
    const results = await Promise.all(batch.map(async ({ storageKey, value }) => {
      const proof = parseProjectDeviceRegistrationProof(value)
      if (!proof || projectDeviceRegistrationStorageKey(proof) !== storageKey) {
        return { status: 'invalid' as const, proof: null }
      }
      return { status: await verifyProjectDeviceRegistrationProof(proof, projectId), proof }
    }))
    for (const result of results) {
      if (result.status === 'verified-device' && result.proof) verified.push(result.proof)
      else if (result.status === 'unavailable') unavailableRecords += 1
      else invalidRecords += 1
    }
  }
  return { verified, invalidRecords, unavailableRecords }
}

export async function inspectProjectDeviceDirectory(
  settings: Y.Map<unknown>,
  projectId: string,
): Promise<ProjectDeviceDirectoryInspection> {
  const candidates = registrationCandidates(settings)
  if (!candidates) {
    return emptyInspection({ healthy: false, invalidRecords: 1, excessRecords: 1 })
  }
  if (candidates.length > MAX_PROJECT_DEVICE_REGISTRATIONS) {
    return emptyInspection({
      healthy: false,
      registrationCount: candidates.length,
      invalidRecords: candidates.length,
      excessRecords: candidates.length - MAX_PROJECT_DEVICE_REGISTRATIONS,
    })
  }
  const { verified, invalidRecords, unavailableRecords } = await verifyCandidates(candidates, projectId)
  const grouped = new Map<string, ProjectDeviceRegistrationProof[]>()
  for (const proof of verified) {
    const registrations = grouped.get(proof.keyId) ?? []
    registrations.push(proof)
    grouped.set(proof.keyId, registrations)
  }
  const devices = Array.from(grouped.entries()).map(([keyId, registrations]) => {
    const participantIds = Array.from(new Set(registrations.map(({ claim }) => claim.participantId))).sort()
    const publicKeys = new Set(registrations.map(({ publicKey }) => publicKey))
    const conflict = participantIds.length > 1 || publicKeys.size > 1
    return {
      keyId,
      publicKey: registrations[0].publicKey,
      fingerprint: keyId.replace(/^ed25519-sha256:/, ''),
      participantIds,
      registrationCount: registrations.length,
      status: conflict ? 'participant-claim-conflict' as const : 'registered-device' as const,
    }
  }).sort((left, right) => left.keyId.localeCompare(right.keyId))
  const verifiedRegistrations = verified.map((proof) => ({
    keyId: proof.keyId,
    publicKey: proof.publicKey,
    participantId: proof.claim.participantId,
  })).sort((left, right) =>
    left.keyId.localeCompare(right.keyId) || left.participantId.localeCompare(right.participantId))
  return {
    healthy: invalidRecords === 0 && unavailableRecords === 0,
    registrationCount: candidates.length,
    verifiedRegistrations,
    devices,
    conflictingDevices: devices.filter(({ status }) => status === 'participant-claim-conflict').length,
    invalidRecords,
    unavailableRecords,
    excessRecords: 0,
  }
}

function canonicalProof(proof: ProjectDeviceRegistrationProof): ProjectDeviceRegistrationProof {
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: proof.keyId,
    publicKey: proof.publicKey,
    claim: {
      schemaVersion: 1,
      projectId: proof.claim.projectId,
      participantId: proof.claim.participantId,
    },
    signature: proof.signature,
  }
}

export async function publishProjectDeviceRegistration(
  settings: Y.Map<unknown>,
  projectId: string,
  value: unknown,
): Promise<ProjectDeviceDirectoryInspection> {
  const proof = parseProjectDeviceRegistrationProof(value)
  if (!proof || await verifyProjectDeviceRegistrationProof(proof, projectId) !== 'verified-device') {
    throw new Error('Project device registration proof is invalid')
  }
  const before = await inspectProjectDeviceDirectory(settings, projectId)
  if (!before.healthy) throw new Error('Project device directory is not safe to update')
  const storageKey = projectDeviceRegistrationStorageKey(proof)
  const stored = settings.get(storageKey)
  const canonical = canonicalProof(proof)
  if (stored !== undefined) {
    const existing = parseProjectDeviceRegistrationProof(stored)
    if (existing && JSON.stringify(existing) === JSON.stringify(canonical)) return before
    throw new Error('Project device registration identity collided')
  }
  if (before.registrationCount >= MAX_PROJECT_DEVICE_REGISTRATIONS) {
    throw new Error('Project device directory limit reached')
  }
  const operation = () => settings.set(storageKey, canonical)
  if (settings.doc) settings.doc.transact(operation, 'syzygy-project-device-registration')
  else operation()
  return inspectProjectDeviceDirectory(settings, projectId)
}
