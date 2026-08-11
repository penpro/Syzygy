import { describe, expect, it } from 'vitest'
import type { DevicePresenceProof, PresenceIdentityClaim } from '../tauri'
import {
  canonicalPresenceClaim,
  createPresenceSessionNonce,
  devicePresenceProofCacheKey,
  parseDevicePresenceProof,
  verifyDevicePresenceProof,
} from './deviceIdentity'

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength)
  new Uint8Array(copy).set(value)
  return copy
}

async function signedProof(): Promise<DevicePresenceProof> {
  const claim: PresenceIdentityClaim = {
    schemaVersion: 1,
    projectId: 'project-a',
    documentId: 'document-a',
    participantId: 'participant-a',
    awarenessClientId: 42,
    sessionNonce: createPresenceSessionNonce(),
  }
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(publicKey)))
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' },
    keys.privateKey,
    asArrayBuffer(canonicalPresenceClaim(claim)),
  ))
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: `ed25519-sha256:${encodeBase64Url(digest)}`,
    publicKey: encodeBase64Url(publicKey),
    claim,
    signature: encodeBase64Url(signature),
  }
}

const expected = {
  projectId: 'project-a',
  documentId: 'document-a',
  participantId: 'participant-a',
  awarenessClientId: 42,
}

describe('signed device presence', () => {
  it('strictly parses and verifies an Ed25519 installation-session proof', async () => {
    const proof = await signedProof()
    expect(parseDevicePresenceProof(proof)).toEqual(proof)
    await expect(verifyDevicePresenceProof(proof, expected)).resolves.toBe('verified-device')
  })

  it('rejects cross-project, cross-document, participant, client, key ID, and signature mutations', async () => {
    const proof = await signedProof()
    await expect(verifyDevicePresenceProof(proof, { ...expected, projectId: 'project-b' })).resolves.toBe('invalid')
    await expect(verifyDevicePresenceProof(proof, { ...expected, documentId: 'document-b' })).resolves.toBe('invalid')
    await expect(verifyDevicePresenceProof(proof, { ...expected, participantId: 'participant-b' })).resolves.toBe('invalid')
    await expect(verifyDevicePresenceProof(proof, { ...expected, awarenessClientId: 43 })).resolves.toBe('invalid')
    await expect(verifyDevicePresenceProof({ ...proof, keyId: `${proof.keyId}x` }, expected)).resolves.toBe('invalid')
    const signature = `${proof.signature.slice(0, -1)}${proof.signature.endsWith('A') ? 'B' : 'A'}`
    await expect(verifyDevicePresenceProof({ ...proof, signature }, expected)).resolves.toBe('invalid')
  })

  it('fails closed on unknown fields, noncanonical base64url, bad bounds, and arbitrary signing shapes', async () => {
    const proof = await signedProof()
    expect(parseDevicePresenceProof({ ...proof, role: 'admin' })).toBeNull()
    expect(parseDevicePresenceProof({ ...proof, signature: `${proof.signature}=` })).toBeNull()
    expect(parseDevicePresenceProof({ ...proof, claim: { ...proof.claim, awarenessClientId: 0x1_0000_0000 } })).toBeNull()
    expect(parseDevicePresenceProof({ ...proof, claim: { ...proof.claim, message: 'sign anything' } })).toBeNull()
  })

  it('keys verification cache entries by every expected and signed field', async () => {
    const proof = await signedProof()
    const original = devicePresenceProofCacheKey(proof, expected)
    expect(devicePresenceProofCacheKey({
      ...proof,
      claim: { ...proof.claim, sessionNonce: 'A'.repeat(43) },
    }, expected)).not.toBe(original)
    expect(devicePresenceProofCacheKey({ ...proof, publicKey: 'A'.repeat(43) }, expected)).not.toBe(original)
    expect(devicePresenceProofCacheKey({ ...proof, signature: 'A'.repeat(86) }, expected)).not.toBe(original)
    expect(devicePresenceProofCacheKey(proof, { ...expected, projectId: 'project-b' })).not.toBe(original)
  })
})
