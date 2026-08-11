import * as Y from 'yjs'
import type {
  ProjectRelayAdminApprovalClaim,
  ProjectRelayAdminApprovalProof,
} from '../tauri'
import { collaborationIdentitySignRelayAdminApproval } from '../tauri'
import {
  parseRelayRemoteAdminAction,
  relayRemoteAdminActionSha256,
  type RelayRemoteAdminAction,
} from './relayRemoteAdmin'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { verifyEd25519DeviceMessage } from './deviceIdentity'

export const PROJECT_RELAY_ADMIN_APPROVAL_PREFIX = 'collaboration-relay-admin-approval:v1:'
export const MAX_PROJECT_RELAY_ADMIN_APPROVALS = 500
export const MAX_RELAY_ADMIN_APPROVAL_SETTINGS_SCAN = 2_000
export const MAX_RELAY_ADMIN_APPROVAL_VERIFICATION_CONCURRENCY = 8
export const MIN_RELAY_ADMIN_APPROVAL_LIFETIME_MS = 5 * 60 * 1_000
export const MAX_RELAY_ADMIN_APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_RELAY_ADMIN_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1_000

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/
const ROOM_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const KEY_ID_PATTERN = /^ed25519-sha256:[A-Za-z0-9_-]{43}$/
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/

export interface ProjectRelayAdminApprovalRecord {
  schemaVersion: 1
  proof: ProjectRelayAdminApprovalProof
  action: RelayRemoteAdminAction
}

export interface ProjectRelayAdminApprovalView {
  storageKey: string
  proof: ProjectRelayAdminApprovalProof
  action: RelayRemoteAdminAction
  participantIds: string[]
  state: 'active' | 'expired' | 'signer-conflict'
}

export interface ProjectRelayAdminApprovalIntent {
  roomId: string
  expectedRevision: number
  actionSha256: string
  action: RelayRemoteAdminAction
  activeSignerKeyIds: string[]
  activeParticipantIds: string[]
  approvalCount: number
}

export interface ProjectRelayAdminApprovalInspection {
  healthy: boolean
  approvalCount: number
  approvals: ProjectRelayAdminApprovalView[]
  intents: ProjectRelayAdminApprovalIntent[]
  conflictingSigners: number
  expiredApprovals: number
  invalidRecords: number
  unavailableRecords: number
  excessRecords: number
}

export interface ProjectRelayAdminApprovalDependencies {
  sign: (claim: ProjectRelayAdminApprovalClaim) => Promise<ProjectRelayAdminApprovalProof>
  now: () => number
  nonce: () => string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

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

function parseClaim(value: unknown): ProjectRelayAdminApprovalClaim | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'roomId', 'expectedRevision', 'actionSha256',
    'approvedAtMs', 'expiresAtMs', 'approvalNonce',
  ]) || value.schemaVersion !== 1 || typeof value.projectId !== 'string' ||
    !ID_PATTERN.test(value.projectId) || typeof value.roomId !== 'string' ||
    !ROOM_PATTERN.test(value.roomId) || !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 1 || typeof value.actionSha256 !== 'string' ||
    !BASE64URL_32.test(value.actionSha256) || !isCanonicalBase64Url(value.actionSha256, 32) ||
    !Number.isSafeInteger(value.approvedAtMs) || Number(value.approvedAtMs) < 1 ||
    !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= Number(value.approvedAtMs) ||
    Number(value.expiresAtMs) - Number(value.approvedAtMs) > MAX_RELAY_ADMIN_APPROVAL_LIFETIME_MS ||
    typeof value.approvalNonce !== 'string' || !BASE64URL_32.test(value.approvalNonce) ||
    !isCanonicalBase64Url(value.approvalNonce, 32)) return null
  return value as unknown as ProjectRelayAdminApprovalClaim
}

export function parseProjectRelayAdminApprovalRecord(
  value: unknown,
): ProjectRelayAdminApprovalRecord | null {
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
    !isCanonicalBase64Url(value.proof.signature, 64) || !claim || !action || action.kind === 'status') return null
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

export function canonicalProjectRelayAdminApprovalClaim(
  claim: ProjectRelayAdminApprovalClaim,
): Uint8Array {
  if (!parseClaim(claim)) throw new Error('Project relay administrator approval claim is invalid')
  return new TextEncoder().encode([
    'syzygy-project-relay-admin-approval-v1',
    claim.projectId,
    claim.roomId,
    String(claim.expectedRevision),
    claim.actionSha256,
    String(claim.approvedAtMs),
    String(claim.expiresAtMs),
    claim.approvalNonce,
  ].join('\n'))
}

export function projectRelayAdminApprovalStorageKey(
  record: ProjectRelayAdminApprovalRecord,
): string {
  const { claim } = record.proof
  return PROJECT_RELAY_ADMIN_APPROVAL_PREFIX + claim.roomId + ':' + claim.expectedRevision + ':' +
    claim.actionSha256 + ':' + record.proof.keyId + ':' + claim.approvalNonce
}

const DEFAULT_APPROVAL_DEPENDENCIES: ProjectRelayAdminApprovalDependencies = {
  sign: collaborationIdentitySignRelayAdminApproval,
  now: () => Date.now(),
  nonce: () => {
    const value = new Uint8Array(32)
    globalThis.crypto.getRandomValues(value)
    return encodeBase64Url(value)
  },
}

/**
 * Build one durable project-device statement approving an exact relay mutation at one exact
 * registry revision. The record is only a prerequisite: it does not grant or constrain relay
 * authority until the relay host installs a policy and the relay verifies a quorum bundle.
 */
export async function createProjectRelayAdminApprovalRecord(
  projectId: string,
  roomId: string,
  expectedRevision: number,
  action: RelayRemoteAdminAction,
  lifetimeMs = DEFAULT_RELAY_ADMIN_APPROVAL_LIFETIME_MS,
  dependencies: ProjectRelayAdminApprovalDependencies = DEFAULT_APPROVAL_DEPENDENCIES,
): Promise<ProjectRelayAdminApprovalRecord> {
  if (!ID_PATTERN.test(projectId) || !ROOM_PATTERN.test(roomId) ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || action.kind === 'status' ||
    !Number.isSafeInteger(lifetimeMs) || lifetimeMs < MIN_RELAY_ADMIN_APPROVAL_LIFETIME_MS ||
    lifetimeMs > MAX_RELAY_ADMIN_APPROVAL_LIFETIME_MS) {
    throw new Error('Project relay administrator approval input is invalid')
  }
  const approvedAtMs = dependencies.now()
  const expiresAtMs = approvedAtMs + lifetimeMs
  const approvalNonce = dependencies.nonce()
  if (!Number.isSafeInteger(approvedAtMs) || approvedAtMs < 1 || !Number.isSafeInteger(expiresAtMs) ||
    !BASE64URL_32.test(approvalNonce) || !isCanonicalBase64Url(approvalNonce, 32)) {
    throw new Error('Project relay administrator approval freshness is invalid')
  }
  const claim: ProjectRelayAdminApprovalClaim = {
    schemaVersion: 1,
    projectId,
    roomId,
    expectedRevision,
    actionSha256: await relayRemoteAdminActionSha256(action),
    approvedAtMs,
    expiresAtMs,
    approvalNonce,
  }
  const proof = await dependencies.sign(claim)
  const record = parseProjectRelayAdminApprovalRecord({ schemaVersion: 1, proof, action })
  if (!record || JSON.stringify(record.proof.claim) !== JSON.stringify(claim)) {
    throw new Error('Project relay administrator approval signer returned a mismatched proof')
  }
  return record
}

async function verifyRecord(
  value: unknown,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
): Promise<'verified-device' | 'invalid' | 'unavailable'> {
  const record = parseProjectRelayAdminApprovalRecord(value)
  if (!record || record.proof.claim.projectId !== projectId || !directory.healthy) return 'invalid'
  if (await relayRemoteAdminActionSha256(record.action) !== record.proof.claim.actionSha256) return 'invalid'
  const device = directory.devices.find(({ keyId }) => keyId === record.proof.keyId)
  if (!device || device.status !== 'registered-device' ||
    device.publicKey !== record.proof.publicKey) return 'invalid'
  return verifyEd25519DeviceMessage(
    record.proof.keyId,
    record.proof.publicKey,
    record.proof.signature,
    canonicalProjectRelayAdminApprovalClaim(record.proof.claim),
  )
}

function emptyInspection(
  overrides: Partial<ProjectRelayAdminApprovalInspection> = {},
): ProjectRelayAdminApprovalInspection {
  return {
    healthy: true,
    approvalCount: 0,
    approvals: [],
    intents: [],
    conflictingSigners: 0,
    expiredApprovals: 0,
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
    ...overrides,
  }
}

export async function inspectProjectRelayAdminApprovals(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  nowMs = Date.now(),
): Promise<ProjectRelayAdminApprovalInspection> {
  if (!ID_PATTERN.test(projectId) || !Number.isSafeInteger(nowMs) || nowMs < 1 ||
    settings.size > MAX_RELAY_ADMIN_APPROVAL_SETTINGS_SCAN) {
    return emptyInspection({ healthy: false, invalidRecords: 1, excessRecords: 1 })
  }
  const candidates = Array.from(settings.entries())
    .filter(([key]) => key.startsWith(PROJECT_RELAY_ADMIN_APPROVAL_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
  if (candidates.length > MAX_PROJECT_RELAY_ADMIN_APPROVALS) {
    return emptyInspection({
      healthy: false,
      approvalCount: candidates.length,
      invalidRecords: candidates.length,
      excessRecords: candidates.length - MAX_PROJECT_RELAY_ADMIN_APPROVALS,
    })
  }
  const verified: Array<{ storageKey: string; record: ProjectRelayAdminApprovalRecord }> = []
  let invalidRecords = directory.healthy || candidates.length === 0 ? 0 : 1
  let unavailableRecords = 0
  for (let start = 0; start < candidates.length;
    start += MAX_RELAY_ADMIN_APPROVAL_VERIFICATION_CONCURRENCY) {
    const batch = candidates.slice(start, start + MAX_RELAY_ADMIN_APPROVAL_VERIFICATION_CONCURRENCY)
    const results = await Promise.all(batch.map(async ([storageKey, value]) => {
      const record = parseProjectRelayAdminApprovalRecord(value)
      if (!record || projectRelayAdminApprovalStorageKey(record) !== storageKey) {
        return { status: 'invalid' as const, storageKey, record: null }
      }
      return { status: await verifyRecord(record, projectId, directory), storageKey, record }
    }))
    for (const result of results) {
      if (result.status === 'verified-device' && result.record) {
        verified.push({ storageKey: result.storageKey, record: result.record })
      } else if (result.status === 'unavailable') {
        unavailableRecords += 1
      } else {
        invalidRecords += 1
      }
    }
  }

  const signerActions = new Map<string, Set<string>>()
  for (const { record } of verified) {
    const { claim } = record.proof
    const key = claim.roomId + ':' + claim.expectedRevision + ':' + record.proof.keyId
    const actions = signerActions.get(key) ?? new Set<string>()
    actions.add(claim.actionSha256)
    signerActions.set(key, actions)
  }
  const conflictingSignerKeys = new Set(Array.from(signerActions.entries())
    .filter(([, actions]) => actions.size > 1)
    .map(([key]) => key))
  const approvals: ProjectRelayAdminApprovalView[] = verified.map(({ storageKey, record }) => {
    const { claim } = record.proof
    const signerKey = claim.roomId + ':' + claim.expectedRevision + ':' + record.proof.keyId
    const device = directory.devices.find(({ keyId }) => keyId === record.proof.keyId)!
    return {
      storageKey,
      proof: record.proof,
      action: record.action,
      participantIds: [...device.participantIds],
      state: conflictingSignerKeys.has(signerKey)
        ? 'signer-conflict' as const
        : claim.expiresAtMs <= nowMs
          ? 'expired' as const
          : 'active' as const,
    }
  }).sort((left, right) =>
    left.proof.claim.roomId.localeCompare(right.proof.claim.roomId) ||
    left.proof.claim.expectedRevision - right.proof.claim.expectedRevision ||
    left.proof.claim.actionSha256.localeCompare(right.proof.claim.actionSha256) ||
    left.proof.keyId.localeCompare(right.proof.keyId) ||
    left.proof.claim.approvalNonce.localeCompare(right.proof.claim.approvalNonce))

  const intentGroups = new Map<string, ProjectRelayAdminApprovalView[]>()
  for (const approval of approvals.filter(({ state }) => state === 'active')) {
    const { claim } = approval.proof
    const key = claim.roomId + ':' + claim.expectedRevision + ':' + claim.actionSha256
    const group = intentGroups.get(key) ?? []
    group.push(approval)
    intentGroups.set(key, group)
  }
  const intents = Array.from(intentGroups.values()).map((group) => {
    const first = group[0]
    const signerIds = Array.from(new Set(group.map(({ proof }) => proof.keyId))).sort()
    const participantIds = Array.from(new Set(group.flatMap(({ participantIds }) => participantIds))).sort()
    return {
      roomId: first.proof.claim.roomId,
      expectedRevision: first.proof.claim.expectedRevision,
      actionSha256: first.proof.claim.actionSha256,
      action: first.action,
      activeSignerKeyIds: signerIds,
      activeParticipantIds: participantIds,
      approvalCount: signerIds.length,
    }
  }).sort((left, right) =>
    left.roomId.localeCompare(right.roomId) ||
    left.expectedRevision - right.expectedRevision ||
    left.actionSha256.localeCompare(right.actionSha256))

  return {
    healthy: invalidRecords === 0 && unavailableRecords === 0,
    approvalCount: candidates.length,
    approvals,
    intents,
    conflictingSigners: conflictingSignerKeys.size,
    expiredApprovals: approvals.filter(({ state }) => state === 'expired').length,
    invalidRecords,
    unavailableRecords,
    excessRecords: 0,
  }
}

function canonicalRecord(record: ProjectRelayAdminApprovalRecord): ProjectRelayAdminApprovalRecord {
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

export async function publishProjectRelayAdminApproval(
  settings: Y.Map<unknown>,
  projectId: string,
  directory: ProjectDeviceDirectoryInspection,
  value: unknown,
  nowMs = Date.now(),
): Promise<ProjectRelayAdminApprovalInspection> {
  const record = parseProjectRelayAdminApprovalRecord(value)
  if (!record || await verifyRecord(record, projectId, directory) !== 'verified-device') {
    throw new Error('Project relay administrator approval proof is invalid')
  }
  const before = await inspectProjectRelayAdminApprovals(settings, projectId, directory, nowMs)
  if (!before.healthy) throw new Error('Project relay administrator approval history is not safe to update')
  const storageKey = projectRelayAdminApprovalStorageKey(record)
  const canonical = canonicalRecord(record)
  const stored = settings.get(storageKey)
  if (stored !== undefined) {
    const existing = parseProjectRelayAdminApprovalRecord(stored)
    if (existing && JSON.stringify(existing) === JSON.stringify(canonical)) return before
    throw new Error('Project relay administrator approval identity collided')
  }
  if (before.approvalCount >= MAX_PROJECT_RELAY_ADMIN_APPROVALS) {
    throw new Error('Project relay administrator approval limit reached')
  }
  const operation = () => settings.set(storageKey, canonical)
  if (settings.doc) settings.doc.transact(operation, 'syzygy-project-relay-admin-approval')
  else operation()
  return inspectProjectRelayAdminApprovals(settings, projectId, directory, nowMs)
}

export function activeProjectRelayAdminApprovalProofs(
  inspection: ProjectRelayAdminApprovalInspection,
  roomId: string,
  expectedRevision: number,
  actionSha256: string,
): ProjectRelayAdminApprovalProof[] {
  if (!inspection.healthy) return []
  return inspection.approvals
    .filter(({ state, proof }) => state === 'active' && proof.claim.roomId === roomId &&
      proof.claim.expectedRevision === expectedRevision && proof.claim.actionSha256 === actionSha256)
    .filter((approval, index, values) =>
      values.findIndex(({ proof }) => proof.keyId === approval.proof.keyId) === index)
    .map(({ proof }) => proof)
    .sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0)
}

export function describeProjectRelayAdminApprovalAction(action: RelayRemoteAdminAction): string {
  const lifetime = (seconds: number | null) => seconds === null
    ? 'no automatic expiry'
    : `${seconds} seconds`
  if (action.kind === 'issue') {
    return `issue ${action.role}; ${lifetime(action.expiresInSeconds)}; device ${action.device.keyId}`
  }
  if (action.kind === 'rotate') {
    return `rotate member ${action.memberId}; ${lifetime(action.expiresInSeconds)}; ${
      action.device ? `replacement device ${action.device.keyId}` : 'retain enrolled device'}`
  }
  if (action.kind === 'revoke') return `revoke member ${action.memberId}`
  return 'inspect relay status'
}
