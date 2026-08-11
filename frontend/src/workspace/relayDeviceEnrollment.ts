import type { CollaborationIdentityReport, RelayDeviceBinding } from '../tauri'

export const RELAY_DEVICE_ENROLLMENT_PREFIX = 'syzygy-relay-device-v1.'
export const MAX_RELAY_DEVICE_ENROLLMENT_LENGTH = 1_000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Relay device enrollment is malformed')
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new Error('Relay device enrollment is malformed')
  }
}

async function normalizeBinding(value: unknown): Promise<RelayDeviceBinding> {
  if (!value || typeof value !== 'object' ||
    !exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey'])) {
    throw new Error('Relay device enrollment is malformed')
  }
  const candidate = value as Partial<RelayDeviceBinding>
  if (candidate.schemaVersion !== 1 || candidate.algorithm !== 'Ed25519' ||
    typeof candidate.keyId !== 'string' || typeof candidate.publicKey !== 'string') {
    throw new Error('Relay device enrollment is malformed')
  }
  const publicKey = decodeBase64UrlBytes(candidate.publicKey)
  if (publicKey.length !== 32 || encodeBase64UrlBytes(publicKey) !== candidate.publicKey) {
    throw new Error('Relay device enrollment is malformed')
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey as BufferSource))
  if (candidate.keyId !== `ed25519-sha256:${encodeBase64UrlBytes(digest)}`) {
    throw new Error('Relay device enrollment key ID does not match its public key')
  }
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: candidate.keyId,
    publicKey: candidate.publicKey,
  }
}

export async function createRelayDeviceEnrollment(
  identity: CollaborationIdentityReport,
): Promise<string> {
  const binding = await normalizeBinding({
    schemaVersion: 1,
    algorithm: identity.algorithm,
    keyId: identity.keyId,
    publicKey: identity.publicKey,
  })
  return RELAY_DEVICE_ENROLLMENT_PREFIX + encodeBase64UrlBytes(encoder.encode(JSON.stringify(binding)))
}

export async function parseRelayDeviceEnrollment(value: string): Promise<RelayDeviceBinding> {
  const enrollment = value.trim()
  if (enrollment.length > MAX_RELAY_DEVICE_ENROLLMENT_LENGTH ||
    !enrollment.startsWith(RELAY_DEVICE_ENROLLMENT_PREFIX)) {
    throw new Error('Relay device enrollment is invalid or too long')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(decoder.decode(decodeBase64UrlBytes(
      enrollment.slice(RELAY_DEVICE_ENROLLMENT_PREFIX.length),
    )))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Relay device enrollment')) throw error
    throw new Error('Relay device enrollment is malformed')
  }
  return normalizeBinding(decoded)
}
