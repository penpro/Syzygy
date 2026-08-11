import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type {
  ProjectResearchEventClaim,
  ProjectResearchEventKind,
  ProjectResearchEventProof,
} from '../tauri'
import {
  createPluginReview,
  decidePluginReview,
  pluginReviewEventSha256,
} from '../extensions/pluginReviewModel'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
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
  type ProjectResearchEventResolver,
} from './projectResearchEventAttestation'
import {
  attestPolicyVersionEvent,
  attestPluginReviewEvent,
  attestSuggestionEvent,
  attestHeuristicCheckResultEvent,
  attestHeuristicEditEvent,
  attestHeuristicExampleEvent,
  attestScenarioAnnotationEvent,
  attestScenarioEditEvent,
  attestScenarioLabelEvent,
  attestScenarioRerunResearchEvent,
  attestScenarioTurnRevisionEvent,
  castScenarioVoteWithAttribution,
  commitScenarioAnnotationWithAttribution,
  commitScenarioEditWithAttribution,
  commitScenarioLabelWithAttribution,
  commitScenarioTurnWithAttribution,
  researchEventAttestationResolver,
  scenarioEditAttestationEventId,
  scenarioLabelAttestationEventId,
  scenarioRerunDefinitionAttestationEventId,
  scenarioTurnAttestationEventId,
  suggestionAttestationEventId,
  heuristicEditAttestationEventId,
  pluginReviewAttestationEventId,
} from './researchEventAttribution'
import {
  createScenarioAnnotation,
  readScenarioAnnotations,
  setScenarioAnnotationResolution,
  updateScenarioAnnotation,
  type ScenarioAnnotationEvent,
} from './scenarioAnnotationModel'
import {
  commitPolicyVersion,
  policyVersionEventSha256,
  readPolicyVersion,
} from './policyVersionModel'
import {
  addScenarioTurn,
  createScenario,
  readScenarioEdit,
  readScenarioTurnRevision,
  scenarioEditSha256,
  scenarioTurnRevisionSha256,
  updateScenario,
  updateScenarioTurn,
} from './scenarioModel'
import {
  createScenarioLabel,
  readScenarioLabel,
  readScenarioLabelAssignment,
  renameScenarioLabel,
  scenarioLabelAssignmentEventSha256,
  setScenarioLabelAssignment,
  type ScenarioLabelAssignmentEvent,
  type ScenarioLabelEvent,
} from './scenarioLabelModel'
import { readScenarioVotes } from './scenarioVoteModel'
import { createSuggestion, readSuggestionEvent, suggestionEventSha256 } from './suggestionModel'
import { buildHeuristicCheckRequest, HEURISTIC_CHECK_CONTRACT_VERSION } from './heuristicCheck'
import { commitHeuristicCheckResult } from './heuristicCheckResultModel'
import { createHeuristicExample } from './heuristicExampleModel'
import { createHeuristic, heuristicEditSha256 } from './heuristicsModel'
import type { ResearchProjectManifest } from './schema'
import {
  buildScenarioEvaluationRequest,
  SCENARIO_EVALUATION_CONTRACT_VERSION,
  SCENARIO_EVALUATION_PROMPT_VERSION,
} from './scenarioEvaluation'
import {
  beginScenarioRerunItem,
  completeScenarioRerunItem,
  controlScenarioRerunJob,
  createScenarioRerunJob,
  readScenarioRerunJob,
  scenarioRerunResearchEventSha256,
} from './scenarioRerunQueue'

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

function resolver(
  entries: Array<[ProjectResearchEventKind, string, string]>,
  participantId = participantA,
): ProjectResearchEventResolver {
  const hashes = new Map(entries.map(([kind, id, hash]) => [`${kind}:${id}`, hash]))
  return (kind, id) => {
    const eventSha256 = hashes.get(`${kind}:${id}`)
    return eventSha256 ? { eventSha256, participantId } : null
  }
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
  it('signs every retained scenario-rerun record class, rejects cross-author proofs, and detects tampering', async () => {
    const signer = await identity(participantA)
    const other = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, heuristics, metadata, scenarios, settings, versions } = getProjectSharedTypes(document)
    const scenario = createScenario(scenarios, {
      id: 'scenario-rerun-signed', title: 'Signed rerun', background: 'A resident needs an appeal.',
      status: 'ready', authorId: participantA, timestamp: 1, editId: 'scenario-rerun-create',
      turns: [{ id: 'scenario-rerun-turn', role: 'user', content: 'How do I appeal?', editId: 'scenario-rerun-turn-create' }],
    })
    const version = await commitPolicyVersion(versions, metadata, {
      projectId, expectedHeadVersionId: null,
      blocks: [{ kind: 'policy', policyId: 'appeal', status: 'approved', text: 'Give written appeal instructions.' }],
      scenarioIds: [scenario.id], participantId: participantA, displayName: 'Alice', createdAt: 2,
    })
    const created = createScenarioRerunJob(settings, {
      jobId: 'scenario-rerun-job-signed', project: manifest, policyVersion: version,
      providerId: 'local', requestedModelId: 'local-fixture',
      items: [{
        itemId: 'scenario-rerun-item-signed', scenario,
        runIdBase: 'scenario-rerun-run-signed', resultId: 'scenario-rerun-result-signed',
      }],
      authorId: participantA, authorDisplayName: 'Alice', timestamp: 3,
    })
    const definitionRecord = { recordType: 'definition' as const, definition: created.definition }
    await expect(attestScenarioRerunResearchEvent(document, projectId, definitionRecord, {
      inspectDirectory: async () => directory([signer, other]),
      create: async () => { throw new Error('device vault unavailable') },
    })).resolves.toEqual({
      status: 'unsigned', reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    })
    expect(readScenarioRerunJob(settings, discussions, created.definition.jobId)?.status).toBe('paused')

    const started = controlScenarioRerunJob(settings, discussions, {
      eventId: 'scenario-rerun-control-signed', jobId: created.definition.jobId, action: 'start',
      parentEventId: null, authorId: participantA, timestamp: 4,
    })
    const begun = beginScenarioRerunItem(settings, discussions, {
      eventId: 'scenario-rerun-begin-signed', jobId: created.definition.jobId,
      itemId: 'scenario-rerun-item-signed', expectedCurrentEventId: null,
      attempt: 1, authorId: participantA, timestamp: 5,
    })
    const request = buildScenarioEvaluationRequest({
      jobId: created.definition.jobId, itemId: 'scenario-rerun-item-signed', attempt: 1,
      runId: 'scenario-rerun-run-signed-a1', providerId: 'local', requestedModelId: 'local-fixture',
      project: manifest, policyVersion: version, scenario,
    })
    const completed = await completeScenarioRerunItem(document, request, {
      contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
      promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
      jobId: request.jobId, itemId: request.itemId, attempt: request.attempt, runId: request.runId,
      providerId: request.providerId, requestedModelId: request.requestedModelId,
      executedModelId: 'local-fixture', outcome: 'handled', response: 'Use the written appeal path.',
      rationale: 'The policy expressly requires instructions.', uncertainty: 'No deadline is specified.',
    }, {
      eventId: 'scenario-rerun-complete-signed', resultId: 'scenario-rerun-result-signed',
      authorId: participantA, authorDisplayName: 'Alice', timestamp: 6,
    })
    const records = [
      definitionRecord,
      { recordType: 'control' as const, event: started.controls[0] },
      { recordType: 'item' as const, event: begun.itemEvents[0] },
      { recordType: 'item' as const, event: completed.itemEvents.find(({ action }) => action === 'complete')! },
      { recordType: 'result' as const, result: completed.items[0].result! },
    ]
    const dependenciesFor = (value: TestIdentity) => ({
      inspectDirectory: async () => directory([signer, other]),
      create: (id: string, participantId: string, kind: ProjectResearchEventKind, eventId: string, hash: string) =>
        createProjectResearchEventAttestation(id, participantId, kind, eventId, hash, dependencies(value, nonceA)),
    })
    for (const record of records) {
      await expect(attestScenarioRerunResearchEvent(
        document, projectId, record, dependenciesFor(signer),
      )).resolves.toEqual(expect.objectContaining({ status: 'signed-device', eventKind: 'scenario-rerun' }))
    }
    const resolver = researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics)
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, other]), resolver,
    )).resolves.toEqual(expect.objectContaining({ healthy: true, attestationCount: 5 }))

    const definitionEventId = scenarioRerunDefinitionAttestationEventId(created.definition)
    const forged = await make(
      other, 'scenario-rerun', definitionEventId,
      await scenarioRerunResearchEventSha256(definitionRecord), nonceB,
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, other]), resolver, forged,
    )).rejects.toThrow('proof is invalid')

    const resultBucket = Array.from(discussions.values()).find((value) =>
      value instanceof Y.Map && value.get('jobId') === created.definition.jobId,
    )
    if (!(resultBucket instanceof Y.Map)) throw new Error('Scenario rerun result bucket fixture missing')
    const resultMap = resultBucket.get('results')
    if (!(resultMap instanceof Y.Map)) throw new Error('Scenario rerun result map fixture missing')
    const resultEntry = Array.from(resultMap.entries()).find(([, value]) =>
      typeof value === 'object' && value !== null &&
      (value as { resultId?: unknown }).resultId === 'scenario-rerun-result-signed',
    )
    if (!resultEntry) throw new Error('Scenario rerun result fixture missing')
    resultMap.set(resultEntry[0], {
      ...(resultEntry[1] as Record<string, unknown>), rationale: 'Tampered retained rationale.',
    })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, other]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('signs retained heuristic edits, examples, and check results and rejects a cross-author edit', async () => {
    const signer = await identity(participantA)
    const other = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, heuristics, settings, versions, scenarios } = getProjectSharedTypes(document)
    const heuristic = createHeuristic(heuristics, {
      id: 'heuristic-signed', title: 'Evidence', guidance: 'Cite evidence.', priority: 'required',
      authorId: participantA, timestamp: 1, editId: 'heuristic-create-signed',
    })
    const edit = heuristic.edits[0]
    const example = createHeuristicExample(discussions, heuristics, {
      eventId: 'example-event-signed', exampleId: 'example-signed', heuristicId: heuristic.id,
      polarity: 'positive', body: 'A supported claim.', participantId: participantA,
      displayName: 'Alice', timestamp: 2,
    })
    const blocks = [{ kind: 'policy' as const, policyId: 'rule', status: 'review' as const, text: 'Every claim cites evidence.' }]
    const request = buildHeuristicCheckRequest({
      runId: 'heuristic-run-signed', providerId: 'local', requestedModelId: 'model-fixture',
      project: manifest, heuristic, examples: [example], blocks,
    })
    const quote = 'Every claim cites evidence.'
    const start = request.policyText.indexOf(quote)
    const result = commitHeuristicCheckResult(document, request, {
      contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION, runId: request.runId,
      providerId: request.providerId, requestedModelId: request.requestedModelId,
      executedModelId: 'model-fixture', verdict: 'pass', rationale: 'The rule is explicit.',
      uncertainty: 'Source quality is separate.', citations: [{ start, end: start + quote.length, quote }],
    }, {
      resultId: 'heuristic-result-signed', authorId: participantA,
      authorDisplayName: 'Alice', timestamp: 3, currentBlocks: blocks,
    })
    const dependenciesFor = (value: TestIdentity, nonce: string) => ({
      inspectDirectory: async () => directory([signer, other]),
      create: (id: string, participantId: string, kind: ProjectResearchEventKind, eventId: string, hash: string) =>
        createProjectResearchEventAttestation(id, participantId, kind, eventId, hash, dependencies(value, nonce)),
    })
    await expect(attestHeuristicEditEvent(
      document, projectId, heuristic.id, edit, dependenciesFor(signer, nonceA),
    )).resolves.toEqual(expect.objectContaining({ status: 'signed-device', eventKind: 'heuristic' }))
    await expect(attestHeuristicExampleEvent(
      document, projectId, example.events[0], dependenciesFor(signer, nonceB),
    )).resolves.toEqual(expect.objectContaining({ status: 'signed-device', eventKind: 'heuristic' }))
    await expect(attestHeuristicCheckResultEvent(
      document, projectId, result, dependenciesFor(signer, nonceC),
    )).resolves.toEqual(expect.objectContaining({ status: 'signed-device', eventKind: 'heuristic' }))
    const resolver = researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics)
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, other]), resolver,
    )).resolves.toEqual(expect.objectContaining({ healthy: true, attestationCount: 3 }))

    const editEventId = heuristicEditAttestationEventId(heuristic.id, edit)
    const forged = await make(other, 'heuristic', editEventId,
      await heuristicEditSha256(heuristic.id, edit), nonceA)
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, other]), resolver, forged,
    )).rejects.toThrow('proof is invalid')
  })

  it('signs an exact retained suggestion event and rejects a cross-author proof', async () => {
    const signer = await identity(participantA)
    const other = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, settings, versions, scenarios } = getProjectSharedTypes(document)
    const suggestion = createSuggestion(discussions, {
      suggestionId: 'suggestion-signed',
      eventId: 'proposal-signed',
      content: 'Exact proposal body canary',
      sourceDocumentRevision: 'document-revision-1',
      authorId: participantA,
      authorDisplayName: 'Alice',
      timestamp: 1,
    })
    const eventId = suggestionAttestationEventId(suggestion.proposal)
    const signed = await attestSuggestionEvent(document, projectId, suggestion.proposal, {
      inspectDirectory: async () => directory([signer, other]),
      create: (id, participantId, kind, retainedId, hash) => createProjectResearchEventAttestation(
        id, participantId, kind, retainedId, hash, dependencies(signer, nonceA),
      ),
    })
    expect(signed).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'suggestion', eventId, attestationCount: 1,
    }))

    const resolver = researchEventAttestationResolver(discussions, settings, versions, scenarios)
    await expect(resolver('suggestion', eventId)).resolves.toEqual({
      eventSha256: await suggestionEventSha256(suggestion.proposal),
      participantId: participantA,
    })
    const forged = await make(
      other, 'suggestion', eventId, await suggestionEventSha256(suggestion.proposal), nonceB,
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, other]), resolver, forged,
    )).rejects.toThrow('proof is invalid')

    const bucket = Array.from(discussions.entries()).find(([key]) =>
      key.startsWith('suggestions:v1:'),
    )?.[1]
    if (!(bucket instanceof Y.Map)) throw new Error('Suggestion bucket fixture missing')
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Suggestion event fixture missing')
    const proposalEntry = Array.from(events.entries()).find(([, value]) =>
      typeof value === 'object' && value !== null &&
      (value as { eventId?: unknown }).eventId === suggestion.proposal.eventId,
    )
    if (!proposalEntry) throw new Error('Suggestion proposal fixture missing')
    events.set(proposalEntry[0], { ...suggestion.proposal, content: 'Changed retained proposal body' })
    await expect(inspectProjectResearchEventAttestations(
      settings,
      projectId,
      directory([signer, other]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('keeps a committed suggestion when device signing is unavailable', async () => {
    const signer = await identity(participantA)
    const document = createProjectDocument(manifest)
    const { discussions } = getProjectSharedTypes(document)
    const suggestion = createSuggestion(discussions, {
      suggestionId: 'suggestion-unsigned', eventId: 'proposal-unsigned',
      content: 'Proposal survives signer failure', sourceDocumentRevision: 'draft-unsigned',
      authorId: participantA, authorDisplayName: 'Alice', timestamp: 2,
    })
    const result = await attestSuggestionEvent(document, projectId, suggestion.proposal, {
      inspectDirectory: async () => directory([signer]),
      create: async () => { throw new Error('vault unavailable') },
    })
    expect(result).toEqual({
      status: 'unsigned',
      reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    })
    expect(readSuggestionEvent(discussions, suggestion.id, suggestion.proposal.eventId)).toEqual(
      suggestion.proposal,
    )
  })

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
    const right = await identity(participantA)
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
    await expect(publishProjectResearchEventAttestation(
      new Y.Doc().getMap('settings'), projectId, directory([signer]),
      resolver([['scenario-vote', 'vote-1', hashVote]], participantB), valid,
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
      settings, projectId, directory([signer]), researchEventAttestationResolver(discussions, settings),
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

  it('signs exact create, edit, resolve, and reopen annotation events without returning bodies', async () => {
    const signer = await identity(participantA)
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings } = getProjectSharedTypes(document)
    createScenario(scenarios, {
      id: 'scenario-annotation-1', title: 'Scenario', background: '', authorId: participantA,
      timestamp: 1, editId: 'create-scenario-annotation-1',
    })
    const createInput = {
      annotationId: 'annotation-1', eventId: 'annotation-create-1', scenarioId: 'scenario-annotation-1',
      kind: 'note' as const, body: 'Body canary that inspection must omit', authorId: participantA,
      displayName: 'Alice', timestamp: 2,
    }
    await expect(commitScenarioAnnotationWithAttribution(
      document, 'wrong-project', () => {
        const created = createScenarioAnnotation(discussions, scenarios, createInput)
        return created.events.find(({ eventId }) => eventId === createInput.eventId)!
      },
    )).rejects.toThrow('Project identity does not match')
    expect(readScenarioAnnotations(discussions, 'scenario-annotation-1')).toEqual([])
    const created = await commitScenarioAnnotationWithAttribution(
      document,
      projectId,
      () => {
        const annotation = createScenarioAnnotation(discussions, scenarios, createInput)
        return annotation.events.find(({ eventId }) => eventId === createInput.eventId)!
      },
      {
        inspectDirectory: async () => directory([signer]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
        ),
      },
    )
    expect(created.attribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'scenario-annotation', attestationCount: 1,
    }))
    const records: ScenarioAnnotationEvent[] = []
    let annotation = readScenarioAnnotations(discussions, 'scenario-annotation-1')![0]
    annotation = updateScenarioAnnotation(discussions, scenarios, {
      annotationId: annotation.id, eventId: 'annotation-edit-1', scenarioId: annotation.scenarioId,
      expectedCurrentEventId: annotation.currentEventId, body: 'Revised body canary',
      authorId: participantA, displayName: 'Alice', timestamp: 3,
    })
    records.push(annotation.events.find(({ eventId }) => eventId === 'annotation-edit-1')!)
    annotation = setScenarioAnnotationResolution(discussions, scenarios, {
      annotationId: annotation.id, eventId: 'annotation-resolve-1', scenarioId: annotation.scenarioId,
      expectedCurrentEventId: annotation.currentEventId, resolved: true,
      authorId: participantA, displayName: 'Alice', timestamp: 4,
    })
    records.push(annotation.events.find(({ eventId }) => eventId === 'annotation-resolve-1')!)
    annotation = setScenarioAnnotationResolution(discussions, scenarios, {
      annotationId: annotation.id, eventId: 'annotation-reopen-1', scenarioId: annotation.scenarioId,
      expectedCurrentEventId: annotation.currentEventId, resolved: false,
      authorId: participantA, displayName: 'Alice', timestamp: 5,
    })
    records.push(annotation.events.find(({ eventId }) => eventId === 'annotation-reopen-1')!)

    for (let index = 0; index < records.length; index += 1) {
      await expect(attestScenarioAnnotationEvent(document, projectId, records[index], {
        inspectDirectory: async () => directory([signer]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash,
          dependencies(signer, encodeBase64Url(new Uint8Array(32).fill(30 + index))),
        ),
      })).resolves.toEqual(expect.objectContaining({
        status: 'signed-device', eventKind: 'scenario-annotation', attestationCount: index + 2,
      }))
    }
    const inspection = await inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer]), researchEventAttestationResolver(discussions, settings),
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 4 }))
    expect(JSON.stringify(inspection)).not.toContain('Body canary')
    expect(JSON.stringify(inspection)).not.toContain('Revised body canary')

    const unsigned = await commitScenarioAnnotationWithAttribution(
      document,
      projectId,
      () => {
        const added = createScenarioAnnotation(discussions, scenarios, {
          ...createInput,
          annotationId: 'annotation-unsigned',
          eventId: 'annotation-create-unsigned',
          body: 'Unsigned body remains committed',
          timestamp: 6,
        })
        return added.events.find(({ eventId }) => eventId === 'annotation-create-unsigned')!
      },
      {
        inspectDirectory: async () => { throw new Error('directory unavailable') },
        create: async () => { throw new Error('must not sign') },
      },
    )
    expect(unsigned.attribution).toEqual({
      status: 'unsigned',
      reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(readScenarioAnnotations(discussions, 'scenario-annotation-1')).toHaveLength(2)

    const annotationBucket = Array.from(discussions.values()).find((value) =>
      value instanceof Y.Map && value.get('scenarioId') === 'scenario-annotation-1') as Y.Map<unknown>
    const annotationEvents = annotationBucket.get('events') as Y.Map<ScenarioAnnotationEvent>
    const createStorageKey = Array.from(annotationEvents.entries())
      .find(([, event]) => event.eventId === 'annotation-create-1')![0]
    annotationEvents.set(createStorageKey, { ...created.event, body: 'Mutated retained body' })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer]), researchEventAttestationResolver(discussions, settings),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('signs exact label create, rename, assignment, and removal events without returning names', async () => {
    const signer = await identity(participantA)
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings } = getProjectSharedTypes(document)
    createScenario(scenarios, {
      id: 'scenario-label-1', title: 'Scenario', background: '', authorId: participantA,
      timestamp: 1, editId: 'create-scenario-label-1',
    })
    await expect(commitScenarioLabelWithAttribution(document, 'wrong-project', () => {
      const label = createScenarioLabel(settings, {
        labelId: 'label-wrong', eventId: 'label-wrong-create', name: 'Must not commit',
        authorId: participantA, timestamp: 2,
      })
      return label.events[0]
    })).rejects.toThrow('Project identity does not match')
    expect(readScenarioLabel(settings, 'label-wrong')).toBeNull()

    let mutationOnlyRevision = ''
    const created = await commitScenarioLabelWithAttribution(document, projectId, () => {
      const label = createScenarioLabel(settings, {
        labelId: 'label-1', eventId: 'label-create-1', name: 'Label name canary',
        authorId: participantA, timestamp: 2,
      })
      mutationOnlyRevision = projectStateFingerprint(document)
      return label.events.find(({ eventId }) => eventId === 'label-create-1')!
    }, {
      inspectDirectory: async () => directory([signer]),
      create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
        id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
      ),
    })
    expect(created.attribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'scenario-label', attestationCount: 1,
      eventId: 'l:7:label-1label-create-1',
    }))
    expect(projectStateFingerprint(document)).not.toBe(mutationOnlyRevision)

    const events: Array<ScenarioLabelEvent | ScenarioLabelAssignmentEvent> = []
    let label = renameScenarioLabel(settings, {
      labelId: 'label-1', eventId: 'label-rename-1', expectedCurrentEventId: 'label-create-1',
      name: 'Renamed label canary', authorId: participantA, timestamp: 3,
    })
    events.push(label.events.find(({ eventId }) => eventId === 'label-rename-1')!)
    let assignment = setScenarioLabelAssignment(settings, scenarios, {
      scenarioId: 'scenario-label-1', labelId: 'label-1', eventId: 'label-add-1',
      expectedCurrentEventId: null, assigned: true, authorId: participantA, timestamp: 4,
    })
    events.push(assignment.events.find(({ eventId }) => eventId === 'label-add-1')!)
    assignment = setScenarioLabelAssignment(settings, scenarios, {
      scenarioId: 'scenario-label-1', labelId: 'label-1', eventId: 'label-remove-1',
      expectedCurrentEventId: assignment.currentEventId, assigned: false,
      authorId: participantA, timestamp: 5,
    })
    events.push(assignment.events.find(({ eventId }) => eventId === 'label-remove-1')!)

    for (let index = 0; index < events.length; index += 1) {
      await expect(attestScenarioLabelEvent(document, projectId, events[index], {
        inspectDirectory: async () => directory([signer]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash,
          dependencies(signer, encodeBase64Url(new Uint8Array(32).fill(40 + index))),
        ),
      })).resolves.toEqual(expect.objectContaining({
        status: 'signed-device', eventKind: 'scenario-label', attestationCount: index + 2,
      }))
    }
    const inspection = await inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer]), researchEventAttestationResolver(discussions, settings),
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 4 }))
    expect(JSON.stringify(inspection)).not.toContain('Label name canary')
    expect(JSON.stringify(inspection)).not.toContain('Renamed label canary')

    const unsigned = await commitScenarioLabelWithAttribution(document, projectId, () => {
      const added = createScenarioLabel(settings, {
        labelId: 'label-unsigned', eventId: 'label-create-unsigned', name: 'Unsigned remains',
        authorId: participantA, timestamp: 6,
      })
      return added.events[0]
    }, {
      inspectDirectory: async () => { throw new Error('directory unavailable') },
      create: async () => { throw new Error('must not sign') },
    })
    expect(unsigned.attribution).toEqual({
      status: 'unsigned', reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(readScenarioLabel(settings, 'label-unsigned')).not.toBeNull()

    const assignmentBucket = Array.from(settings.values()).find((value) => value instanceof Y.Map &&
      value.get('scenarioId') === 'scenario-label-1' && value.get('labelId') === 'label-1') as Y.Map<unknown>
    const assignmentEvents = assignmentBucket.get('events') as Y.Map<ScenarioLabelAssignmentEvent>
    const assignmentStorageKey = Array.from(assignmentEvents.entries())
      .find(([, event]) => event.eventId === 'label-add-1')![0]
    const retained = readScenarioLabelAssignment(settings, 'scenario-label-1', 'label-1')!
      .events.find(({ eventId }) => eventId === 'label-add-1')!
    assignmentEvents.set(assignmentStorageKey, { ...retained, authorId: participantB })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer]), researchEventAttestationResolver(discussions, settings),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('resolves a maximum-length label assignment locator without truncating identity', async () => {
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings } = getProjectSharedTypes(document)
    const scenarioId = `s${'x'.repeat(199)}`
    const labelId = `l${'y'.repeat(199)}`
    const eventId = `e${'z'.repeat(199)}`
    createScenario(scenarios, {
      id: scenarioId, title: 'Maximum locator', background: '', authorId: participantA,
      timestamp: 1, editId: 'create-maximum-locator',
    })
    createScenarioLabel(settings, {
      labelId, eventId: 'create-maximum-label', name: 'Maximum label',
      authorId: participantA, timestamp: 2,
    })
    const assignment = setScenarioLabelAssignment(settings, scenarios, {
      scenarioId, labelId, eventId, expectedCurrentEventId: null, assigned: true,
      authorId: participantA, timestamp: 3,
    })
    const retained = assignment.events[0]
    const locator = scenarioLabelAttestationEventId(retained)
    expect(locator.length).toBeLessThanOrEqual(1024)
    await expect(researchEventAttestationResolver(discussions, settings)(
      'scenario-label', locator,
    )).resolves.toEqual({
      eventSha256: await scenarioLabelAssignmentEventSha256(retained),
      participantId: participantA,
    })
  })

  it('signs exact immutable policy-version envelopes and rejects cross-author claims', async () => {
    const signer = await identity(participantA)
    const otherSigner = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, metadata, settings, versions } = getProjectSharedTypes(document)
    const first = await commitPolicyVersion(versions, metadata, {
      projectId,
      expectedHeadVersionId: null,
      blocks: [{ kind: 'policy', policyId: 'policy-1', status: 'review', text: 'Policy body canary' }],
      scenarioIds: [],
      participantId: participantA,
      displayName: 'Alice canary',
      createdAt: 10,
      note: 'Version note canary',
    })
    const signed = await attestPolicyVersionEvent(document, projectId, first, {
      inspectDirectory: async () => directory([signer, otherSigner]),
      create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
        id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
      ),
    })
    expect(signed).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'policy-version', eventId: first.versionId,
      attestationCount: 1,
    }))
    const inspection = await inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions),
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 1 }))
    expect(JSON.stringify(inspection)).not.toContain('Policy body canary')
    expect(JSON.stringify(inspection)).not.toContain('Version note canary')
    expect(JSON.stringify(inspection)).not.toContain('Alice canary')

    const crossAuthor = await createProjectResearchEventAttestation(
      projectId, participantB, 'policy-version', first.versionId,
      await policyVersionEventSha256(first), dependencies(otherSigner, nonceB),
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions), crossAuthor,
    )).rejects.toThrow('proof is invalid')

    const second = await commitPolicyVersion(versions, metadata, {
      projectId,
      expectedHeadVersionId: first.versionId,
      blocks: [{ kind: 'policy', policyId: 'policy-1', status: 'approved', text: 'Approved body' }],
      scenarioIds: [],
      participantId: participantA,
      displayName: 'Alice',
      createdAt: 11,
      note: 'Unsigned version remains',
    })
    const unsigned = await attestPolicyVersionEvent(document, projectId, second, {
      inspectDirectory: async () => { throw new Error('directory unavailable') },
      create: async () => { throw new Error('must not sign') },
    })
    expect(unsigned).toEqual({
      status: 'unsigned', reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(await readPolicyVersion(versions, second.versionId)).not.toBeNull()

    const stored = JSON.parse(versions.get(first.versionId) as string) as Record<string, unknown>
    versions.set(first.versionId, JSON.stringify({ ...stored, note: 'Mutated signed version' }))
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('signs exact scenario create/edit/status records and rejects cross-author or changed records', async () => {
    const signer = await identity(participantA)
    const otherSigner = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings, versions } = getProjectSharedTypes(document)
    const created = await commitScenarioEditWithAttribution(
      document, projectId, 'scenario-attribution', 'scenario-create-edit',
      () => createScenario(scenarios, {
        id: 'scenario-attribution', title: 'Scenario title canary',
        background: 'Scenario background canary', authorId: participantA,
        timestamp: 1, editId: 'scenario-create-edit',
      }),
      {
        inspectDirectory: async () => directory([signer, otherSigner]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
        ),
      },
    )
    expect(created.attribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'scenario', attestationCount: 1,
    }))
    const createEdit = readScenarioEdit(scenarios, 'scenario-attribution', 'scenario-create-edit')!
    expect(created.edit).toEqual(createEdit)
    expect(created.attribution).toEqual(expect.objectContaining({
      eventId: scenarioEditAttestationEventId('scenario-attribution', createEdit),
      eventSha256: await scenarioEditSha256(createEdit),
    }))

    const edited = await commitScenarioEditWithAttribution(
      document, projectId, 'scenario-attribution', 'scenario-update-edit',
      () => updateScenario(scenarios, {
        id: 'scenario-attribution', authorId: participantA, timestamp: 2,
        editId: 'scenario-update-edit', changes: { title: 'Edited title canary', status: 'ready' },
      }),
      {
        inspectDirectory: async () => directory([signer, otherSigner]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(signer, nonceB),
        ),
      },
    )
    expect(edited.attribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'scenario', attestationCount: 2,
    }))

    const unsigned = await commitScenarioEditWithAttribution(
      document, projectId, 'scenario-attribution', 'scenario-unsigned-edit',
      () => updateScenario(scenarios, {
        id: 'scenario-attribution', authorId: participantA, timestamp: 3,
        editId: 'scenario-unsigned-edit', changes: { status: 'archived' },
      }),
      {
        inspectDirectory: async () => { throw new Error('directory unavailable') },
        create: async () => { throw new Error('must not sign') },
      },
    )
    expect(unsigned.attribution).toEqual({
      status: 'unsigned', reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(readScenarioEdit(
      scenarios, 'scenario-attribution', 'scenario-unsigned-edit',
    )).not.toBeNull()

    const resolver = researchEventAttestationResolver(discussions, settings, versions, scenarios)
    const inspection = await inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]), resolver,
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    expect(JSON.stringify(inspection)).not.toContain('Scenario title canary')
    expect(JSON.stringify(inspection)).not.toContain('Scenario background canary')
    expect(JSON.stringify(inspection)).not.toContain('Edited title canary')

    const editedRecord = readScenarioEdit(scenarios, 'scenario-attribution', 'scenario-update-edit')!
    const crossAuthor = await createProjectResearchEventAttestation(
      projectId, participantB, 'scenario',
      scenarioEditAttestationEventId('scenario-attribution', editedRecord),
      await scenarioEditSha256(editedRecord), dependencies(otherSigner, nonceC),
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios), crossAuthor,
    )).rejects.toThrow('proof is invalid')

    const scenarioRecord = Array.from(scenarios.values()).find(
      (value) => value instanceof Y.Map && value.get('id') === 'scenario-attribution',
    ) as Y.Map<unknown>
    const edits = scenarioRecord.get('edits') as Y.Map<unknown>
    const [storageKey, stored] = Array.from(edits.entries()).find(
      ([, value]) => !!value && typeof value === 'object' &&
        (value as { editId?: string }).editId === 'scenario-update-edit',
    )!
    edits.set(storageKey, {
      ...(stored as object), changes: { title: 'Changed retained scenario edit', status: 'ready' },
    })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))

    const detached = readScenarioEdit(scenarios, 'scenario-attribution', 'scenario-create-edit')!
    await expect(attestScenarioEditEvent(
      document, projectId, 'scenario-attribution', detached,
      {
        inspectDirectory: async () => directory([signer, otherSigner]),
        create: async () => { throw new Error('signing unavailable') },
      },
    )).resolves.toEqual(expect.objectContaining({ status: 'unsigned' }))
  })

  it('signs exact scenario-turn revisions and rejects cross-author or changed retained bodies', async () => {
    const signer = await identity(participantA)
    const otherSigner = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, scenarios, settings, versions } = getProjectSharedTypes(document)
    createScenario(scenarios, {
      id: 'scenario-turn-attribution', title: 'Turn attribution', background: '',
      authorId: participantA, timestamp: 1, editId: 'scenario-root-edit',
    })
    const created = await commitScenarioTurnWithAttribution(
      document, projectId, 'scenario-turn-attribution', 'turn-attributed', 'turn-create-edit',
      () => addScenarioTurn(scenarios, {
        scenarioId: 'scenario-turn-attribution', turnId: 'turn-attributed', role: 'user',
        content: 'Turn body canary', authorId: participantA, timestamp: 2,
        editId: 'turn-create-edit',
      }),
      {
        inspectDirectory: async () => directory([signer, otherSigner]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(signer, nonceA),
        ),
      },
    )
    expect(created.attribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'scenario-turn', attestationCount: 1,
    }))
    const revision = readScenarioTurnRevision(
      scenarios, 'scenario-turn-attribution', 'turn-attributed', 'turn-create-edit',
    )!
    expect(created.revision).toEqual(revision)
    expect(created.attribution).toEqual(expect.objectContaining({
      eventId: scenarioTurnAttestationEventId(
        'scenario-turn-attribution', 'turn-attributed', revision,
      ),
      eventSha256: await scenarioTurnRevisionSha256(revision),
    }))

    const editedScenario = updateScenarioTurn(scenarios, {
      scenarioId: 'scenario-turn-attribution', turnId: 'turn-attributed', role: 'assistant',
      content: 'Edited turn canary', authorId: participantA, timestamp: 3,
      editId: 'turn-edit-event', expectedCurrentEditId: 'turn-create-edit',
    })
    const edited = editedScenario.turns[0].revisions.find(({ editId }) => editId === 'turn-edit-event')!
    const editedAttribution = await attestScenarioTurnRevisionEvent(
      document, projectId, 'scenario-turn-attribution', 'turn-attributed', edited,
      {
        inspectDirectory: async () => directory([signer, otherSigner]),
        create: (id, participantId, kind, eventId, hash) => createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(signer, nonceB),
        ),
      },
    )
    expect(editedAttribution).toEqual(expect.objectContaining({ status: 'signed-device', attestationCount: 2 }))
    const unsigned = await commitScenarioTurnWithAttribution(
      document, projectId, 'scenario-turn-attribution', 'turn-unsigned', 'turn-unsigned-edit',
      () => addScenarioTurn(scenarios, {
        scenarioId: 'scenario-turn-attribution', turnId: 'turn-unsigned', role: 'system',
        content: 'Unsigned turn remains', authorId: participantA, timestamp: 4,
        editId: 'turn-unsigned-edit',
      }),
      {
        inspectDirectory: async () => { throw new Error('directory unavailable') },
        create: async () => { throw new Error('must not sign') },
      },
    )
    expect(unsigned.attribution).toEqual({
      status: 'unsigned', reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    })
    expect(readScenarioTurnRevision(
      scenarios, 'scenario-turn-attribution', 'turn-unsigned', 'turn-unsigned-edit',
    )).not.toBeNull()
    const inspection = await inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios),
    )
    expect(inspection).toEqual(expect.objectContaining({ healthy: true, attestationCount: 2 }))
    expect(JSON.stringify(inspection)).not.toContain('Turn body canary')
    expect(JSON.stringify(inspection)).not.toContain('Edited turn canary')

    const crossAuthor = await createProjectResearchEventAttestation(
      projectId, participantB, 'scenario-turn',
      scenarioTurnAttestationEventId('scenario-turn-attribution', 'turn-attributed', edited),
      await scenarioTurnRevisionSha256(edited), dependencies(otherSigner, nonceC),
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios), crossAuthor,
    )).rejects.toThrow('proof is invalid')

    const scenarioRecord = Array.from(scenarios.values()).find(
      (value) => value instanceof Y.Map && value.get('id') === 'scenario-turn-attribution',
    ) as Y.Map<unknown>
    const turns = scenarioRecord.get('turns') as Y.Map<unknown>
    const turn = Array.from(turns.values()).find(
      (value) => value instanceof Y.Map && value.get('id') === 'turn-attributed',
    ) as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<unknown>
    const [storageKey, stored] = Array.from(revisions.entries()).find(
      ([, value]) => !!value && typeof value === 'object' && (value as { editId?: string }).editId === 'turn-edit-event',
    )!
    revisions.set(storageKey, { ...(stored as object), content: 'Changed retained turn body' })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([signer, otherSigner]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })

  it('signs exact plugin proposal and decision events and detects cross-author or changed bodies', async () => {
    const runner = await identity(participantA)
    const reviewer = await identity(participantB)
    const document = createProjectDocument(manifest)
    const { discussions, heuristics, scenarios, settings, versions } = getProjectSharedTypes(document)
    const review = createPluginReview(discussions, {
      reviewId: 'plugin-review-signed', eventId: 'plugin-proposal-signed',
      pluginVersion: '1.0.0', componentSha256: 'a'.repeat(64), contributionId: 'review',
      proposal: {
        proposalVersion: 1, proposalId: 'plugin-output-signed', pluginId: 'org.example.signed',
        projectId, expectedRevision: 'document-revision-1', summary: 'Signed proposal',
        content: 'Exact plugin proposal body canary', operation: 'append',
      },
      runnerId: participantA, runnerDisplayName: 'Alice', timestamp: 1,
    })
    const dependenciesFor = (value: TestIdentity, nonce: string) => ({
      inspectDirectory: async () => directory([runner, reviewer]),
      create: (id: string, participantId: string, kind: ProjectResearchEventKind, eventId: string, hash: string) =>
        createProjectResearchEventAttestation(
          id, participantId, kind, eventId, hash, dependencies(value, nonce),
        ),
    })
    const proposalAttribution = await attestPluginReviewEvent(
      document, projectId, review.proposal, dependenciesFor(runner, nonceA),
    )
    expect(proposalAttribution).toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'plugin-review',
      eventId: pluginReviewAttestationEventId(review.proposal),
      eventSha256: await pluginReviewEventSha256(review.proposal),
    }))

    const decided = decidePluginReview(discussions, {
      reviewId: review.id, eventId: 'plugin-decision-signed',
      expectedProposalEventId: review.proposal.eventId, decision: 'accepted',
      reviewerId: participantB, reviewerDisplayName: 'Bob', timestamp: 2,
    })
    const decision = decided.decisions[0]
    await expect(attestPluginReviewEvent(
      document, projectId, decision, dependenciesFor(reviewer, nonceB),
    )).resolves.toEqual(expect.objectContaining({
      status: 'signed-device', eventKind: 'plugin-review', attestationCount: 2,
    }))
    const eventId = pluginReviewAttestationEventId(review.proposal)
    const forged = await make(
      reviewer, 'plugin-review', eventId, await pluginReviewEventSha256(review.proposal), nonceC,
    )
    await expect(publishProjectResearchEventAttestation(
      settings, projectId, directory([runner, reviewer]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics), forged,
    )).rejects.toThrow('proof is invalid')

    const bucket = Array.from(discussions.entries()).find(([key]) =>
      key.startsWith('plugin-reviews:v1:'),
    )?.[1]
    if (!(bucket instanceof Y.Map)) throw new Error('Plugin review bucket fixture missing')
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Plugin review event fixture missing')
    const proposalEntry = Array.from(events.entries()).find(([, value]) =>
      typeof value === 'object' && value !== null &&
      (value as { eventId?: unknown }).eventId === review.proposal.eventId,
    )
    if (!proposalEntry) throw new Error('Plugin proposal fixture missing')
    events.set(proposalEntry[0], { ...review.proposal, content: 'Changed retained plugin proposal body' })
    await expect(inspectProjectResearchEventAttestations(
      settings, projectId, directory([runner, reviewer]),
      researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics),
    )).resolves.toEqual(expect.objectContaining({ healthy: false, invalidRecords: 1 }))
  })
})
