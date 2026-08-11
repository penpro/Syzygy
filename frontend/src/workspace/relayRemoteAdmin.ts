import {
  collaborationIdentitySignRelayAccess,
  collaborationIdentitySignRelayAdmin,
  type RelayAccessIdentityClaim,
  type RelayAccessIdentityProof,
  type RelayAdminIdentityClaim,
  type RelayAdminIdentityProof,
  type RelayDeviceBinding,
  type RelayMemberCredential,
  type RelayMemberRole,
  type RelayRoomMembershipReport,
} from '../tauri'
import {
  normalizeWebsocketProjectBinding,
  type ManagedRelayAccessV3,
  type WebsocketProjectBinding,
} from './websocketProjectBinding'

const ADMIN_PATH = '/__syzygy_relay_admin_v1/'
const REQUEST_DEADLINE_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024
const STABLE_ID = /^[A-Za-z0-9_-]+$/
const KEY_ID = /^ed25519-sha256:[A-Za-z0-9_-]{43}$/
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/

export type RelayRemoteAdminAction =
  | { kind: 'status' }
  | { kind: 'issue'; role: RelayMemberRole; expiresInSeconds: number | null; device: RelayDeviceBinding }
  | { kind: 'rotate'; memberId: string; expiresInSeconds: number | null; device: RelayDeviceBinding | null }
  | { kind: 'revoke'; memberId: string }

export interface RelayRemoteAdminResult {
  room: RelayRoomMembershipReport
  credential: RelayMemberCredential | null
}

interface RelayRemoteAdminResponse {
  schemaVersion: 1
  ok: boolean
  error: string | null
  room: RelayRoomMembershipReport | null
  credential: RelayMemberCredential | null
}

export interface RelayRemoteAdminDependencies {
  signAccess: (claim: RelayAccessIdentityClaim) => Promise<RelayAccessIdentityProof>
  signAdmin: (claim: RelayAdminIdentityClaim) => Promise<RelayAdminIdentityProof>
  createSocket: (url: string) => WebSocket
  now: () => number
  nonce: () => string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRole(value: unknown): value is RelayMemberRole {
  return value === 'admin' || value === 'editor' || value === 'viewer'
}

function validStableId(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && STABLE_ID.test(value)
}

function validOptionalTimestamp(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function validateDevice(device: RelayDeviceBinding): void {
  if (!isRecord(device) || !exactKeys(device, ['schemaVersion', 'algorithm', 'keyId', 'publicKey']) ||
    device.schemaVersion !== 1 || device.algorithm !== 'Ed25519' || !KEY_ID.test(device.keyId) ||
    typeof device.publicKey !== 'string' || !BASE64URL_32.test(device.publicKey)) {
    throw new Error('Relay member device enrollment is malformed')
  }
}

function validateExpiry(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 300 || value > 365 * 24 * 60 * 60)) {
    throw new Error('Relay member expiry must be between five minutes and one year')
  }
}

export function canonicalRelayRemoteAdminAction(action: RelayRemoteAdminAction): string {
  switch (action.kind) {
    case 'status':
      return 'status'
    case 'issue':
      if (!validRole(action.role)) throw new Error('Relay member role is invalid')
      validateExpiry(action.expiresInSeconds)
      validateDevice(action.device)
      return `issue\n${action.role}\n${action.expiresInSeconds ?? 'none'}\n${action.device.schemaVersion}\n${action.device.algorithm}\n${action.device.keyId}\n${action.device.publicKey}`
    case 'rotate':
      if (!validStableId(action.memberId, 16, 128)) throw new Error('Relay member ID is invalid')
      validateExpiry(action.expiresInSeconds)
      if (action.device) validateDevice(action.device)
      return `rotate\n${action.memberId}\n${action.expiresInSeconds ?? 'none'}\n${action.device
        ? `${action.device.schemaVersion}\n${action.device.algorithm}\n${action.device.keyId}\n${action.device.publicKey}`
        : 'none'}`
    case 'revoke':
      if (!validStableId(action.memberId, 16, 128)) throw new Error('Relay member ID is invalid')
      return `revoke\n${action.memberId}`
  }
}

export function parseRelayRemoteAdminAction(value: unknown): RelayRemoteAdminAction | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  let action: RelayRemoteAdminAction
  if (value.kind === 'status' && exactKeys(value, ['kind'])) {
    action = { kind: 'status' }
  } else if (value.kind === 'issue' && exactKeys(value, ['kind', 'role', 'expiresInSeconds', 'device']) &&
    validRole(value.role) && (value.expiresInSeconds === null || Number.isSafeInteger(value.expiresInSeconds)) &&
    isRecord(value.device)) {
    action = {
      kind: 'issue',
      role: value.role,
      expiresInSeconds: value.expiresInSeconds as number | null,
      device: value.device as unknown as RelayDeviceBinding,
    }
  } else if (value.kind === 'rotate' && exactKeys(value, ['kind', 'memberId', 'expiresInSeconds', 'device']) &&
    typeof value.memberId === 'string' &&
    (value.expiresInSeconds === null || Number.isSafeInteger(value.expiresInSeconds)) &&
    (value.device === null || isRecord(value.device))) {
    action = {
      kind: 'rotate',
      memberId: value.memberId,
      expiresInSeconds: value.expiresInSeconds as number | null,
      device: value.device as RelayDeviceBinding | null,
    }
  } else if (value.kind === 'revoke' && exactKeys(value, ['kind', 'memberId']) &&
    typeof value.memberId === 'string') {
    action = { kind: 'revoke', memberId: value.memberId }
  } else {
    return null
  }
  try {
    canonicalRelayRemoteAdminAction(action)
    return action
  } catch {
    return null
  }
}

export async function relayRemoteAdminActionSha256(action: RelayRemoteAdminAction): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalRelayRemoteAdminAction(action)),
  )))
}

function validateAccessProof(
  proof: RelayAccessIdentityProof,
  claim: RelayAccessIdentityClaim,
  access: ManagedRelayAccessV3,
): void {
  if (proof.schemaVersion !== 1 || proof.algorithm !== 'Ed25519' || proof.keyId !== access.deviceKeyId ||
    proof.signature.length !== 86 || JSON.stringify(proof.claim) !== JSON.stringify(claim)) {
    throw new Error('This installation does not match the device key enrolled for this relay administrator')
  }
}

function validateAdminProof(
  proof: RelayAdminIdentityProof,
  claim: RelayAdminIdentityClaim,
  access: ManagedRelayAccessV3,
): void {
  if (proof.schemaVersion !== 1 || proof.algorithm !== 'Ed25519' || proof.keyId !== access.deviceKeyId ||
    proof.signature.length !== 86 || JSON.stringify(proof.claim) !== JSON.stringify(claim)) {
    throw new Error('Relay administrator action proof is invalid')
  }
}

function normalizeMember(value: unknown): RelayRoomMembershipReport['members'][number] {
  if (!isRecord(value) || !exactKeys(value, [
    'memberId', 'role', 'createdAtMs', 'rotatedAtMs', 'expiresAtMs', 'capabilityGeneration',
    'revokedAtMs', 'deviceKeyId',
  ]) || !validStableId(value.memberId, 16, 128) || !validRole(value.role) ||
    !Number.isSafeInteger(value.createdAtMs) || Number(value.createdAtMs) <= 0 ||
    !validOptionalTimestamp(value.rotatedAtMs) || !validOptionalTimestamp(value.expiresAtMs) ||
    !Number.isSafeInteger(value.capabilityGeneration) || Number(value.capabilityGeneration) < 1 ||
    !validOptionalTimestamp(value.revokedAtMs) ||
    !(value.deviceKeyId === null || (typeof value.deviceKeyId === 'string' && KEY_ID.test(value.deviceKeyId)))) {
    throw new Error('Relay administrator response contains malformed membership data')
  }
  return value as unknown as RelayRoomMembershipReport['members'][number]
}

function normalizeRoom(value: unknown, roomId: string): RelayRoomMembershipReport {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'registryRevision', 'roomId', 'projectId', 'protected', 'members',
  ]) || value.schemaVersion !== 3 || !Number.isSafeInteger(value.registryRevision) ||
    Number(value.registryRevision) < 1 || value.roomId !== roomId ||
    !validStableId(value.projectId, 8, 128) || value.protected !== true ||
    !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 64) {
    throw new Error('Relay administrator response contains a malformed room report')
  }
  return { ...value, members: value.members.map(normalizeMember) } as RelayRoomMembershipReport
}

function normalizeCredential(value: unknown, roomId: string): RelayMemberCredential {
  if (!isRecord(value)) throw new Error('Relay administrator response contains a malformed credential')
  if (value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new Error('Relay administrator response contains a malformed credential')
  }
  const schemaVersion = value.schemaVersion
  const deviceShapeValid = schemaVersion === 2
    ? value.deviceKeyId === undefined
    : schemaVersion === 3 && typeof value.deviceKeyId === 'string' && KEY_ID.test(value.deviceKeyId)
  if (!deviceShapeValid || value.roomId !== roomId ||
    !validStableId(value.memberId, 16, 128) || !validRole(value.role) ||
    typeof value.capability !== 'string' || !validStableId(value.capability, 32, 128) ||
    !Number.isSafeInteger(value.capabilityGeneration) || Number(value.capabilityGeneration) < 1 ||
    !validOptionalTimestamp(value.expiresAtMs) || !Number.isSafeInteger(value.registryRevision) ||
    Number(value.registryRevision) < 1 ||
    !exactKeys(value, value.deviceKeyId === undefined
      ? ['schemaVersion', 'roomId', 'memberId', 'role', 'capability', 'capabilityGeneration', 'expiresAtMs', 'registryRevision']
      : ['schemaVersion', 'roomId', 'memberId', 'role', 'capability', 'capabilityGeneration', 'expiresAtMs', 'registryRevision', 'deviceKeyId'])) {
    throw new Error('Relay administrator response contains a malformed credential')
  }
  return value as unknown as RelayMemberCredential
}

function normalizeResponse(value: unknown, roomId: string): RelayRemoteAdminResponse {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'ok', 'error', 'room', 'credential']) ||
    value.schemaVersion !== 1 || typeof value.ok !== 'boolean' ||
    !(value.error === null || (typeof value.error === 'string' && value.error.length <= 512))) {
    throw new Error('Relay administrator response is malformed')
  }
  if (!value.ok) {
    if (!value.error || value.room !== null || value.credential !== null) {
      throw new Error('Relay administrator rejection is malformed')
    }
    return value as unknown as RelayRemoteAdminResponse
  }
  if (value.error !== null || value.room === null) {
    throw new Error('Relay administrator success response is malformed')
  }
  const room = normalizeRoom(value.room, roomId)
  const credential = value.credential === null ? null : normalizeCredential(value.credential, roomId)
  if (credential && credential.registryRevision !== room.registryRevision) {
    throw new Error('Relay administrator response credential revision does not match its room report')
  }
  return {
    schemaVersion: 1,
    ok: true,
    error: null,
    room,
    credential,
  }
}

function validateResponseForAction(
  response: RelayRemoteAdminResponse,
  projectId: string,
  action: RelayRemoteAdminAction,
  expectedRevision: number,
): void {
  if (!response.ok) return
  const room = response.room!
  if (room.projectId !== projectId) {
    throw new Error('Relay administrator response belongs to a different project')
  }
  if (action.kind === 'status') {
    if (response.credential !== null) {
      throw new Error('Relay administrator status unexpectedly returned a credential')
    }
    return
  }
  if (room.registryRevision !== expectedRevision + 1) {
    throw new Error('Relay administrator response did not apply the expected revision transition')
  }
  if (action.kind === 'revoke') {
    if (response.credential !== null) {
      throw new Error('Relay administrator revocation unexpectedly returned a credential')
    }
    return
  }
  const credential = response.credential
  if (!credential || credential.schemaVersion !== 3 ||
    (action.kind === 'rotate' && credential.memberId !== action.memberId) ||
    (action.kind === 'issue' && (credential.role !== action.role ||
      credential.deviceKeyId !== action.device.keyId))) {
    throw new Error('Relay administrator response credential does not match its action')
  }
}

const DEFAULT_DEPENDENCIES: RelayRemoteAdminDependencies = {
  signAccess: collaborationIdentitySignRelayAccess,
  signAdmin: collaborationIdentitySignRelayAdmin,
  createSocket: (url) => new WebSocket(url),
  now: () => Date.now(),
  nonce: randomNonce,
}

export async function runRelayRemoteAdminAction(
  projectId: string,
  bindingValue: WebsocketProjectBinding,
  action: RelayRemoteAdminAction,
  expectedRevision: number,
  dependencies: RelayRemoteAdminDependencies = DEFAULT_DEPENDENCIES,
): Promise<RelayRemoteAdminResult> {
  const binding = normalizeWebsocketProjectBinding(bindingValue)
  if (!validStableId(projectId, 1, 200)) {
    throw new Error('Relay administrator project ID is invalid')
  }
  const access = binding.access
  if (access?.schemaVersion !== 3 || access.role !== 'admin') {
    throw new Error('This project does not contain device-bound relay administrator access')
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
    (action.kind === 'status' ? expectedRevision !== 0 : expectedRevision < 1)) {
    throw new Error('Relay administrator registry revision is invalid')
  }
  const issuedAtMs = dependencies.now()
  const nonce = dependencies.nonce()
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0 || !BASE64URL_32.test(nonce)) {
    throw new Error('Relay administrator freshness claim is invalid')
  }
  const accessClaim: RelayAccessIdentityClaim = {
    schemaVersion: 1,
    roomId: binding.roomId,
    memberId: access.memberId,
    capabilityGeneration: access.capabilityGeneration,
    issuedAtMs,
    nonce,
    capability: access.capability,
  }
  const accessProof = await dependencies.signAccess(accessClaim)
  validateAccessProof(accessProof, accessClaim, access)
  const adminClaim: RelayAdminIdentityClaim = {
    schemaVersion: 1,
    projectId,
    roomId: binding.roomId,
    administratorMemberId: access.memberId,
    expectedRevision,
    issuedAtMs,
    nonce,
    actionSha256: await relayRemoteAdminActionSha256(action),
  }
  const adminProof = await dependencies.signAdmin(adminClaim)
  validateAdminProof(adminProof, adminClaim, access)

  const query = new URLSearchParams({
    member: access.memberId,
    capability: access.capability,
    generation: String(access.capabilityGeneration),
    issued: String(issuedAtMs),
    nonce,
    signature: accessProof.signature,
  })
  const socket = dependencies.createSocket(
    `${binding.endpoint}${ADMIN_PATH}${binding.roomId}?${query.toString()}`,
  )
  return await new Promise<RelayRemoteAdminResult>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, response?: RelayRemoteAdminResponse) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error)
      else if (!response?.ok) reject(new Error(response?.error ?? 'Relay administrator request failed'))
      else resolve({ room: response.room!, credential: response.credential })
    }
    const deadline = setTimeout(
      () => finish(new Error('Relay administrator request exceeded its ten-second deadline')),
      REQUEST_DEADLINE_MS,
    )
    socket.onopen = () => socket.send(JSON.stringify({
      schemaVersion: 1,
      claim: adminClaim,
      action,
      signature: adminProof.signature,
    }))
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' ||
        new TextEncoder().encode(event.data).byteLength > MAX_RESPONSE_BYTES) {
        finish(new Error('Relay administrator response is not bounded text'))
        return
      }
      try {
        const response = normalizeResponse(JSON.parse(event.data), binding.roomId)
        validateResponseForAction(response, projectId, action, expectedRevision)
        finish(undefined, response)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    socket.onerror = () => finish(new Error('Self-hosted collaboration relay administration is unavailable'))
    socket.onclose = () => finish(new Error('Self-hosted collaboration relay closed before responding'))
  })
}
