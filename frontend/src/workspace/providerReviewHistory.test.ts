import { describe, expect, it } from 'vitest'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import type { ProviderResearchTaskRequest, ProviderNormalizedResponse } from '../tauri'
import type { ProviderRunRecord } from '../extensions/providerRunRecord'
import {
  inspectProviderReviewHistory,
  providerReviewArchiveEventSha256,
  readProviderReviewArchive,
  saveProviderReview,
} from './providerReviewHistory'
import { researchEventAttestationResolver } from './researchEventAttribution'

const manifest = createProjectManifest({
  id: 'provider-review-project', documentId: 'provider-review-document', title: 'Provider reviews', timestamp: 10,
})

const request = (runId = 'provider-review-run'): ProviderResearchTaskRequest => ({
  runId,
  callId: `${runId}:call`,
  taskType: 'research.remote-review',
  provider: 'openai',
  timeoutMs: 120_000,
  model: 'fixture-model',
  developerInstructions: 'Audit the supplied source.',
  question: 'What claim needs more support?',
  sources: [{ snapshotId: 'source-1', label: 'Current draft', excerpt: 'A draft claim.' }],
  maxOutputTokens: 1_200,
  toolDefinitions: [],
  enableSourceLocator: false,
})

const response = (): ProviderNormalizedResponse => ({
  provider: 'openai', id: 'response-1', status: 'completed', model: 'fixture-model',
  text: 'The claim lacks a cited baseline.', refusals: [], unknownOutputTypes: [], toolProposals: [],
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
})

const runRecord = (value = request()): ProviderRunRecord => ({
  recordVersion: 1,
  runId: value.runId,
  callId: value.callId,
  executionMode: 'product',
  provider: {
    id: 'openai', transport: 'openai-responses', model: value.model,
    adapterStatus: 'request-stream-and-schema-validated-tool-proposal-conformance', remote: true,
  },
  request: {
    taskType: value.taskType, startedAt: '2026-08-11T01:00:00.000Z',
    completedAt: '2026-08-11T01:00:01.000Z', sourceSnapshotIds: ['source-1'],
    inputSha256: 'a'.repeat(64), maxOutputTokens: value.maxOutputTokens,
    timeoutMs: value.timeoutMs, stream: true,
  },
  disclosure: {
    required: true, approved: true, approvedAt: '2026-08-11T01:00:00.000Z',
    destination: 'https://api.openai.com/v1/responses',
    policyUrl: 'https://example.test/policy', policyCheckedAt: '2026-08-10T00:00:00.000Z',
  },
  dataHandling: { storageRequest: 'disabled', zeroRetention: 'requested', attestation: null },
  result: { status: 'completed', outputSha256: 'b'.repeat(64), errorCode: null },
  usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: null },
})

async function save(document = createProjectDocument(manifest), run = request(), text = response()) {
  return saveProviderReview(document, {
    expectedResearchRevision: projectStateFingerprint(document),
    projectId: manifest.id,
    documentId: manifest.documentId,
    sourceDocumentRevision: 'lexical-session-a-1-deadbeef',
    request: run,
    response: text,
    runRecord: runRecord(run),
    participantId: 'researcher-a',
    displayName: 'Researcher A',
    createdAt: 1_700_000_000_000,
  })
}

describe('shared provider review history', () => {
  it('retains a strict full review while routine inspection stays content-free', async () => {
    const document = createProjectDocument(manifest)
    const archive = await save(document)
    const inspection = await inspectProviderReviewHistory(getProjectSharedTypes(document).discussions)
    expect(inspection).toMatchObject({ healthy: true, archiveCount: 1, conflictedRunIds: [] })
    expect(inspection.items[0]).toMatchObject({
      runId: request().runId, providerId: 'openai', model: 'fixture-model', sourceCount: 1, totalTokens: 20,
    })
    expect(JSON.stringify(inspection)).not.toContain('claim lacks')
    expect(await readProviderReviewArchive(getProjectSharedTypes(document).discussions, archive.runId))
      .toEqual(archive)
    expect(await providerReviewArchiveEventSha256(archive)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(researchEventAttestationResolver(
      getProjectSharedTypes(document).discussions,
    )('provider-review', `archive:${archive.runId}`)).resolves.toEqual({
      eventSha256: await providerReviewArchiveEventSha256(archive),
      participantId: 'researcher-a',
    })
  })

  it('converges exact archives and keeps same-run divergent peer archives as an explicit conflict', async () => {
    const base = createProjectDocument(manifest)
    const left = createProjectDocument(manifest)
    const right = createProjectDocument(manifest)
    applyProjectUpdate(left, encodeProjectState(base))
    applyProjectUpdate(right, encodeProjectState(base))
    await save(left)
    const changed = response()
    changed.text = 'A different peer result.'
    await save(right, request(), changed)
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftInspection = await inspectProviderReviewHistory(getProjectSharedTypes(left).discussions)
    const rightInspection = await inspectProviderReviewHistory(getProjectSharedTypes(right).discussions)
    expect(leftInspection).toEqual(rightInspection)
    expect(leftInspection).toMatchObject({
      healthy: false, archiveCount: 2, items: [], conflictedRunIds: ['provider-review-run'],
    })
    expect(await readProviderReviewArchive(getProjectSharedTypes(left).discussions, 'provider-review-run')).toBeNull()
  })

  it('fails before mutation on stale research, hostile records, and native provenance mismatch', async () => {
    const document = createProjectDocument(manifest)
    const staleRevision = projectStateFingerprint(document)
    getProjectSharedTypes(document).settings.set('peer-change', true)
    await expect(saveProviderReview(document, {
      expectedResearchRevision: staleRevision, projectId: manifest.id, documentId: manifest.documentId,
      sourceDocumentRevision: 'lexical-session-a-1-deadbeef', request: request(), response: response(), runRecord: runRecord(),
      participantId: 'researcher-a', displayName: 'Researcher A', createdAt: 2,
    })).rejects.toThrow('Shared research changed')
    expect(getProjectSharedTypes(document).discussions.size).toBe(0)

    getProjectSharedTypes(document).discussions.set('provider-review:v1:hostile:bad-run', { schemaVersion: 1 })
    await expect(save(document, request('another-run'))).rejects.toThrow('history needs attention')

    const clean = createProjectDocument(manifest)
    const mismatched = runRecord()
    mismatched.provider.model = 'substituted-model'
    await expect(saveProviderReview(clean, {
      expectedResearchRevision: projectStateFingerprint(clean), projectId: manifest.id,
      documentId: manifest.documentId, sourceDocumentRevision: 'lexical-session-a-1-deadbeef', request: request(),
      response: response(), runRecord: mismatched, participantId: 'researcher-a',
      displayName: 'Researcher A', createdAt: 3,
    })).rejects.toThrow('failed validation')
    expect(getProjectSharedTypes(clean).discussions.size).toBe(0)

    const changedDuringHash = createProjectDocument(manifest)
    const pendingSave = saveProviderReview(changedDuringHash, {
      expectedResearchRevision: projectStateFingerprint(changedDuringHash), projectId: manifest.id,
      documentId: manifest.documentId, sourceDocumentRevision: 'lexical-session-a-1-deadbeef', request: request(),
      response: response(), runRecord: runRecord(), participantId: 'researcher-a',
      displayName: 'Researcher A', createdAt: 4,
    })
    getProjectSharedTypes(changedDuringHash).settings.set('change-during-hash', true)
    await expect(pendingSave).rejects.toThrow('Shared research changed')
    expect(getProjectSharedTypes(changedDuringHash).discussions.size).toBe(0)

    const invalidTerminal = response()
    invalidTerminal.status = 'failed'
    await expect(saveProviderReview(clean, {
      expectedResearchRevision: projectStateFingerprint(clean), projectId: manifest.id,
      documentId: manifest.documentId, sourceDocumentRevision: 'lexical-session-a-1-deadbeef', request: request(),
      response: invalidTerminal, runRecord: runRecord(), participantId: 'researcher-a',
      displayName: 'Researcher A', createdAt: 5,
    })).rejects.toThrow('failed validation')
    expect(getProjectSharedTypes(clean).discussions.size).toBe(0)

    await expect(saveProviderReview(clean, {
      expectedResearchRevision: projectStateFingerprint(clean), projectId: manifest.id,
      documentId: manifest.documentId, sourceDocumentRevision: 'lexical-session-a-1-deadbeef', request: request(),
      response: response(), runRecord: runRecord(), participantId: 'researcher-a',
      displayName: 'Researcher A', createdAt: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow('failed validation')
    expect(getProjectSharedTypes(clean).discussions.size).toBe(0)
  })

  it('rejects duplicate local run identities without changing the retained archive', async () => {
    const document = createProjectDocument(manifest)
    const first = await save(document)
    await expect(save(document)).rejects.toThrow('run identity already exists')
    expect(await readProviderReviewArchive(getProjectSharedTypes(document).discussions, first.runId)).toEqual(first)
  })
})
