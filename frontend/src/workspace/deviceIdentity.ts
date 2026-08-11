import type {
  DevicePresenceProof,
  PresenceIdentityClaim,
  ProjectDeviceRegistrationClaim,
  ProjectDeviceRegistrationProof,
} from '../tauri'

export type DeviceProofStatus = 'unsigned' | 'checking' | 'verified-device' | 'invalid' | 'unavailable'
export type ProjectDeviceRegistrationStatus = 'verified-device' | 'invalid' | 'unavailable'

export interface ExpectedPresenceIdentity {
  projectId: string
  documentId: string
  participantId: string
  awarenessClientId: number
}

export const MAX_DEVICE_PROOF_CACHE_ENTRIES = 400
export const MAX_DEVICE_PROOF_VERIFICATIONS = 200

const MAX_U32 = 0xffff_ffff
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string, exactBytes: number): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value) || value.includes('=')) return null
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const decoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    if (decoded.byteLength !== exactBytes || encodeBase64Url(decoded) !== value) return null
    return decoded
  } catch {
    return null
  }
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength)
  new Uint8Array(copy).set(value)
  return copy
}

function readClaim(value: unknown): PresenceIdentityClaim | null {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'projectId', 'documentId', 'participantId', 'awarenessClientId', 'sessionNonce',
  ])) return null
  if (value.schemaVersion !== 1 || typeof value.projectId !== 'string' || !ID_PATTERN.test(value.projectId) ||
    typeof value.documentId !== 'string' || !ID_PATTERN.test(value.documentId) ||
    typeof value.participantId !== 'string' || !ID_PATTERN.test(value.participantId) ||
    !Number.isSafeInteger(value.awarenessClientId) || Number(value.awarenessClientId) < 0 ||
    Number(value.awarenessClientId) > MAX_U32 || typeof value.sessionNonce !== 'string' ||
    !decodeBase64Url(value.sessionNonce, 32)) return null
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    documentId: value.documentId,
    participantId: value.participantId,
    awarenessClientId: Number(value.awarenessClientId),
    sessionNonce: value.sessionNonce,
  }
}

function readRegistrationClaim(value: unknown): ProjectDeviceRegistrationClaim | null {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'projectId', 'participantId'])) return null
  if (value.schemaVersion !== 1 || typeof value.projectId !== 'string' || !ID_PATTERN.test(value.projectId) ||
    typeof value.participantId !== 'string' || !ID_PATTERN.test(value.participantId)) return null
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    participantId: value.participantId,
  }
}

export function parseDevicePresenceProof(value: unknown): DevicePresenceProof | null {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature',
  ])) return null
  const claim = readClaim(value.claim)
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519' ||
    typeof value.keyId !== 'string' || value.keyId.length > 100 ||
    typeof value.publicKey !== 'string' || !decodeBase64Url(value.publicKey, 32) ||
    typeof value.signature !== 'string' || !decodeBase64Url(value.signature, 64) || !claim) return null
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: value.keyId,
    publicKey: value.publicKey,
    claim,
    signature: value.signature,
  }
}

export function parseProjectDeviceRegistrationProof(value: unknown): ProjectDeviceRegistrationProof | null {
  if (!record(value) || !exactKeys(value, [
    'schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature',
  ])) return null
  const claim = readRegistrationClaim(value.claim)
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519' ||
    typeof value.keyId !== 'string' || value.keyId.length > 100 ||
    typeof value.publicKey !== 'string' || !decodeBase64Url(value.publicKey, 32) ||
    typeof value.signature !== 'string' || !decodeBase64Url(value.signature, 64) || !claim) return null
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: value.keyId,
    publicKey: value.publicKey,
    claim,
    signature: value.signature,
  }
}

export function canonicalPresenceClaim(claim: PresenceIdentityClaim): Uint8Array {
  return new TextEncoder().encode([
    'syzygy-device-presence-v1',
    claim.projectId,
    claim.documentId,
    claim.participantId,
    String(claim.awarenessClientId),
    claim.sessionNonce,
  ].join('\n'))
}

export function canonicalProjectDeviceRegistrationClaim(claim: ProjectDeviceRegistrationClaim): Uint8Array {
  return new TextEncoder().encode([
    'syzygy-project-device-registration-v1',
    claim.projectId,
    claim.participantId,
  ].join('\n'))
}

export function projectDeviceRegistrationStorageKey(proof: ProjectDeviceRegistrationProof): string {
  return `collaboration-device-registration:v1:${proof.keyId}:${proof.claim.participantId}`
}

export function devicePresenceProofCacheKey(
  proof: DevicePresenceProof,
  expected: ExpectedPresenceIdentity,
): string {
  return JSON.stringify([
    expected.projectId,
    expected.documentId,
    expected.participantId,
    expected.awarenessClientId,
    proof.schemaVersion,
    proof.algorithm,
    proof.keyId,
    proof.publicKey,
    proof.claim.schemaVersion,
    proof.claim.projectId,
    proof.claim.documentId,
    proof.claim.participantId,
    proof.claim.awarenessClientId,
    proof.claim.sessionNonce,
    proof.signature,
  ])
}

export function createPresenceSessionNonce(): string {
  const nonce = new Uint8Array(32)
  globalThis.crypto.getRandomValues(nonce)
  return encodeBase64Url(nonce)
}

export async function verifyDevicePresenceProof(
  value: unknown,
  expected: ExpectedPresenceIdentity,
): Promise<DeviceProofStatus> {
  const proof = parseDevicePresenceProof(value)
  if (!proof || proof.claim.projectId !== expected.projectId ||
    proof.claim.documentId !== expected.documentId || proof.claim.participantId !== expected.participantId ||
    proof.claim.awarenessClientId !== expected.awarenessClientId) return 'invalid'
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return 'unavailable'
  const publicKey = decodeBase64Url(proof.publicKey, 32)
  const signature = decodeBase64Url(proof.signature, 64)
  if (!publicKey || !signature) return 'invalid'
  try {
    const digest = new Uint8Array(await subtle.digest('SHA-256', asArrayBuffer(publicKey)))
    if (proof.keyId !== `ed25519-sha256:${encodeBase64Url(digest)}`) return 'invalid'
    const key = await subtle.importKey('raw', asArrayBuffer(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      asArrayBuffer(signature),
      asArrayBuffer(canonicalPresenceClaim(proof.claim)),
    )
      ? 'verified-device'
      : 'invalid'
  } catch (error) {
    return error instanceof Error && error.name === 'NotSupportedError' ? 'unavailable' : 'invalid'
  }
}

export async function verifyProjectDeviceRegistrationProof(
  value: unknown,
  expectedProjectId: string,
): Promise<ProjectDeviceRegistrationStatus> {
  const proof = parseProjectDeviceRegistrationProof(value)
  if (!proof || !ID_PATTERN.test(expectedProjectId) || proof.claim.projectId !== expectedProjectId) return 'invalid'
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return 'unavailable'
  const publicKey = decodeBase64Url(proof.publicKey, 32)
  const signature = decodeBase64Url(proof.signature, 64)
  if (!publicKey || !signature) return 'invalid'
  try {
    const digest = new Uint8Array(await subtle.digest('SHA-256', asArrayBuffer(publicKey)))
    if (proof.keyId !== `ed25519-sha256:${encodeBase64Url(digest)}`) return 'invalid'
    const key = await subtle.importKey('raw', asArrayBuffer(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      asArrayBuffer(signature),
      asArrayBuffer(canonicalProjectDeviceRegistrationClaim(proof.claim)),
    )
      ? 'verified-device'
      : 'invalid'
  } catch (error) {
    return error instanceof Error && error.name === 'NotSupportedError' ? 'unavailable' : 'invalid'
  }
}
