import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type {
  ProjectResearchEventClaim,
  ProjectResearchEventKind,
  ProjectResearchEventProof,
} from '../tauri'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import {
  canonicalProjectResearchEventClaim,
  createProjectResearchEventAttestation,
  inspectProjectResearchEventAttestations,
  MAX_RESEARCH_EVENT_ATTESTATION_SETTINGS_SCAN,
  parseProjectResearchEventAttestation,
  projectResearchEventAttestationStorageKey,
  publishProjectResearchEventAttestation,
  type ProjectResearchEventAttestationDependencies,
  type ProjectResearchEventAttestationRecord,
  type ProjectResearchEventHashResolver,
} from './projectResearchEventAttestation'
import {
  castScenarioVoteWithAttribution,
  scenarioVoteAttestationResolver,
} from './researchEventAttribution'
import { createScenario } from './scenarioModel'
import { readScenarioVotes } from './scenarioVoteModel'
import type { ResearchProjectManifest } from './schema'

const projectId = 'project-research-event-attestations'
const participantA = 'participant-a'
const participantB = 'participant-b'
const hashVote = encodeBase64Url(new Uint8Array(32).fill(11))
const hashVersion = encodeBase64Url(new Uint8Array(32).fill(12))
const nonceA = encodeBase64Url(new Uint8Array(32).fill(21))
const nonceB = encodeBase64Url(new Uint8Array(32).fill(22))
const nonceC = encodeBase64Url(new Uint8Array(32).fill(23))
const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: projectId,
  documentId: 'document-research-event-attestations',
  title: 'Research event attestations',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}

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
    keyId: `ed25519-sha256:${encodeBase64Url(digest)}`,
    publicKey: encodeBase64Url(raw),
    participantId,
  }
}

function directory(values: TestIdentity[]): ProjectDeviceDirectoryInspection {
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

function dependencies(
  value: TestIdentity,
  nonce: string,
): ProjectResearchEventAttestationDependencies {
  return {
    now: () => 1_750_000_000_000,
    nonce: () => nonce,
    sign: async (claim: ProjectResearchEventClaim): Promise<ProjectResearchEventProof> => {
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'Ed25519' },
        value.keys.privateKey,
        asArrayBuffer(canonicalProjectResearchEventClaim(claim)),
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

function resolver(entries: Array<[ProjectResearchEventKind, string, string]>): ProjectResearchEventHashResolver {
  const hashes = new Map(entries.map(([kind, id, hash]) => [`${kind}:${id}`, hash]))
  return (kind, id) => hashes.get(`${kind}:${id}`) ?? null
}

async function make(
  value: TestIdentity,
  kind: ProjectResearchEventKind,
  id: string,
  hash: string,
  nonce: string,
) {
  return createProjectResearchEventAttestation(
    projectId, value.participantId, kind, id, hash, dependencies(value, nonce),
  )
}

describe('project research event attestations', () => {
  it('signs, publishes, reopens, and inspects two event domains without proof bodies', async () => {
    const signer = await identity(participantA)
    const events = resolver([
      ['scenario-vote', 'vote-1', hashVote],
      ['policy-version', 'version-1', hashVersion],
    ])
    const document = new Y.Doc()
    const settings = document.getMap<unknown>('settings')
    const vote = await make(signer, 'scenario-vote', 'vote-1', hashVote, nonceA)
    const version = await make(signer, 'policy-version', 'version-1', hashVersion, nonceB)
    await publishProjectResearchEventAttestation(settings, projectId, directory([signer]), events, vote)
    await publishProjectResearchEventAttestation(settings, projectId, directory([signer]), events, version)

    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(document))
    const inspection = await inspectProjectResearchEventAttestations(
      reopened.getMap('settings'), projectId, directory([signer]), events,
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    expect(inspection.attestations.map(({ eventKind }) => eventKind)).toEqual([
      'policy-version', 'scenario-vote',
    ])
    const encoded = JSON.stringify(inspection)
    expect(encoded).not.toContain('publicKey')
    expect(encoded).not.toContain('signature')
    expect(encoded).not.toContain(signer.publicKey)
  })

  it('converges independent installation attestations and keeps replay idempotent', async () => {
    const left = await identity(participantA)
    const right = await identity(participantB)
    const events = resolver([['scenario-vote', 'vote-1', hashVote]])
    const leftRecord = await make(left, 'scenario-vote', 'vote-1', hashVote, nonceA)
    const rightRecord = await make(right, 'scenario-vote', 'vote-1', hashVote, nonceB)
    const leftDoc = new Y.Doc()
    const rightDoc = new Y.Doc()
    await publishProjectResearchEventAttestation(
      leftDoc.getMap('settings'), projectId, directory([left, right]), events, leftRecord,
    )
    await publishProjectResearchEventAttestation(
      rightDoc.getMap('settings'), projectId, directory([left, right]), events, rightRecord,
    )
    const leftUpdate = Y.encodeStateAsUpdate(leftDoc)
    const rightUpdate = Y.encodeStateAsUpdate(rightDoc)
    Y.applyUpdate(leftDoc, rightUpdate)
    Y.applyUpdate(rightDoc, leftUpdate)

    const inspected = await inspectProjectResearchEventAttestations(
      leftDoc.getMap('settings'), projectId, directory([left, right]), events,
    )
    expect(inspected).toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    await expect(publishProjectResearchEventAttestation(
      leftDoc.getMap('settings'), projectId, directory([left, right]), events, leftRecord,
    )).resolves.toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    const resignedLeftRecord = await make(left, 'scenario-vote', 'vote-1', hashVote, nonceC)
    await expect(publishProjectResearchEventAttestation(
      leftDoc.getMap('settings'), projectId, directory([left, right]), events, resignedLeftRecord,
    )).resolves.toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    expect(Y.encodeStateVector(leftDoc)).toEqual(Y.encodeStateVector(rightDoc))
  })

  it('fails closed for mutated hashes, missing events, participant mismatch, poison, and excess settings', async () => {
    const signer = await identity(participantA)
    const events = resolver([['scenario-vote', 'vote-1', hashVote]])
    const valid = await make(signer, 'scenario-vote', 'vote-1', hashVote, nonceA)
    const changed: ProjectResearchEventAttestationRecord = {
      ...valid,
      proof: {
        ...valid.proof,
        claim: { ...valid.proof.claim, eventSha256: hashVersion },
      },
    }
    expect(parseProjectResearchEventAttestation(changed)).not.toBeNull()
    await expect(publishProjectResearchEventAttestation(
      new Y.Doc().getMap('settings'), projectId, directory([signer]), events, changed,
    )).rejects.toThrow('proof is invalid')
    await expect(publishProjectResearchEventAttestation(
      new Y.Doc().getMap('settings'), projectId, directory([signer]), resolver([]), valid,
    )).rejects.toThrow('proof is invalid')
    await expect(publishProjectResearchEventAttestation(
      new Y.Doc().getMap('settings'), projectId,
      { ...directory([signer]), devices: [{ ...directory([signer]).devices[0], participantIds: ['other'] }] },
      events,
      valid,
    )).rejects.toThrow('proof is invalid')

    const poisoned = new Y.Doc().getMap<unknown>('settings')
    poisoned.set(projectResearchEventAttestationStorageKey(valid), { ...valid, extra: true })
    await expect(inspectProjectResearchEventAttestations(
      poisoned, projectId, directory([signer]), events,
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))

    const excessive = new Y.Doc().getMap<unknown>('settings')
    for (let index = 0; index <= MAX_RESEARCH_EVENT_ATTESTATION_SETTINGS_SCAN; index += 1) {
      excessive.set(`unrelated:${index}`, index)
    }
    await expect(inspectProjectResearchEventAttestations(
      excessive, projectId, directory([signer]), events,
    )).resolves.toEqual(expect.objectContaining({ healthy: false, excessRecords: 1 }))
  })

  it('adds best-effort signed attribution to a product vote without hiding unsigned fallback', async () => {
    const signer = await identity(participantA)
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings } = getProjectSharedTypes(document)
    createScenario(scenarios, {
      id: 'scenario-1', title: 'Scenario', background: '', authorId: participantA,
      timestamp: 1, editId: 'create-scenario-1',
    })
    await expect(castScenarioVoteWithAttribution(document, 'wrong-project', {
      eventId: 'wrong-project-vote', scenarioId: 'scenario-1', participantId: participantA,
      displayName: 'Alice', choice: 'support', timestamp: 2,
    })).rejects.toThrow('Project identity does not match')
    expect(readScenarioVotes(discussions, 'scenario-1')).toBeNull()
    const signed = await castScenarioVoteWithAttribution(document, projectId, {
      eventId: 'vote-1', scenarioId: 'scenario-1', participantId: participantA,
      displayName: 'Alice', choice: 'support', timestamp: 2,
    }, {
      inspectDirectory: async () => directory([signer]),
      create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
        id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
      ),
    })
    expect(signed.attribution).toEqual(expect.objectContaining({
      status: 'signed-device',
      keyId: signer.keyId,
      eventKind: 'scenario-vote',
      attestationCount: 1,
      authority: 'installation-device-not-human-identity',
    }))
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer]), scenarioVoteAttestationResolver(discussions),
    )).resolves.toEqual(expect.objectContaining({ healthy: true, attestationCount: 1 }))

    const unsigned = await castScenarioVoteWithAttribution(document, projectId, {
      eventId: 'vote-2', scenarioId: 'scenario-1', participantId: participantA,
      displayName: 'Alice', choice: 'oppose', timestamp: 3,
    }, {
      inspectDirectory: async () => directory([signer]),
      create: async () => { throw new Error('vault unavailable') },
    })
    expect(unsigned.attribution).toEqual({
      status: 'unsigned',
      reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    })
    expect(unsigned.summary.history).toHaveLength(2)
    expect(unsigned.summary.activeVotes).toEqual([
      expect.objectContaining({ eventId: 'vote-2', choice: 'oppose' }),
    ])

    const unavailableDirectory = await castScenarioVoteWithAttribution(document, projectId, {
      eventId: 'vote-3', scenarioId: 'scenario-1', participantId: participantA,
      displayName: 'Alice', choice: 'abstain', timestamp: 4,
    }, {
      inspectDirectory: async () => { throw new Error('verification unavailable') },
      create: async () => { throw new Error('must not sign without directory inspection') },
    })
    expect(unavailableDirectory.attribution).toEqual({
      status: 'unsigned',
      reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(unavailableDirectory.summary.history).toHaveLength(3)
  })
})
