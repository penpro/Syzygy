import * as Y from 'yjs'
import type {
  ProjectRelayAdminDecisionClaim,
  ProjectRelayAdminDecisionProof,
} from '../tauri'
import { collaborationIdentitySignRelayAdminDecision } from '../tauri'
import {
  canonicalRelayRemoteAdminAction,
  parseRelayRemoteAdminAction,
  relayRemoteAdminActionSha256,
  type RelayRemoteAdminAction,
  type RelayRemoteAdminResult,
} from './relayRemoteAdmin'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { verifyEd25519DeviceMessage } from './deviceIdentity'

export const PROJECT_RELAY_ADMIN_DECISION_PREFIX = 'collaboration-relay-admin-decision:v1:'
export const MAX_PROJECT_RELAY_ADMIN_DECISIONS = 500
export const MAX_RELAY_ADMIN_SETTINGS_SCAN = 1_500
export const MAX_RELAY_ADMIN_DECISION_VERIFICATION_CONCURRENCY = 8

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/
const ROOM_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const MEMBER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const KEY_ID_PATTERN = /^ed25519-sha256:[A-Za-z0-9_-]{43}$/
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/

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

export interface ProjectRelayAdminDecisionRecord {
  schemaVersion: 1
  proof: ProjectRelayAdminDecisionProof
  action: RelayRemoteAdminAction
}

export interface ProjectRelayAdminDecisionView {
  storageKey: string
  proof: ProjectRelayAdminDecisionProof
  action: RelayRemoteAdminAction
  participantIds: string[]
}

export interface ProjectRelayAdminDecisionInspection {
  healthy: boolean
  decisionCount: number
  decisions: ProjectRelayAdminDecisionView[]
  conflictingRevisions: number
  invalidRecords: number
  unavailableRecords: number
  excessRecords: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

function parseClaim(value: unknown): ProjectRelayAdminDecisionClaim | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'roomId', 'administratorMemberId', 'expectedRevision',
    'resultingRevision', 'affectedMemberId', 'actionSha256', 'recordedAtMs', 'decisionNonce',
  ]) || value.schemaVersion !== 1 || typeof value.projectId !== 'string' || !ID_PATTERN.test(value.projectId) ||
    typeof value.roomId !== 'string' || !ROOM_PATTERN.test(value.roomId) ||
    typeof value.administratorMemberId !== 'string' || !MEMBER_PATTERN.test(value.administratorMemberId) ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 ||
    !Number.isSafeInteger(value.resultingRevision) ||
    Number(value.resultingRevision) !== Number(value.expectedRevision) + 1 ||
    typeof value.affectedMemberId !== 'string' || !MEMBER_PATTERN.test(value.affectedMemberId) ||
    typeof value.actionSha256 !== 'string' || !BASE64URL_32.test(value.actionSha256) ||
    !isCanonicalBase64Url(value.actionSha256, 32) ||
    !Number.isSafeInteger(value.recordedAtMs) || Number(value.recordedAtMs) < 1 ||
    typeof value.decisionNonce !== 'string' || !BASE64URL_32.test(value.decisionNonce) ||
    !isCanonicalBase64Url(value.decisionNonce, 32)) return null
  return value as unknown as ProjectRelayAdminDecisionClaim
}

export function parseProjectRelayAdminDecisionRecord(value: unknown): ProjectRelayAdminDecisionRecord | null {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'proof', 'action']) ||
    value.schemaVersion !== 1 || !isRecord(value.proof) || !exactKeys(value.proof, [
      'schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature',
    ])) return null
  const claim = parseClaim(value.proof.claim)
  const action = parseRelayRemoteAdminAction(value.action)
  if (value.proof.schemaVersion !== 1 || value.proof.algorithm !== 'Ed25519' ||
    typeof value.proof.keyId !== 'string' || !KEY_ID_PATTERN.test(value.proof.keyId) ||
    typeof value.proof.publicKey !== 'string' || !BASE64URL_32.test(value.proof.publicKey) ||
    !isCanonicalBase64Url(value.proof.publicKey, 32) ||
    typeof value.proof.signature !== 'string' || !BASE64URL_64.test(value.proof.signature) ||
    !isCanonicalBase64Url(value.proof.signature, 64) ||
    !claim || !action || action.kind === 'status') return null
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
    action,
  }
}

export function canonicalProjectRelayAdminDecisionClaim(
  claim: ProjectRelayAdminDecisionClaim,
): Uint8Array {
  if (!parseClaim(claim)) throw new Error('Project relay administrator decision claim is invalid')
  return new TextEncoder().encode([
    'syzygy-project-relay-admin-decision-v1',
    claim.projectId,
    claim.roomId,
    claim.administratorMemberId,
    String(claim.expectedRevision),
    String(claim.resultingRevision),
    claim.affectedMemberId,
    claim.actionSha256,
    String(claim.recordedAtMs),
    claim.decisionNonce,
  ].join('\n'))
}

export function projectRelayAdminDecisionStorageKey(record: ProjectRelayAdminDecisionRecord): string {
  const { claim } = record.proof
  return `${PROJECT_RELAY_ADMIN_DECISION_PREFIX}${claim.roomId}:${claim.resultingRevision}:${record.proof.keyId}:${claim.decisionNonce}`
}

export interface ProjectRelayAdminDecisionDependencies {
  sign: (claim: ProjectRelayAdminDecisionClaim) => Promise<ProjectRelayAdminDecisionProof>
  now: () => number
  nonce: () => string
}

const DEFAULT_DECISION_DEPENDENCIES: ProjectRelayAdminDecisionDependencies = {
  sign: collaborationIdentitySignRelayAdminDecision,
  now: () => Date.now(),
  nonce: () => {
    const value = new Uint8Array(32)
    globalThis.crypto.getRandomValues(value)
    return encodeBase64Url(value)
  },
}

/**
 * Build a durable, installation-signed statement about a mutation that the relay already accepted.
 * The relay remains the enforcement authority; this proof is not a relay-signed receipt or a human identity.
 */
export async function createProjectRelayAdminDecisionRecord(
  projectId: string,
  roomId: string,
  administratorMemberId: string,
  expectedRevision: number,
  action: RelayRemoteAdminAction,
  result: RelayRemoteAdminResult,
  dependencies: ProjectRelayAdminDecisionDependencies = DEFAULT_DECISION_DEPENDENCIES,
): Promise<ProjectRelayAdminDecisionRecord> {
  if (!ID_PATTERN.test(projectId) || !ROOM_PATTERN.test(roomId) ||
    !MEMBER_PATTERN.test(administratorMemberId) || !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 || action.kind === 'status') {
    throw new Error('Project relay administrator decision input is invalid')
  }
  if (result.room.projectId !== projectId || result.room.roomId !== roomId ||
    result.room.registryRevision !== expectedRevision + 1) {
    throw new Error('Relay result does not prove the expected project revision transition')
  }
  let affectedMemberId: string
  if (action.kind === 'issue') {
    const affected = result.credential && result.room.members.find(
      ({ memberId }) => memberId === result.credential!.memberId,
    )
    if (!result.credential || result.credential.roomId !== roomId ||
      result.credential.registryRevision !== result.room.registryRevision || !affected ||
      affected.revokedAtMs !== null || affected.role !== result.credential.role ||
      affected.capabilityGeneration !== result.credential.capabilityGeneration) {
      throw new Error('Relay issue result does not identify the affected member')
    }
    affectedMemberId = result.credential.memberId
  } else if (action.kind === 'rotate') {
    const affected = result.room.members.find(({ memberId }) => memberId === action.memberId)
    if (!result.credential || result.credential.roomId !== roomId ||
      result.credential.memberId !== action.memberId ||
      result.credential.registryRevision !== result.room.registryRevision || !affected ||
      affected.revokedAtMs !== null || affected.role !== result.credential.role ||
      affected.capabilityGeneration !== result.credential.capabilityGeneration) {
      throw new Error('Relay rotation result does not match the affected member')
    }
    affectedMemberId = action.memberId
  } else {
    const affected = result.room.members.find(({ memberId }) => memberId === action.memberId)
    if (result.credential !== null || !affected?.revokedAtMs) {
      throw new Error('Relay revocation result does not match the affected member')
    }
    affectedMemberId = action.memberId
  }
  const recordedAtMs = dependencies.now()
  const decisionNonce = dependencies.nonce()
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 1 ||
    !BASE64URL_32.test(decisionNonce) || !isCanonicalBase64Url(decisionNonce, 32)) {
    throw new Error('Project relay administrator decision freshness is invalid')
  }
  const claim: ProjectRelayAdminDecisionClaim = {
    schemaVersion: 1,
    projectId,
    roomId,
    administratorMemberId,
    expectedRevision,
    resultingRevision: result.room.registryRevision,
    affectedMemberId,
    actionSha256: await relayRemoteAdminActionSha256(action),
    recordedAtMs,
    decisionNonce,
  }
  const proof = await dependencies.sign(claim)
  const record = parseProjectRelayAdminDecisionRecord({ schemaVersion: 1, proof, action })
  if (!record || JSON.stringify(record.proof.claim) !== JSON.stringify(claim)) {
    throw new Error('Project relay administrator decision signer returned a mismatched proof')
  }
  return record
}

async function verifyRecord(
  value: unknown,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
): Promise<'verified-device' | 'invalid' | 'unavailable'> {
  const record = parseProjectRelayAdminDecisionRecord(value)
  if (!record || record.proof.claim.projectId !== projectId || !directory.healthy) return 'invalid'
  if (await relayRemoteAdminActionSha256(record.action) !== record.proof.claim.actionSha256) return 'invalid'
  const device = directory.devices.find(({ keyId }) => keyId === record.proof.keyId)
  if (!device || device.status !== 'registered-device' || device.publicKey !== record.proof.publicKey) return 'invalid'
  return verifyEd25519DeviceMessage(
    record.proof.keyId,
    record.proof.publicKey,
    record.proof.signature,
    canonicalProjectRelayAdminDecisionClaim(record.proof.claim),
  )
}

function emptyInspection(
  overrides: Partial<ProjectRelayAdminDecisionInspection> = {},
): ProjectRelayAdminDecisionInspection {
  return {
    healthy: true,
    decisionCount: 0,
    decisions: [],
    conflictingRevisions: 0,
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
    ...overrides,
  }
}

export async function inspectProjectRelayAdminDecisions(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
): Promise<ProjectRelayAdminDecisionInspection> {
  if (!ID_PATTERN.test(projectId) || settings.size > MAX_RELAY_ADMIN_SETTINGS_SCAN) {
    return emptyInspection({ healthy: false, invalidRecords: 1, excessRecords: 1 })
  }
  const candidates = Array.from(settings.entries())
    .filter(([key]) => key.startsWith(PROJECT_RELAY_ADMIN_DECISION_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
  if (candidates.length > MAX_PROJECT_RELAY_ADMIN_DECISIONS) {
    return emptyInspection({
      healthy: false,
      decisionCount: candidates.length,
      invalidRecords: candidates.length,
      excessRecords: candidates.length - MAX_PROJECT_RELAY_ADMIN_DECISIONS,
    })
  }
  const decisions: ProjectRelayAdminDecisionView[] = []
  let invalidRecords = 0
  let unavailableRecords = 0
  for (let start = 0; start < candidates.length; start += MAX_RELAY_ADMIN_DECISION_VERIFICATION_CONCURRENCY) {
    const batch = candidates.slice(start, start + MAX_RELAY_ADMIN_DECISION_VERIFICATION_CONCURRENCY)
    const verified = await Promise.all(batch.map(async ([storageKey, value]) => ({
      storageKey,
      record: parseProjectRelayAdminDecisionRecord(value),
      status: await verifyRecord(value, projectId, directory),
    })))
    for (const candidate of verified) {
      if (candidate.status === 'unavailable') unavailableRecords += 1
      else if (!candidate.record || candidate.status !== 'verified-device' ||
        projectRelayAdminDecisionStorageKey(candidate.record) !== candidate.storageKey) invalidRecords += 1
      else {
        const device = directory.devices.find(({ keyId }) => keyId === candidate.record!.proof.keyId)!
        decisions.push({
          storageKey: candidate.storageKey,
          proof: candidate.record.proof,
          action: candidate.record.action,
          participantIds: [...device.participantIds],
        })
      }
    }
  }
  decisions.sort((left, right) =>
    left.proof.claim.roomId.localeCompare(right.proof.claim.roomId) ||
    left.proof.claim.resultingRevision - right.proof.claim.resultingRevision ||
    left.storageKey.localeCompare(right.storageKey))
  const revisions = new Map<string, Set<string>>()
  for (const decision of decisions) {
    const key = `${decision.proof.claim.roomId}:${decision.proof.claim.resultingRevision}`
    const actions = revisions.get(key) ?? new Set<string>()
    actions.add(`${decision.proof.claim.actionSha256}:${decision.proof.claim.affectedMemberId}`)
    revisions.set(key, actions)
  }
  const conflictingRevisions = Array.from(revisions.values()).filter((actions) => actions.size > 1).length
  return {
    healthy: invalidRecords === 0 && unavailableRecords === 0 && conflictingRevisions === 0,
    decisionCount: candidates.length,
    decisions,
    conflictingRevisions,
    invalidRecords,
    unavailableRecords,
    excessRecords: 0,
  }
}

function canonicalRecord(record: ProjectRelayAdminDecisionRecord): ProjectRelayAdminDecisionRecord {
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
    action: parseRelayRemoteAdminAction(record.action)!,
  }
}

export async function publishProjectRelayAdminDecision(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  value: unknown,
): Promise<ProjectRelayAdminDecisionInspection> {
  const record = parseProjectRelayAdminDecisionRecord(value)
  if (!record || await verifyRecord(record, projectId, directory) !== 'verified-device') {
    throw new Error('Project relay administrator decision proof is invalid')
  }
  const before = await inspectProjectRelayAdminDecisions(settings, projectId, directory)
  if (!before.healthy) throw new Error('Project relay administrator decision history is not safe to update')
  const sameRevision = before.decisions.find((decision) =>
    decision.proof.claim.roomId === record.proof.claim.roomId &&
    decision.proof.claim.resultingRevision === record.proof.claim.resultingRevision)
  if (sameRevision) {
    const same = sameRevision.proof.claim.actionSha256 === record.proof.claim.actionSha256 &&
      sameRevision.proof.claim.affectedMemberId === record.proof.claim.affectedMemberId
    if (!same) throw new Error('Project relay administrator decision revision conflicted')
  }
  const storageKey = projectRelayAdminDecisionStorageKey(record)
  const canonical = canonicalRecord(record)
  const stored = settings.get(storageKey)
  if (stored !== undefined) {
    const existing = parseProjectRelayAdminDecisionRecord(stored)
    if (existing && JSON.stringify(existing) === JSON.stringify(canonical)) return before
    throw new Error('Project relay administrator decision identity collided')
  }
  if (before.decisionCount >= MAX_PROJECT_RELAY_ADMIN_DECISIONS) {
    throw new Error('Project relay administrator decision limit reached')
  }
  const operation = () => settings.set(storageKey, canonical)
  if (settings.doc) settings.doc.transact(operation, 'syzygy-project-relay-admin-decision')
  else operation()
  return inspectProjectRelayAdminDecisions(settings, projectId, directory)
}

export function describeRelayAdminDecisionAction(action: RelayRemoteAdminAction): string {
  if (action.kind === 'issue') return `issued ${action.role} access`
  if (action.kind === 'rotate') return `rotated member ${action.memberId.slice(0, 12)}…`
  if (action.kind === 'revoke') return `revoked member ${action.memberId.slice(0, 12)}…`
  return 'inspected relay status'
}
