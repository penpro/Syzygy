import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type { ProjectDeviceRegistrationProof } from '../tauri'
import {
  canonicalProjectDeviceRegistrationClaim,
  projectDeviceRegistrationStorageKey,
} from './deviceIdentity'
import {
  inspectProjectDeviceDirectory,
  MAX_PROJECT_DEVICE_REGISTRATIONS,
  MAX_PROJECT_SETTINGS_SCAN,
  PROJECT_DEVICE_REGISTRATION_PREFIX,
  publishProjectDeviceRegistration,
} from './projectDeviceDirectory'

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

async function signingKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

async function registration(
  keys: CryptoKeyPair,
  participantId: string,
  projectId = 'project-a',
): Promise<ProjectDeviceRegistrationProof> {
  const claim = { schemaVersion: 1 as const, projectId, participantId }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(publicKey)))
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' }, keys.privateKey, asArrayBuffer(canonicalProjectDeviceRegistrationClaim(claim)),
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

function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left)
  const rightUpdate = Y.encodeStateAsUpdate(right)
  Y.applyUpdate(left, rightUpdate)
  Y.applyUpdate(right, leftUpdate)
}

describe('durable signed project device directory', () => {
  it('publishes idempotently, converges disconnected devices, and reopens offline', async () => {
    const left = new Y.Doc()
    const right = new Y.Doc()
    const leftProof = await registration(await signingKeys(), 'participant-left')
    const rightProof = await registration(await signingKeys(), 'participant-right')
    await publishProjectDeviceRegistration(left.getMap('project:settings'), 'project-a', leftProof)
    await publishProjectDeviceRegistration(left.getMap('project:settings'), 'project-a', leftProof)
    await publishProjectDeviceRegistration(right.getMap('project:settings'), 'project-a', rightProof)
    expect(left.getMap('project:settings').size).toBe(1)

    merge(left, right)
    const leftInspection = await inspectProjectDeviceDirectory(left.getMap('project:settings'), 'project-a')
    const rightInspection = await inspectProjectDeviceDirectory(right.getMap('project:settings'), 'project-a')
    expect(leftInspection).toEqual(rightInspection)
    expect(leftInspection).toMatchObject({
      healthy: true,
      registrationCount: 2,
      conflictingDevices: 0,
      invalidRecords: 0,
      unavailableRecords: 0,
    })

    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(left))
    await expect(inspectProjectDeviceDirectory(reopened.getMap('project:settings'), 'project-a'))
      .resolves.toEqual(leftInspection)
  })

  it('retains conflicting participant claims by one key without selecting an identity', async () => {
    const keys = await signingKeys()
    const left = new Y.Doc()
    const right = new Y.Doc()
    await publishProjectDeviceRegistration(
      left.getMap('project:settings'), 'project-a', await registration(keys, 'participant-a'),
    )
    await publishProjectDeviceRegistration(
      right.getMap('project:settings'), 'project-a', await registration(keys, 'participant-b'),
    )
    merge(left, right)
    const inspection = await inspectProjectDeviceDirectory(left.getMap('project:settings'), 'project-a')
    expect(inspection).toMatchObject({ healthy: true, registrationCount: 2, conflictingDevices: 1 })
    expect(inspection.devices).toEqual([expect.objectContaining({
      participantIds: ['participant-a', 'participant-b'],
      status: 'participant-claim-conflict',
    })])
  })

  it('rejects cross-project replay, mutation, malformed storage keys, and poisoned directories before write', async () => {
    const settings = new Y.Doc().getMap('project:settings')
    const proof = await registration(await signingKeys(), 'participant-a')
    await expect(publishProjectDeviceRegistration(settings, 'project-b', proof))
      .rejects.toThrow('proof is invalid')
    await expect(publishProjectDeviceRegistration(settings, 'project-a', {
      ...proof,
      claim: { ...proof.claim, participantId: 'participant-b' },
    })).rejects.toThrow('proof is invalid')
    expect(settings.size).toBe(0)

    settings.set(`${PROJECT_DEVICE_REGISTRATION_PREFIX}hostile`, proof)
    const poisoned = await inspectProjectDeviceDirectory(settings, 'project-a')
    expect(poisoned).toMatchObject({ healthy: false, invalidRecords: 1 })
    await expect(publishProjectDeviceRegistration(
      settings, 'project-a', await registration(await signingKeys(), 'participant-b'),
    )).rejects.toThrow('not safe to update')
    expect(settings.size).toBe(1)
  })

  it('fails closed before cryptographic work when registration or settings scan bounds are exceeded', async () => {
    const registrations = new Y.Doc().getMap('project:settings')
    for (let index = 0; index <= MAX_PROJECT_DEVICE_REGISTRATIONS; index += 1) {
      registrations.set(`${PROJECT_DEVICE_REGISTRATION_PREFIX}excess-${index}`, null)
    }
    await expect(inspectProjectDeviceDirectory(registrations, 'project-a')).resolves.toMatchObject({
      healthy: false,
      registrationCount: MAX_PROJECT_DEVICE_REGISTRATIONS + 1,
      excessRecords: 1,
    })

    const settings = new Y.Doc().getMap('project:settings')
    for (let index = 0; index <= MAX_PROJECT_SETTINGS_SCAN; index += 1) settings.set(`unrelated-${index}`, true)
    await expect(inspectProjectDeviceDirectory(settings, 'project-a')).resolves.toMatchObject({
      healthy: false,
      excessRecords: 1,
    })
  })

  it('derives exact storage identity from every signed registration field', async () => {
    const proof = await registration(await signingKeys(), 'participant-a')
    expect(projectDeviceRegistrationStorageKey(proof))
      .toBe(`${PROJECT_DEVICE_REGISTRATION_PREFIX}${proof.keyId}:participant-a`)
  })
})
