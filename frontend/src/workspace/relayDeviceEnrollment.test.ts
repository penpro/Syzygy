import { describe, expect, it } from 'vitest'
import type { CollaborationIdentityReport } from '../tauri'
import {
  createRelayDeviceEnrollment,
  parseRelayDeviceEnrollment,
  RELAY_DEVICE_ENROLLMENT_PREFIX,
} from './relayDeviceEnrollment'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function identity(): Promise<CollaborationIdentityReport> {
  const publicBytes = Uint8Array.from({ length: 32 }, (_, index) => index)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicBytes))
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: `ed25519-sha256:${base64Url(digest)}`,
    publicKey: base64Url(publicBytes),
    fingerprint: base64Url(digest),
    createdAtMs: 1,
    scope: 'installation-device-not-human-identity',
  }
}

function encoded(value: unknown): string {
  return RELAY_DEVICE_ENROLLMENT_PREFIX + base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

describe('relay device enrollment', () => {
  it('round-trips only the canonical public installation identity', async () => {
    const report = await identity()
    const enrollment = await createRelayDeviceEnrollment(report)
    expect(await parseRelayDeviceEnrollment(enrollment)).toEqual({
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: report.keyId,
      publicKey: report.publicKey,
    })
    expect(enrollment).not.toContain('private')
  })

  it('rejects mismatched keys, unknown fields, noncanonical base64, and oversized input', async () => {
    const report = await identity()
    await expect(parseRelayDeviceEnrollment(encoded({
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: `${report.keyId}x`,
      publicKey: report.publicKey,
    }))).rejects.toThrow('does not match')
    await expect(parseRelayDeviceEnrollment(encoded({
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: report.keyId,
      publicKey: report.publicKey,
      authority: 'admin',
    }))).rejects.toThrow('malformed')
    await expect(parseRelayDeviceEnrollment(`${RELAY_DEVICE_ENROLLMENT_PREFIX}${'a'.repeat(1_001)}`))
      .rejects.toThrow('invalid or too long')
  })
})
