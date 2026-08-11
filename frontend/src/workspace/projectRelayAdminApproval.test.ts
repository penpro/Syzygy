import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type {
  ProjectRelayAdminApprovalClaim,
  ProjectRelayAdminApprovalProof,
} from '../tauri'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import {
  activeProjectRelayAdminApprovalProofs,
  canonicalProjectRelayAdminApprovalClaim,
  createProjectRelayAdminApprovalRecord,
  describeProjectRelayAdminApprovalAction,
  inspectProjectRelayAdminApprovals,
  MAX_PROJECT_RELAY_ADMIN_APPROVALS,
  parseProjectRelayAdminApprovalRecord,
  PROJECT_RELAY_ADMIN_APPROVAL_PREFIX,
  projectRelayAdminApprovalStorageKey,
  publishProjectRelayAdminApproval,
  type ProjectRelayAdminApprovalDependencies,
  type ProjectRelayAdminApprovalRecord,
} from './projectRelayAdminApproval'
import { relayRemoteAdminActionSha256, type RelayRemoteAdminAction } from './relayRemoteAdmin'

const projectId = 'project-relay-approvals'
const roomId = 'r'.repeat(43)
const memberA = 'a'.repeat(22)
const memberB = 'b'.repeat(22)
const nowMs = 1_750_000_000_000

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

interface TestIdentity {
  keys: CryptoKeyPair
  keyId: string
  publicKey: string
  participantId: string
}

async function identity(participantId: string): Promise<TestIdentity> {
  const keys = await crypto.subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(raw)))
  return {
    keys,
    keyId: 'ed25519-sha256:' + encodeBase64Url(digest),
    publicKey: encodeBase64Url(raw),
    participantId,
  }
}

function directory(...values: TestIdentity[]): ProjectDeviceDirectoryInspection {
  return {
    healthy: true,
    registrationCount: values.length,
    verifiedRegistrations: values.map((value) => ({
      keyId: value.keyId,
      publicKey: value.publicKey,
      participantId: value.participantId,
    })),
    devices: values.map((value) => ({
      keyId: value.keyId,
      publicKey: value.publicKey,
      fingerprint: value.keyId.replace('ed25519-sha256:', ''),
      participantIds: [value.participantId],
      registrationCount: 1,
      status: 'registered-device' as const,
    })),
    conflictingDevices: 0,
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
  }
}

function nonce(byte: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(byte))
}

function dependencies(
  value: TestIdentity,
  nonceByte: number,
  approvedAtMs = nowMs,
): ProjectRelayAdminApprovalDependencies {
  return {
    now: () => approvedAtMs,
    nonce: () => nonce(nonceByte),
    sign: async (claim: ProjectRelayAdminApprovalClaim): Promise<ProjectRelayAdminApprovalProof> => {
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'Ed25519' },
        value.keys.privateKey,
        asArrayBuffer(canonicalProjectRelayAdminApprovalClaim(claim)),
      ))
      return {
        schemaVersion: 1,
        algorithm: 'Ed25519',
        keyId: value.keyId,
        publicKey: value.publicKey,
        claim,
        signature: encodeBase64Url(signature),
      }
    },
  }
}

async function approval(
  signer: TestIdentity,
  action: RelayRemoteAdminAction,
  expectedRevision: number,
  nonceByte: number,
  approvedAtMs = nowMs,
): Promise<ProjectRelayAdminApprovalRecord> {
  return createProjectRelayAdminApprovalRecord(
    projectId,
    roomId,
    expectedRevision,
    action,
    24 * 60 * 60 * 1_000,
    dependencies(signer, nonceByte, approvedAtMs),
  )
}

function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left)
  const rightUpdate = Y.encodeStateAsUpdate(right)
  Y.applyUpdate(left, rightUpdate)
  Y.applyUpdate(right, leftUpdate)
}

describe('signed shared relay administrator approvals', () => {
  it('describes every approval-relevant action field without capability material', () => {
    const device = {
      schemaVersion: 1 as const,
      algorithm: 'Ed25519' as const,
      keyId: `ed25519-sha256:${'k'.repeat(43)}`,
      publicKey: 'p'.repeat(43),
    }
    expect(describeProjectRelayAdminApprovalAction({
      kind: 'issue', role: 'editor', expiresInSeconds: 3600, device,
    })).toBe(`issue editor; 3600 seconds; device ${device.keyId}`)
    expect(describeProjectRelayAdminApprovalAction({
      kind: 'rotate', memberId: memberA, expiresInSeconds: null, device: null,
    })).toBe(`rotate member ${memberA}; no automatic expiry; retain enrolled device`)
    expect(describeProjectRelayAdminApprovalAction({ kind: 'revoke', memberId: memberB }))
      .toBe(`revoke member ${memberB}`)
  })

  it('counts distinct registered-device approvals for one exact action without authority or capability data', async () => {
    const alice = await identity('participant-alice')
    const bob = await identity('participant-bob')
    const devices = directory(alice, bob)
    const action: RelayRemoteAdminAction = { kind: 'revoke', memberId: memberA }
    const first = await approval(alice, action, 7, 1)
    const second = await approval(bob, action, 7, 2)
    const settings = new Y.Doc().getMap('project:settings')

    await publishProjectRelayAdminApproval(settings, projectId, devices, first, nowMs)
    const inspection = await publishProjectRelayAdminApproval(
      settings, projectId, devices, second, nowMs,
    )
    const actionSha256 = await relayRemoteAdminActionSha256(action)

    expect(inspection).toMatchObject({
      healthy: true,
      approvalCount: 2,
      conflictingSigners: 0,
      expiredApprovals: 0,
    })
    expect(inspection.intents).toEqual([{
      roomId,
      expectedRevision: 7,
      actionSha256,
      action,
      activeSignerKeyIds: [alice.keyId, bob.keyId].sort(),
      activeParticipantIds: ['participant-alice', 'participant-bob'],
      approvalCount: 2,
    }])
    expect(activeProjectRelayAdminApprovalProofs(
      inspection, roomId, 7, actionSha256,
    ).map(({ keyId }) => keyId)).toEqual([alice.keyId, bob.keyId].sort())
    expect(JSON.stringify(settings.toJSON())).not.toContain('capability')
    expect(JSON.stringify(settings.toJSON())).not.toContain('private')
    expect(projectRelayAdminApprovalStorageKey(first)).toContain(':7:')
  })

  it('converges disconnected approvals and reopens the same verified intent', async () => {
    const alice = await identity('participant-alice')
    const bob = await identity('participant-bob')
    const devices = directory(alice, bob)
    const action: RelayRemoteAdminAction = { kind: 'revoke', memberId: memberA }
    const left = new Y.Doc()
    const right = new Y.Doc()
    await publishProjectRelayAdminApproval(
      left.getMap('project:settings'), projectId, devices,
      await approval(alice, action, 9, 3), nowMs,
    )
    await publishProjectRelayAdminApproval(
      right.getMap('project:settings'), projectId, devices,
      await approval(bob, action, 9, 4), nowMs,
    )

    merge(left, right)
    const leftInspection = await inspectProjectRelayAdminApprovals(
      left.getMap('project:settings'), projectId, devices, nowMs,
    )
    const rightInspection = await inspectProjectRelayAdminApprovals(
      right.getMap('project:settings'), projectId, devices, nowMs,
    )
    expect(leftInspection).toEqual(rightInspection)
    expect(leftInspection.intents[0].approvalCount).toBe(2)

    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(left))
    expect(await inspectProjectRelayAdminApprovals(
      reopened.getMap('project:settings'), projectId, devices, nowMs,
    )).toEqual(leftInspection)
  })

  it('retains but excludes one signer that equivocates at the same room revision', async () => {
    const alice = await identity('participant-alice')
    const bob = await identity('participant-bob')
    const devices = directory(alice, bob)
    const actionA: RelayRemoteAdminAction = { kind: 'revoke', memberId: memberA }
    const actionB: RelayRemoteAdminAction = { kind: 'revoke', memberId: memberB }
    const settings = new Y.Doc().getMap('project:settings')
    await publishProjectRelayAdminApproval(
      settings, projectId, devices, await approval(alice, actionA, 11, 5), nowMs,
    )
    await publishProjectRelayAdminApproval(
      settings, projectId, devices, await approval(alice, actionB, 11, 6), nowMs,
    )
    const inspection = await publishProjectRelayAdminApproval(
      settings, projectId, devices, await approval(bob, actionA, 11, 7), nowMs,
    )

    expect(inspection).toMatchObject({
      healthy: true,
      approvalCount: 3,
      conflictingSigners: 1,
    })
    expect(inspection.approvals.filter(({ state }) => state === 'signer-conflict')).toHaveLength(2)
    expect(inspection.intents).toHaveLength(1)
    expect(inspection.intents[0]).toMatchObject({
      action: actionA,
      approvalCount: 1,
      activeSignerKeyIds: [bob.keyId],
    })
  })

  it('fails closed on mutation, unknown devices, expiry, malformed records, and count overflow', async () => {
    const alice = await identity('participant-alice')
    const mallory = await identity('participant-mallory')
    const devices = directory(alice)
    const action: RelayRemoteAdminAction = { kind: 'revoke', memberId: memberA }
    const valid = await approval(alice, action, 13, 8, nowMs - 2 * 24 * 60 * 60 * 1_000)
    const settings = new Y.Doc().getMap('project:settings')
    const expired = await publishProjectRelayAdminApproval(
      settings, projectId, devices, valid, nowMs,
    )
    expect(expired).toMatchObject({ healthy: true, expiredApprovals: 1, intents: [] })

    const changed = structuredClone(valid)
    changed.proof.claim.expectedRevision += 1
    expect(parseProjectRelayAdminApprovalRecord(changed)).not.toBeNull()
    await expect(publishProjectRelayAdminApproval(
      new Y.Doc().getMap('project:settings'), projectId, devices, changed, nowMs,
    )).rejects.toThrow('proof is invalid')
    await expect(publishProjectRelayAdminApproval(
      new Y.Doc().getMap('project:settings'), projectId, devices,
      await approval(mallory, action, 13, 9), nowMs,
    )).rejects.toThrow('proof is invalid')

    const poisoned = new Y.Doc().getMap<unknown>('project:settings')
    poisoned.set(PROJECT_RELAY_ADMIN_APPROVAL_PREFIX + 'poison', { schemaVersion: 1 })
    expect(await inspectProjectRelayAdminApprovals(poisoned, projectId, devices, nowMs))
      .toMatchObject({ healthy: false, invalidRecords: 1, approvals: [] })

    const overflow = new Y.Doc().getMap<unknown>('project:settings')
    for (let index = 0; index <= MAX_PROJECT_RELAY_ADMIN_APPROVALS; index += 1) {
      overflow.set(PROJECT_RELAY_ADMIN_APPROVAL_PREFIX + index, {})
    }
    expect(await inspectProjectRelayAdminApprovals(overflow, projectId, devices, nowMs))
      .toMatchObject({ healthy: false, excessRecords: 1, approvals: [] })
  })
})
