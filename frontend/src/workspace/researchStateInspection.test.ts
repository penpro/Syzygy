import { describe, expect, it } from 'vitest'
import type { ProjectDeviceRegistrationProof } from '../tauri'
import { createHeuristic } from './heuristicsModel'
import { buildHeuristicCheckRequest, HEURISTIC_CHECK_CONTRACT_VERSION } from './heuristicCheck'
import { commitHeuristicCheckResult } from './heuristicCheckResultModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { commitPolicyVersion } from './policyVersionModel'
import { buildScenarioEvaluationRequest, SCENARIO_EVALUATION_CONTRACT_VERSION, SCENARIO_EVALUATION_PROMPT_VERSION } from './scenarioEvaluation'
import { beginScenarioRerunItem, completeScenarioRerunItem, controlScenarioRerunJob, createScenarioRerunJob } from './scenarioRerunQueue'
import { inspectResearchState } from './researchStateInspection'
import { createScenario, deleteScenario, readScenario } from './scenarioModel'
import { createScenarioAnnotation } from './scenarioAnnotationModel'
import { castScenarioVote } from './scenarioVoteModel'
import { createScenarioLabel, setScenarioLabelAssignment } from './scenarioLabelModel'
import { createSuggestion } from './suggestionModel'
import { createProjectManifest } from './schema'
import { canonicalProjectDeviceRegistrationClaim } from './deviceIdentity'
import { PROJECT_DEVICE_REGISTRATION_PREFIX, publishProjectDeviceRegistration } from './projectDeviceDirectory'

const manifest = createProjectManifest({ id: 'inspection-project', documentId: 'inspection-document', timestamp: 1 })

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

async function signedDeviceRegistration(): Promise<ProjectDeviceRegistrationProof> {
  const claim = { schemaVersion: 1 as const, projectId: manifest.id, participantId: 'researcher-1' }
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
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

async function populatedDocument() {
  const doc = createProjectDocument(manifest)
  const { discussions, heuristics, scenarios, settings, versions, metadata } = getProjectSharedTypes(doc)
  const evidenceHeuristic = createHeuristic(heuristics, {
    id: 'evidence-quality', title: 'Evidence quality', guidance: 'Secret guidance is omitted.', priority: 'required',
    authorId: 'researcher-1', timestamp: 10, editId: 'create-evidence-quality',
  })
  const sourceScenario = createScenario(scenarios, {
    id: 'source-challenge', title: 'Source challenge', background: 'Secret scenario background is omitted.',
    authorId: 'researcher-1', timestamp: 10, editId: 'create-source-challenge',
    turns: [{ id: 'challenge-question', role: 'user', content: 'Secret scenario turn is omitted.', editId: 'create-challenge-question' }],
  })
  createScenarioLabel(settings, {
    labelId: 'evidence-context', eventId: 'create-evidence-context', name: 'Evidence context',
    authorId: 'researcher-1', timestamp: 11,
  })
  setScenarioLabelAssignment(settings, scenarios, {
    scenarioId: 'source-challenge', labelId: 'evidence-context', eventId: 'assign-evidence-context',
    expectedCurrentEventId: null, assigned: true, authorId: 'researcher-1', timestamp: 12,
  })
  castScenarioVote(getProjectSharedTypes(doc).discussions, scenarios, {
    scenarioId: 'source-challenge', eventId: 'researcher-2-supports', participantId: 'researcher-2',
    displayName: 'Secret voter display name is omitted.', choice: 'support', timestamp: 12,
  })
  createScenarioAnnotation(getProjectSharedTypes(doc).discussions, scenarios, {
    annotationId: 'source-warning', eventId: 'create-source-warning', scenarioId: 'source-challenge',
    kind: 'flag', body: 'Secret annotation body is omitted.', authorId: 'researcher-2',
    displayName: 'Secret annotator display name is omitted.', timestamp: 12,
  })
  createSuggestion(discussions, {
    suggestionId: 'appeal-proposal', eventId: 'proposal-appeal',
    content: 'Secret suggestion content is omitted.', sourceDocumentRevision: 'lexical-inspection-source',
    authorId: 'researcher-2', authorDisplayName: 'Researcher Two', timestamp: 13,
    sourceKind: 'model', providerId: 'local', modelId: 'model-fixture', runId: 'run-fixture',
  })
  const checkBlocks = [{ kind: 'paragraph' as const, text: 'Secret cited policy text is omitted.' }]
  const checkRequest = buildHeuristicCheckRequest({
    runId: 'inspection-check-run', providerId: 'local', requestedModelId: 'fixture-model',
    project: manifest, heuristic: evidenceHeuristic, examples: [], blocks: checkBlocks,
  })
  const checkQuote = checkBlocks[0].text
  commitHeuristicCheckResult(doc, checkRequest, {
    contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION, runId: checkRequest.runId,
    providerId: 'local', requestedModelId: 'fixture-model', executedModelId: 'fixture-model',
    verdict: 'uncertain', rationale: 'Secret check rationale is omitted.',
    uncertainty: 'Secret check uncertainty is omitted.',
    citations: [{ start: 0, end: checkQuote.length, quote: checkQuote }],
  }, {
    resultId: 'inspection-check-result', authorId: 'researcher-1',
    authorDisplayName: 'Researcher One', timestamp: 14, currentBlocks: checkBlocks,
  })
  createScenario(scenarios, {
    id: 'source-challenge-branch', title: 'Skeptical branch', background: '', parentScenarioId: 'source-challenge',
    authorId: 'researcher-2', timestamp: 11, editId: 'create-source-challenge-branch',
  })
  const version = await commitPolicyVersion(versions, metadata, {
    projectId: manifest.id, expectedHeadVersionId: null,
    blocks: [{ kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Secret policy text is omitted.' }],
    participantId: 'researcher-1', displayName: 'Researcher One', createdAt: 11, note: 'Secret note is omitted.',
  })
  const queue = createScenarioRerunJob(settings, {
    jobId: 'inspection-rerun', project: manifest, policyVersion: version,
    providerId: 'local', requestedModelId: 'fixture-model',
    items: [{ itemId: 'inspection-item', scenario: sourceScenario, runIdBase: 'inspection-run', resultId: 'inspection-result' }],
    authorId: 'researcher-1', authorDisplayName: 'Researcher One', timestamp: 15,
  })
  controlScenarioRerunJob(settings, discussions, {
    eventId: 'inspection-start', jobId: queue.definition.jobId, action: 'start', parentEventId: null,
    authorId: 'researcher-1', timestamp: 16,
  })
  beginScenarioRerunItem(settings, discussions, {
    eventId: 'inspection-begin', jobId: queue.definition.jobId, itemId: 'inspection-item',
    expectedCurrentEventId: null, attempt: 1, authorId: 'researcher-1', timestamp: 17,
  })
  const evaluationRequest = buildScenarioEvaluationRequest({
    jobId: queue.definition.jobId, itemId: 'inspection-item', attempt: 1, runId: 'inspection-run-a1',
    providerId: 'local', requestedModelId: 'fixture-model', project: manifest, policyVersion: version,
    scenario: readScenario(scenarios, sourceScenario.id)!,
  })
  await completeScenarioRerunItem(doc, evaluationRequest, {
    contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
    promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
    jobId: evaluationRequest.jobId, itemId: evaluationRequest.itemId, attempt: 1,
    runId: evaluationRequest.runId, providerId: 'local', requestedModelId: 'fixture-model',
    executedModelId: 'fixture-model', outcome: 'uncertain',
    response: 'Secret scenario evaluation response is omitted.',
    rationale: 'Secret scenario evaluation rationale is omitted.',
    uncertainty: 'Secret scenario evaluation uncertainty is omitted.',
  }, {
    eventId: 'inspection-complete', resultId: 'inspection-result',
    authorId: 'researcher-1', authorDisplayName: 'Researcher One', timestamp: 18,
  })
  const registrationProof = await signedDeviceRegistration()
  await publishProjectDeviceRegistration(settings, manifest.id, registrationProof)
  return { doc, version, registrationProof }
}

describe('research state inspection', () => {
  it('returns bounded metadata and a healthy integrity result without research bodies', async () => {
    const { doc, version, registrationProof } = await populatedDocument()
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.selfCheck).toEqual({ healthy: true, issues: [] })
    expect(result.heuristics).toMatchObject({ totalRecords: 1, validRecords: 1, invalidRecords: 0 })
    expect(result.heuristicChecks).toMatchObject({
      resultCount: 1, passCount: 0, failCount: 0, uncertainCount: 1, localCount: 1, remoteCount: 0, invalidRecords: 0,
    })
    expect(result.scenarios).toMatchObject({ totalRecords: 2, validRecords: 2, invalidRecords: 0, rootCount: 1, branchCount: 1 })
    expect(result.scenarios.items[0]).toMatchObject({ id: 'source-challenge', turnCount: 1, turnRevisionCount: 1, editCount: 1 })
    expect(result.scenarioReruns).toEqual({
      jobCount: 1, runningCount: 0, pausedCount: 0, cancelledCount: 0, completeCount: 1,
      itemCount: 1, completedItemCount: 1, failedItemCount: 0, interruptedItemCount: 0,
      localJobCount: 1, remoteJobCount: 0, comparablePairCount: 0, invalidRecords: 0,
      orphanScenarioIds: [], orphanPolicyVersionIds: [], foreignProjectJobCount: 0,
    })
    expect(result.scenarioVotes).toMatchObject({
      summaryCount: 1, invalidRecords: 0, orphanScenarioIds: [],
      items: [{ scenarioId: 'source-challenge', counts: { support: 1, oppose: 0, abstain: 0 }, activeVoteCount: 1, eventCount: 1 }],
    })
    expect(result.scenarioAnnotations).toMatchObject({
      annotationCount: 1, invalidRecords: 0, orphanScenarioIds: [], orphanTurnTargets: [], openCount: 1, resolvedCount: 0,
      items: [{ id: 'source-warning', scenarioId: 'source-challenge', kind: 'flag', status: 'open', eventCount: 1 }],
    })
    expect(result.scenarioLabels).toMatchObject({
      labelCount: 1, assignmentCount: 1, invalidRecords: 0, orphanScenarioIds: [], orphanLabelIds: [],
      items: [{ id: 'evidence-context', name: 'Evidence context', eventCount: 1, scenarioIds: ['source-challenge'] }],
    })
    expect(result.suggestions).toMatchObject({
      suggestionCount: 1, pendingCount: 1, invalidRecords: 0, conflictedSuggestionIds: [],
      items: [{ id: 'appeal-proposal', status: 'pending', sourceKind: 'model', decisionCount: 0 }],
    })
    expect(result.adversarialReviews).toEqual({
      archiveCount: 0, decisionCount: 0, invalidRecords: 0,
      conflictedRunIds: [], truncated: false, items: [],
    })
    expect(result.projectDevices).toEqual({
      registrationCount: 1,
      deviceCount: 1,
      conflictingDevices: 0,
      invalidRecords: 0,
      unavailableRecords: 0,
      excessRecords: 0,
      truncated: false,
      items: [{
        keyId: registrationProof.keyId,
        fingerprint: registrationProof.keyId.replace('ed25519-sha256:', ''),
        participantIds: ['researcher-1'],
        status: 'registered-device',
        registrationCount: 1,
      }],
    })
    expect(result.relayAdminApprovals).toEqual({
      approvalCount: 0,
      activeIntentCount: 0,
      activeApprovalCount: 0,
      conflictingSigners: 0,
      expiredApprovals: 0,
      invalidRecords: 0,
      unavailableRecords: 0,
      excessRecords: 0,
      truncated: false,
      items: [],
      enforcement: 'not-configured-at-relay',
    })
    expect(result.versions).toMatchObject({ totalRecords: 1, validRecords: 1, invalidRecords: 0, headVersionId: version.versionId, headLineageDepth: 1 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('Secret guidance')
    expect(serialized).not.toContain('Secret policy text')
    expect(serialized).not.toContain('Secret note')
    expect(serialized).not.toContain('Secret check rationale')
    expect(serialized).not.toContain('Secret check uncertainty')
    expect(serialized).not.toContain('Secret cited policy text')
    expect(serialized).not.toContain('Secret scenario background')
    expect(serialized).not.toContain('Secret scenario turn')
    expect(serialized).not.toContain('Secret scenario evaluation response')
    expect(serialized).not.toContain('Secret scenario evaluation rationale')
    expect(serialized).not.toContain('Secret scenario evaluation uncertainty')
    expect(serialized).not.toContain('Secret voter display name')
    expect(serialized).not.toContain('Secret annotation body')
    expect(serialized).not.toContain('Secret suggestion content')
    expect(serialized).not.toContain('Secret annotator display name')
  })

  it('reports invalid scenario branch ancestry without exposing scenario bodies', async () => {
    const { doc } = await populatedDocument()
    const { scenarios } = getProjectSharedTypes(doc)
    deleteScenario(scenarios, 'source-challenge')
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.scenarios).toMatchObject({ totalRecords: 1, validRecords: 1, invalidRecords: 0, rootCount: 0, branchCount: 1 })
    expect(result.selfCheck).toEqual({
      healthy: false,
      issues: [
        'Scenario source-challenge-branch has missing parent source-challenge',
        'Scenario rerun queue targets missing scenario source-challenge',
        'Scenario annotations target missing scenario source-challenge',
        'Scenario votes target missing scenario source-challenge',
        'Scenario label assignments target missing scenario source-challenge',
      ],
    })
  })

  it('reports a malformed signed-device directory record through the read-only MCP projection', async () => {
    const { doc } = await populatedDocument()
    getProjectSharedTypes(doc).settings.set(`${PROJECT_DEVICE_REGISTRATION_PREFIX}hostile`, {
      role: 'admin',
      secretResearchBody: 'must-not-leak',
    })
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.projectDevices).toMatchObject({ invalidRecords: 1, deviceCount: 1 })
    expect(result.selfCheck.healthy).toBe(false)
    expect(result.selfCheck.issues).toContain('1 project device registration(s) failed validation, verification, or bounds')
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })

  it('reports a tampered version and invalid head lineage without throwing', async () => {
    const { doc, version } = await populatedDocument()
    const { versions } = getProjectSharedTypes(doc)
    versions.set(version.versionId, (versions.get(version.versionId) as string).replace('Secret policy text', 'Tampered text'))
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.selfCheck.healthy).toBe(false)
    expect(result.versions).toMatchObject({ totalRecords: 1, validRecords: 0, invalidRecords: 1, headVersionId: version.versionId, headLineageDepth: 0 })
    expect(result.selfCheck.issues).toEqual([
      `Scenario rerun queue targets missing or invalid policy version ${version.versionId}`,
      '1 version record(s) failed hash/schema validation',
      'The policy version head or its lineage is invalid',
    ])
  })

  it('reports a content-valid non-head record whose ancestor is missing', async () => {
    const { doc, version: root } = await populatedDocument()
    const { versions, metadata } = getProjectSharedTypes(doc)
    const child = await commitPolicyVersion(versions, metadata, {
      projectId: manifest.id, expectedHeadVersionId: root.versionId,
      blocks: [{ kind: 'paragraph', text: 'Child snapshot.' }],
      participantId: 'researcher-1', displayName: 'Researcher One', createdAt: 12,
    })
    versions.delete(root.versionId)
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.versions).toMatchObject({
      totalRecords: 1, validRecords: 1, invalidRecords: 0, invalidLineageRecords: 1,
      headVersionId: child.versionId, headLineageDepth: 0,
    })
    expect(result.selfCheck.issues).toEqual([
      `Scenario rerun queue targets missing or invalid policy version ${root.versionId}`,
      '1 version record(s) have missing, cross-project, or cyclic ancestry',
      'The policy version head or its lineage is invalid',
    ])
  })
})
