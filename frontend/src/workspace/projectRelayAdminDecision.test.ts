import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type {
  ProjectRelayAdminDecisionClaim,
  ProjectRelayAdminDecisionProof,
  RelayDeviceBinding,
} from '../tauri'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import {
  canonicalProjectRelayAdminDecisionClaim,
  createProjectRelayAdminDecisionRecord,
  inspectProjectRelayAdminDecisions,
  MAX_PROJECT_RELAY_ADMIN_DECISIONS,
  parseProjectRelayAdminDecisionRecord,
  PROJECT_RELAY_ADMIN_DECISION_PREFIX,
  projectRelayAdminDecisionStorageKey,
  publishProjectRelayAdminDecision,
  type ProjectRelayAdminDecisionDependencies,
  type ProjectRelayAdminDecisionRecord,
} from './projectRelayAdminDecision'
import type { RelayRemoteAdminAction, RelayRemoteAdminResult } from './relayRemoteAdmin'

const projectId = 'project-relay-decisions'
const roomId = 'r'.repeat(43)
const administratorMemberId = 'a'.repeat(22)
const affectedMemberId = 'm'.repeat(22)
const nonceA = encodeBase64Url(new Uint8Array(32).fill(1))
const nonceB = encodeBase64Url(new Uint8Array(32).fill(2))

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
}

async function identity(): Promise<TestIdentity> {
  const keys = await crypto.subtle.generateKey(
    { name: 'Ed25519' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(raw)))
  return {
    keys,
    keyId: `ed25519-sha256:${encodeBase64Url(digest)}`,
    publicKey: encodeBase64Url(raw),
  }
}

function directory(value: TestIdentity): ProjectDeviceDirectoryInspection {
  return {
    healthy: true,
    registrationCount: 1,
    verifiedRegistrations: [{
      keyId: value.keyId,
      publicKey: value.publicKey,
      participantId: 'participant-admin',
    }],
    devices: [{
      keyId: value.keyId,
      publicKey: value.publicKey,
      fingerprint: value.keyId.replace('ed25519-sha256:', ''),
      participantIds: ['participant-admin'],
      registrationCount: 1,
      status: 'registered-device',
    }],
    conflictingDevices: 0,
    invalidRecords: 0,
    unavailableRecords: 0,
    excessRecords: 0,
  }
}

function dependencies(value: TestIdentity, nonce = nonceA): ProjectRelayAdminDecisionDependencies {
  return {
    now: () => 1_750_000_000_000,
    nonce: () => nonce,
    sign: async (claim: ProjectRelayAdminDecisionClaim): Promise<ProjectRelayAdminDecisionProof> => {
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'Ed25519' },
        value.keys.privateKey,
        asArrayBuffer(canonicalProjectRelayAdminDecisionClaim(claim)),
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

function device(value: TestIdentity): RelayDeviceBinding {
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: value.keyId,
    publicKey: value.publicKey,
  }
}

function result(
  revision: number,
  credentialMemberId: string | null,
  resultMemberId = credentialMemberId ?? affectedMemberId,
): RelayRemoteAdminResult {
  const memberId = resultMemberId
  const revokedAtMs = credentialMemberId ? null : 1_750_000_000_000
  return {
    room: {
      schemaVersion: 3,
      registryRevision: revision,
      roomId,
      projectId,
      protected: true,
      members: [{
        memberId,
        role: 'editor',
        createdAtMs: 1,
        rotatedAtMs: null,
        expiresAtMs: null,
        capabilityGeneration: 1,
        revokedAtMs,
        deviceKeyId: `ed25519-sha256:${'d'.repeat(43)}`,
      }],
    },
    credential: credentialMemberId ? {
      schemaVersion: 3,
      roomId,
      memberId: credentialMemberId,
      role: 'editor',
      capability: 'c'.repeat(43),
      capabilityGeneration: 1,
      registryRevision: revision,
      expiresAtMs: null,
      deviceKeyId: `ed25519-sha256:${'d'.repeat(43)}`,
    } : null,
  }
}

async function record(
  value: TestIdentity,
  action: RelayRemoteAdminAction,
  expectedRevision: number,
  nonce = nonceA,
): Promise<ProjectRelayAdminDecisionRecord> {
  const credentialMemberId = action.kind === 'issue'
    ? affectedMemberId
    : action.kind === 'rotate' ? action.memberId : null
  return createProjectRelayAdminDecisionRecord(
    projectId,
    roomId,
    administratorMemberId,
    expectedRevision,
    action,
    result(
      expectedRevision + 1,
      credentialMemberId,
      action.kind === 'revoke' ? action.memberId : credentialMemberId ?? affectedMemberId,
    ),
    dependencies(value, nonce),
  )
}

function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left)
  const rightUpdate = Y.encodeStateAsUpdate(right)
  Y.applyUpdate(left, rightUpdate)
  Y.applyUpdate(right, leftUpdate)
}

describe('durable signed project relay administration decisions', () => {
  it('records an accepted mutation idempotently without persisting the relay capability', async () => {
    const signer = await identity()
    const settings = new Y.Doc().getMap('project:settings')
    const action: RelayRemoteAdminAction = {
      kind: 'issue', role: 'editor', expiresInSeconds: 3_600, device: device(signer),
    }
    const decision = await record(signer, action, 4)
    const first = await publishProjectRelayAdminDecision(settings, projectId, directory(signer), decision)
    const second = await publishProjectRelayAdminDecision(settings, projectId, directory(signer), decision)

    expect(first).toEqual(second)
    expect(first).toMatchObject({ healthy: true, decisionCount: 1, conflictingRevisions: 0 })
    expect(first.decisions[0]).toMatchObject({
      action,
      participantIds: ['participant-admin'],
      proof: { claim: { expectedRevision: 4, resultingRevision: 5, affectedMemberId } },
    })
    expect(settings.size).toBe(1)
    expect(JSON.stringify(settings.toJSON())).not.toContain('c'.repeat(43))
    expect(projectRelayAdminDecisionStorageKey(decision)).toContain(':5:ed25519-sha256:')
  })

  it('converges independent decisions and reopens the same verified offline history', async () => {
    const signer = await identity()
    const left = new Y.Doc()
    const right = new Y.Doc()
    await publishProjectRelayAdminDecision(
      left.getMap('project:settings'), projectId, directory(signer),
      await record(signer, { kind: 'revoke', memberId: affectedMemberId }, 4, nonceA),
    )
    await publishProjectRelayAdminDecision(
      right.getMap('project:settings'), projectId, directory(signer),
      await record(signer, { kind: 'revoke', memberId: 'n'.repeat(22) }, 5, nonceB),
    )
    merge(left, right)
    const leftInspection = await inspectProjectRelayAdminDecisions(
      left.getMap('project:settings'), projectId, directory(signer),
    )
    const rightInspection = await inspectProjectRelayAdminDecisions(
      right.getMap('project:settings'), projectId, directory(signer),
    )
    expect(leftInspection).toEqual(rightInspection)
    expect(leftInspection).toMatchObject({ healthy: true, decisionCount: 2, conflictingRevisions: 0 })

    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(left))
    await expect(inspectProjectRelayAdminDecisions(
      reopened.getMap('project:settings'), projectId, directory(signer),
    )).resolves.toEqual(leftInspection)
  })

  it('retains concurrent contradictory revision claims and refuses to extend that history', async () => {
    const signer = await identity()
    const left = new Y.Doc()
    const right = new Y.Doc()
    const leftDecision = await record(signer, { kind: 'revoke', memberId: affectedMemberId }, 8, nonceA)
    const rightDecision = await record(signer, { kind: 'revoke', memberId: 'n'.repeat(22) }, 8, nonceB)
    await publishProjectRelayAdminDecision(left.getMap('project:settings'), projectId, directory(signer), leftDecision)
    await publishProjectRelayAdminDecision(right.getMap('project:settings'), projectId, directory(signer), rightDecision)
    merge(left, right)

    const inspection = await inspectProjectRelayAdminDecisions(
      left.getMap('project:settings'), projectId, directory(signer),
    )
    expect(inspection).toMatchObject({ healthy: false, decisionCount: 2, conflictingRevisions: 1 })
    await expect(publishProjectRelayAdminDecision(
      left.getMap('project:settings'), projectId, directory(signer),
      await record(signer, { kind: 'revoke', memberId: 'o'.repeat(22) }, 9),
    )).rejects.toThrow('history is not safe to update')
  })

  it('rejects cross-project replay, action mutation, unregistered keys, and non-canonical encodings', async () => {
    const signer = await identity()
    const other = await identity()
    const action: RelayRemoteAdminAction = { kind: 'revoke', memberId: affectedMemberId }
    const decision = await record(signer, action, 4)
    const settings = new Y.Doc().getMap('project:settings')

    await expect(publishProjectRelayAdminDecision(settings, 'different-project', directory(signer), decision))
      .rejects.toThrow('proof is invalid')
    await expect(publishProjectRelayAdminDecision(
      settings, projectId, directory(other), decision,
    )).rejects.toThrow('proof is invalid')
    await expect(publishProjectRelayAdminDecision(settings, projectId, directory(signer), {
      ...decision,
      action: { kind: 'revoke', memberId: 'z'.repeat(22) },
    })).rejects.toThrow('proof is invalid')
    expect(parseProjectRelayAdminDecisionRecord({
      ...decision,
      proof: {
        ...decision.proof,
        claim: { ...decision.proof.claim, decisionNonce: `${decision.proof.claim.decisionNonce.slice(0, -1)}B` },
      },
    })).toBeNull()
    expect(parseProjectRelayAdminDecisionRecord({ ...decision, capability: 'must-not-be-accepted' })).toBeNull()
    expect(settings.size).toBe(0)
  })

  it('binds result shape and signer output before publication', async () => {
    const signer = await identity()
    const action: RelayRemoteAdminAction = { kind: 'revoke', memberId: affectedMemberId }
    await expect(createProjectRelayAdminDecisionRecord(
      projectId, roomId, administratorMemberId, 4, action,
      { ...result(5, null), room: { ...result(5, null).room, registryRevision: 6 } },
      dependencies(signer),
    )).rejects.toThrow('revision transition')
    await expect(createProjectRelayAdminDecisionRecord(
      projectId, roomId, administratorMemberId, 4, action, result(5, null), {
        ...dependencies(signer),
        sign: async (claim) => dependencies(signer).sign({ ...claim, affectedMemberId: 'x'.repeat(22) }),
      },
    )).rejects.toThrow('mismatched proof')
  })

  it('fails closed before verification when the decision bound is exceeded', async () => {
    const signer = await identity()
    const settings = new Y.Doc().getMap('project:settings')
    for (let index = 0; index <= MAX_PROJECT_RELAY_ADMIN_DECISIONS; index += 1) {
      settings.set(`${PROJECT_RELAY_ADMIN_DECISION_PREFIX}excess-${index}`, null)
    }
    await expect(inspectProjectRelayAdminDecisions(settings, projectId, directory(signer)))
      .resolves.toMatchObject({
        healthy: false,
        decisionCount: MAX_PROJECT_RELAY_ADMIN_DECISIONS + 1,
        excessRecords: 1,
      })
  })
})
