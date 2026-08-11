import * as Y from 'yjs'
import {
  collaborationIdentitySignResearchEvent,
  type ProjectResearchEventClaim,
  type ProjectResearchEventKind,
  type ProjectResearchEventProof,
} from '../tauri'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { verifyEd25519DeviceMessage } from './deviceIdentity'

export const PROJECT_RESEARCH_EVENT_ATTESTATION_PREFIX = 'project-research-event-attestation:v1:'
export const MAX_PROJECT_RESEARCH_EVENT_ATTESTATIONS = 2_000
export const MAX_RESEARCH_EVENT_ATTESTATION_SETTINGS_SCAN = 5_000
export const MAX_RESEARCH_EVENT_ATTESTATION_VERIFICATION_CONCURRENCY = 8

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,1023}$/
const KEY_ID_PATTERN = /^ed25519-sha256:[A-Za-z0-9_-]{43}$/
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/
const EVENT_KINDS: readonly ProjectResearchEventKind[] = [
  'scenario',
  'scenario-turn',
  'scenario-vote',
  'scenario-annotation',
  'scenario-label',
  'suggestion',
  'policy-version',
  'adversarial-review',
  'plugin-review',
  'heuristic',
  'scenario-rerun',
]

export interface ProjectResearchEventAttestationRecord {
  schemaVersion: 1
  proof: ProjectResearchEventProof
}

export interface ProjectResearchEventAttestationView {
  storageKey: string
  keyId: string
  participantId: string
  eventKind: ProjectResearchEventKind
  eventId: string
  eventSha256: string
  recordedAtMs: number
}

export interface ProjectResearchEventAttestationInspection {
  healthy: boolean
  attestationCount: number
  attestations: ProjectResearchEventAttestationView[]
  invalidRecords: number
  unavailableRecords: number
  excessRecords: number
}

export interface ProjectResearchEventResolution {
  eventSha256: string
  participantId: string
}

export type ProjectResearchEventResolver = (
  eventKind: ProjectResearchEventKind,
  eventId: string,
) => ProjectResearchEventResolution | null | Promise<ProjectResearchEventResolution | null>

export interface ProjectResearchEventAttestationDependencies {
  sign: (claim: ProjectResearchEventClaim) => Promise<ProjectResearchEventProof>
  now: () => number
  nonce: () => string
}

const DEFAULT_DEPENDENCIES: ProjectResearchEventAttestationDependencies = {
  sign: collaborationIdentitySignResearchEvent,
  now: () => Date.now(),
  nonce: () => {
    const value = new Uint8Array(32)
    globalThis.crypto.getRandomValues(value)
    return encodeBase64Url(value)
  },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function isCanonicalBase64Url(value: unknown, exactBytes: number): value is string {
  if (typeof value !== 'string' || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const decoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    return decoded.byteLength === exactBytes && encodeBase64Url(decoded) === value
  } catch {
    return false
  }
}

function parseClaim(value: unknown): ProjectResearchEventClaim | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'participantId', 'eventKind', 'eventId', 'eventSha256',
    'recordedAtMs', 'attestationNonce',
  ]) || value.schemaVersion !== 1 || typeof value.projectId !== 'string' ||
    !ID_PATTERN.test(value.projectId) || typeof value.participantId !== 'string' ||
    !ID_PATTERN.test(value.participantId) || typeof value.eventKind !== 'string' ||
    !EVENT_KINDS.includes(value.eventKind as ProjectResearchEventKind) ||
    typeof value.eventId !== 'string' || !EVENT_ID_PATTERN.test(value.eventId) ||
    !BASE64URL_32.test(String(value.eventSha256)) ||
    !isCanonicalBase64Url(value.eventSha256, 32) || !Number.isSafeInteger(value.recordedAtMs) ||
    Number(value.recordedAtMs) < 1 || !BASE64URL_32.test(String(value.attestationNonce)) ||
    !isCanonicalBase64Url(value.attestationNonce, 32)) return null
  return value as unknown as ProjectResearchEventClaim
}

export function parseProjectResearchEventAttestation(
  value: unknown,
): ProjectResearchEventAttestationRecord | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'proof']) || value.schemaVersion !== 1 ||
    !isRecord(value.proof) || !exactKeys(value.proof, [
      'schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature',
    ])) return null
  const claim = parseClaim(value.proof.claim)
  if (value.proof.schemaVersion !== 1 || value.proof.algorithm !== 'Ed25519' ||
    typeof value.proof.keyId !== 'string' || !KEY_ID_PATTERN.test(value.proof.keyId) ||
    typeof value.proof.publicKey !== 'string' || !isCanonicalBase64Url(value.proof.publicKey, 32) ||
    typeof value.proof.signature !== 'string' || !BASE64URL_64.test(value.proof.signature) ||
    !isCanonicalBase64Url(value.proof.signature, 64) || !claim) return null
  return {
    schemaVersion: 1,
    proof: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: value.proof.keyId,
      publicKey: value.proof.publicKey,
      claim,
      signature: value.proof.signature,
    },
  }
}

export function canonicalProjectResearchEventClaim(claim: ProjectResearchEventClaim): Uint8Array {
  if (!parseClaim(claim)) throw new Error('Project research event attestation claim is invalid')
  return new TextEncoder().encode([
    'syzygy-project-research-event-v1',
    claim.projectId,
    claim.participantId,
    claim.eventKind,
    claim.eventId,
    claim.eventSha256,
    String(claim.recordedAtMs),
    claim.attestationNonce,
  ].join('\n'))
}

export function projectResearchEventAttestationStorageKey(
  record: ProjectResearchEventAttestationRecord,
): string {
  const { claim } = record.proof
  return `${PROJECT_RESEARCH_EVENT_ATTESTATION_PREFIX}${claim.eventKind}:${claim.eventId}:${record.proof.keyId}:${claim.attestationNonce}`
}

export async function createProjectResearchEventAttestation(
  projectId: string,
  participantId: string,
  eventKind: ProjectResearchEventKind,
  eventId: string,
  eventSha256: string,
  dependencies: ProjectResearchEventAttestationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProjectResearchEventAttestationRecord> {
  const claim: ProjectResearchEventClaim = {
    schemaVersion: 1,
    projectId,
    participantId,
    eventKind,
    eventId,
    eventSha256,
    recordedAtMs: dependencies.now(),
    attestationNonce: dependencies.nonce(),
  }
  if (!parseClaim(claim)) throw new Error('Project research event attestation input is invalid')
  const proof = await dependencies.sign(claim)
  const record = parseProjectResearchEventAttestation({ schemaVersion: 1, proof })
  if (!record || JSON.stringify(record.proof.claim) !== JSON.stringify(claim)) {
    throw new Error('Project research event signer returned a mismatched proof')
  }
  return record
}

async function verifyRecord(
  value: unknown,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  resolveEvent: ProjectResearchEventResolver,
): Promise<'verified-device' | 'invalid' | 'unavailable'> {
  const record = parseProjectResearchEventAttestation(value)
  if (!record || record.proof.claim.projectId !== projectId || !directory.healthy) return 'invalid'
  const device = directory.devices.find(({ keyId }) => keyId === record.proof.keyId)
  if (!device || device.status !== 'registered-device' || device.publicKey !== record.proof.publicKey ||
    !device.participantIds.includes(record.proof.claim.participantId)) return 'invalid'
  let event: ProjectResearchEventResolution | null
  try {
    event = await resolveEvent(record.proof.claim.eventKind, record.proof.claim.eventId)
  } catch {
    return 'unavailable'
  }
  if (!event || event.eventSha256 !== record.proof.claim.eventSha256 ||
    event.participantId !== record.proof.claim.participantId ||
    !isCanonicalBase64Url(event.eventSha256, 32) || !ID_PATTERN.test(event.participantId)) return 'invalid'
  return verifyEd25519DeviceMessage(
    record.proof.keyId,
    record.proof.publicKey,
    record.proof.signature,
    canonicalProjectResearchEventClaim(record.proof.claim),
  )
}

function emptyInspection(
  overrides: Partial<ProjectResearchEventAttestationInspection> = {},
): ProjectResearchEventAttestationInspection {
  return {
    healthy: true,
    attestationCount: 0,
    attestations: [],
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
    ...overrides,
  }
}

export async function inspectProjectResearchEventAttestations(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  resolveEvent: ProjectResearchEventResolver,
): Promise<ProjectResearchEventAttestationInspection> {
  if (!ID_PATTERN.test(projectId) || settings.size > MAX_RESEARCH_EVENT_ATTESTATION_SETTINGS_SCAN) {
    return emptyInspection({ healthy: false, invalidRecords: 1, excessRecords: 1 })
  }
  const candidates = Array.from(settings.entries())
    .filter(([key]) => key.startsWith(PROJECT_RESEARCH_EVENT_ATTESTATION_PREFIX))
    .sort(([left], [right]) => compareStrings(left, right))
  if (candidates.length > MAX_PROJECT_RESEARCH_EVENT_ATTESTATIONS) {
    return emptyInspection({
      healthy: false,
      attestationCount: candidates.length,
      invalidRecords: candidates.length,
      excessRecords: candidates.length - MAX_PROJECT_RESEARCH_EVENT_ATTESTATIONS,
    })
  }
  const attestations: ProjectResearchEventAttestationView[] = []
  let invalidRecords = 0
  let unavailableRecords = 0
  for (let start = 0; start < candidates.length; start += MAX_RESEARCH_EVENT_ATTESTATION_VERIFICATION_CONCURRENCY) {
    const batch = candidates.slice(start, start + MAX_RESEARCH_EVENT_ATTESTATION_VERIFICATION_CONCURRENCY)
    const verified = await Promise.all(batch.map(async ([storageKey, value]) => ({
      storageKey,
      record: parseProjectResearchEventAttestation(value),
      status: await verifyRecord(value, projectId, directory, resolveEvent),
    })))
    for (const candidate of verified) {
      if (candidate.status === 'unavailable') unavailableRecords += 1
      else if (!candidate.record || candidate.status !== 'verified-device' ||
        projectResearchEventAttestationStorageKey(candidate.record) !== candidate.storageKey) invalidRecords += 1
      else {
        const { claim } = candidate.record.proof
        attestations.push({
          storageKey: candidate.storageKey,
          keyId: candidate.record.proof.keyId,
          participantId: claim.participantId,
          eventKind: claim.eventKind,
          eventId: claim.eventId,
          eventSha256: claim.eventSha256,
          recordedAtMs: claim.recordedAtMs,
        })
      }
    }
  }
  attestations.sort((left, right) =>
    compareStrings(left.eventKind, right.eventKind) || compareStrings(left.eventId, right.eventId) ||
    compareStrings(left.keyId, right.keyId) || compareStrings(left.storageKey, right.storageKey))
  return {
    healthy: invalidRecords === 0 && unavailableRecords === 0,
    attestationCount: candidates.length,
    attestations,
    invalidRecords,
    unavailableRecords,
    excessRecords: 0,
  }
}

function canonicalRecord(record: ProjectResearchEventAttestationRecord): ProjectResearchEventAttestationRecord {
  return {
    schemaVersion: 1,
    proof: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: record.proof.keyId,
      publicKey: record.proof.publicKey,
      claim: { ...record.proof.claim },
      signature: record.proof.signature,
    },
  }
}

export async function publishProjectResearchEventAttestation(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  resolveEvent: ProjectResearchEventResolver,
  value: unknown,
): Promise<ProjectResearchEventAttestationInspection> {
  const record = parseProjectResearchEventAttestation(value)
  if (!record || await verifyRecord(record, projectId, directory, resolveEvent) !== 'verified-device') {
    throw new Error('Project research event attestation proof is invalid')
  }
  const before = await inspectProjectResearchEventAttestations(
    settings, projectId, directory, resolveEvent,
  )
  if (!before.healthy) throw new Error('Project research event attestation history is not safe to update')
  const sameDeviceEvent = before.attestations.find((existing) =>
    existing.keyId === record.proof.keyId &&
    existing.eventKind === record.proof.claim.eventKind &&
    existing.eventId === record.proof.claim.eventId)
  if (sameDeviceEvent) {
    if (sameDeviceEvent.participantId === record.proof.claim.participantId &&
      sameDeviceEvent.eventSha256 === record.proof.claim.eventSha256) return before
    throw new Error('Project research event attestation device-event identity collided')
  }
  const storageKey = projectResearchEventAttestationStorageKey(record)
  const canonical = canonicalRecord(record)
  const stored = settings.get(storageKey)
  if (stored !== undefined) {
    const existing = parseProjectResearchEventAttestation(stored)
    if (existing && JSON.stringify(existing) === JSON.stringify(canonical)) return before
    throw new Error('Project research event attestation identity collided')
  }
  if (before.attestationCount >= MAX_PROJECT_RESEARCH_EVENT_ATTESTATIONS) {
    throw new Error('Project research event attestation limit reached')
  }
  const operation = () => settings.set(storageKey, canonical)
  if (settings.doc) settings.doc.transact(operation, 'syzygy-project-research-event-attestation')
  else operation()
  return inspectProjectResearchEventAttestations(settings, projectId, directory, resolveEvent)
}
