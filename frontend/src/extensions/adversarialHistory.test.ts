import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createProjectDocument, encodeProjectState, applyProjectUpdate, getProjectSharedTypes, projectStateFingerprint } from '../workspace/projectModel'
import { createProjectManifest } from '../workspace/schema'
import { buildNativeAdversarialScope } from './adversarialNativePlan'
import {
  decideAdversarialReview,
  inspectAdversarialReviewHistory,
  listAdversarialReviewArchives,
  readAdversarialReviewArchive,
  readAdversarialReviewDecision,
  saveAdversarialReviewArchive,
} from './adversarialHistory'
import {
  runAdversarialPanel,
  type AdversarialExecutor,
  type AdversarialRunnerRequest,
} from './adversarialRunner'
import type { NativeAdversarialPanelOutcome } from './adversarialNativeExecutor'
import type { ProviderRunRecord } from './providerRunRecord'

const manifest = createProjectManifest({
  id: 'project-adversarial-history',
  documentId: 'document-adversarial-history',
  title: 'Adversarial history fixture',
  timestamp: 1,
})

const request: AdversarialRunnerRequest = {
  runId: 'adversarial-history-run',
  input: {
    question: 'Which conclusion is supported?',
    seed: 'history-seed',
    participants: [
      { slotId: 'participant-a', providerId: 'openai', modelId: 'proposal-a' },
      { slotId: 'participant-b', providerId: 'gemini', modelId: 'proposal-b' },
    ],
    judge: { slotId: 'judge', providerId: 'anthropic', modelId: 'judge-model' },
    baseline: { slotId: 'baseline', providerId: 'xai', modelId: 'baseline-model' },
  },
  sources: [{
    snapshotId: 'source-history-1',
    label: 'Policy source',
    excerpt: 'The source supports conclusion A.',
  }],
}

const executor: AdversarialExecutor = async (call) => {
  const usage = { inputTokens: 10, outputTokens: 5, costUsd: null }
  if (call.phase === 'proposal') {
    return {
      kind: 'proposal',
      proposal: `Proposal ${call.payload.candidateId}`,
      claims: [{ claimId: `claim-${call.payload.candidateId}`, text: 'Conclusion A is supported.' }],
      usage,
    }
  }
  if (call.phase === 'critique') return { kind: 'critique', summary: 'The target needs stronger source qualification.', usage }
  if (call.phase === 'evidence-audit') {
    return {
      kind: 'evidence-audit',
      entries: call.payload.candidates.flatMap((candidate) => candidate.claims.map((claim) => ({
        candidateId: candidate.candidateId,
        claimId: claim.claimId,
        verdict: 'supported' as const,
        sourceIds: ['source-history-1'],
      }))),
      usage,
    }
  }
  if (call.phase === 'judgment') {
    return {
      kind: 'judgment',
      ranking: [...call.payload.order],
      ...(call.payload.finalPass ? {
        minorityFindings: [],
        synthesis: { text: 'Conclusion A survives the bounded review.', retainedFindingIds: [] },
      } : {}),
      usage,
    }
  }
  return { kind: 'baseline', text: `Baseline ${call.payload.attempt}`, usage }
}

function providerTransport(providerId: string): ProviderRunRecord['provider']['transport'] {
  if (providerId === 'openai') return 'openai-responses'
  if (providerId === 'anthropic') return 'anthropic-messages'
  if (providerId === 'gemini') return 'gemini-interactions'
  return 'xai-responses'
}

async function outcome(): Promise<NativeAdversarialPanelOutcome> {
  const base = await runAdversarialPanel(request, executor)
  const scope = buildNativeAdversarialScope(request)
  const callsById = new Map(scope.calls.map((call) => [call.callId, call]))
  const providerRunRecords: ProviderRunRecord[] = base.callLedger.map((entry) => {
    const planned = callsById.get(entry.callId)!
    return ({
    recordVersion: 1,
    runId: request.runId,
    callId: entry.callId,
    executionMode: 'loopback-conformance',
    provider: {
      id: entry.providerId,
      transport: providerTransport(entry.providerId),
      model: entry.modelId,
      adapterStatus: entry.providerId === 'openai'
        ? 'request-and-stream-control-conformance'
        : 'request-control-conformance',
      remote: true,
    },
    request: {
      taskType: `adversarial.${entry.phase}`,
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:01.000Z',
      sourceSnapshotIds: ['source-history-1'],
      inputSha256: 'a'.repeat(64),
      maxOutputTokens: planned.maxOutputTokens,
      timeoutMs: planned.timeoutMs,
      stream: false,
    },
    disclosure: {
      required: true,
      approved: true,
      approvedAt: '2026-07-29T00:00:00.000Z',
      destination: 'http://127.0.0.1:44001/v1/test',
      policyUrl: 'https://example.invalid/provider-policy',
      policyCheckedAt: '2026-07-29',
    },
    dataHandling: {
      storageRequest: 'disabled',
      zeroRetention: 'requested',
      attestation: null,
    },
    result: {
      status: 'completed',
      outputSha256: 'b'.repeat(64),
      errorCode: null,
    },
    usage: {
      inputTokens: entry.usage!.inputTokens,
      outputTokens: entry.usage!.outputTokens,
      totalTokens: entry.usage!.inputTokens + entry.usage!.outputTokens,
      costUsd: null,
    },
  })})
  return {
    ...base,
    authorization: { scopeSha256: 'c'.repeat(64), totalRemoteCalls: scope.totalRemoteCalls },
    providerRunRecords,
  }
}

async function save(doc: Y.Doc, value?: NativeAdversarialPanelOutcome) {
  const resolvedOutcome = value ?? await outcome()
  return saveAdversarialReviewArchive(doc, {
    expectedResearchRevision: projectStateFingerprint(doc),
    projectId: manifest.id,
    sourceDocumentRevision: 'lexical-history-source',
    request,
    outcome: resolvedOutcome,
    participantId: 'researcher-a',
    displayName: 'Researcher A',
    createdAt: 10,
  })
}

describe('collaborative adversarial review history', () => {
  it('saves one immutable bounded archive and exposes content-minimized inspection', async () => {
    const doc = createProjectDocument(manifest)
    const saved = await save(doc)
    expect(saved.archive.runId).toBe(request.runId)
    expect(saved.archive.recordSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(saved.archive.sourceDocumentRevision).toBe('lexical-history-source')
    expect(saved.archive.researchRevisionAtSave).not.toBe(saved.researchRevision)
    expect((await readAdversarialReviewArchive(getProjectSharedTypes(doc).discussions, request.runId))?.outcome.record.synthesis.text)
      .toContain('survives')
    expect(await listAdversarialReviewArchives(getProjectSharedTypes(doc).discussions)).toHaveLength(1)
    const inspection = await inspectAdversarialReviewHistory(getProjectSharedTypes(doc).discussions)
    expect(inspection).toMatchObject({
      healthy: true,
      archiveCount: 1,
      decisionCount: 0,
      invalidRecords: 0,
      conflictedRunIds: [],
    })
    expect(inspection.items[0]).toMatchObject({
      runId: request.runId,
      sourceCount: 1,
      participantCount: 2,
      providerCount: 2,
      totalRemoteCalls: 14,
      decision: 'pending',
      decisionCount: 0,
    })
    expect(JSON.stringify(inspection)).not.toContain(request.input.question)
    expect(JSON.stringify(inspection)).not.toContain(request.sources[0].excerpt)
    expect(JSON.stringify(inspection)).not.toContain('Conclusion A survives')
  })

  it('rejects stale saves and tampered provider provenance before writing', async () => {
    const doc = createProjectDocument(manifest)
    const staleRevision = projectStateFingerprint(doc)
    getProjectSharedTypes(doc).metadata.set('title', 'Concurrent title')
    await expect(saveAdversarialReviewArchive(doc, {
      expectedResearchRevision: staleRevision,
      projectId: manifest.id,
      sourceDocumentRevision: 'lexical-history-source',
      request,
      outcome: await outcome(),
      participantId: 'researcher-a',
      displayName: 'Researcher A',
      createdAt: 10,
    })).rejects.toThrow('Research state changed')
    expect(await listAdversarialReviewArchives(getProjectSharedTypes(doc).discussions)).toHaveLength(0)

    const tampered = await outcome()
    ;(tampered.providerRunRecords[0].request as unknown as Record<string, unknown>).content = 'secret'
    await expect(save(doc, tampered)).rejects.toThrow('Invalid adversarial review archive')
    const substitutedRoute = await outcome()
    substitutedRoute.providerRunRecords[0].provider.model = 'substituted-model'
    await expect(save(doc, substitutedRoute)).rejects.toThrow('Invalid adversarial review archive')
    const substitutedUsage = await outcome()
    const alteredUsage = substitutedUsage.providerRunRecords[0].usage
    if (alteredUsage.inputTokens === null || alteredUsage.totalTokens === null) throw new Error('Expected usage fixture')
    alteredUsage.inputTokens += 1
    alteredUsage.totalTokens += 1
    await expect(save(doc, substitutedUsage)).rejects.toThrow('Invalid adversarial review archive')
    expect(await listAdversarialReviewArchives(getProjectSharedTypes(doc).discussions)).toHaveLength(0)
  })

  it('converges identical peer archives and fails closed on same-run content conflicts', async () => {
    const sameA = createProjectDocument(manifest)
    const sameB = new Y.Doc()
    applyProjectUpdate(sameB, encodeProjectState(sameA))
    const sharedOutcome = await outcome()
    await save(sameA, sharedOutcome)
    await save(sameB, sharedOutcome)
    applyProjectUpdate(sameA, encodeProjectState(sameB))
    applyProjectUpdate(sameB, encodeProjectState(sameA))
    expect(await listAdversarialReviewArchives(getProjectSharedTypes(sameA).discussions)).toHaveLength(1)
    expect((await inspectAdversarialReviewHistory(getProjectSharedTypes(sameB).discussions)).healthy).toBe(true)

    const conflictA = createProjectDocument(manifest)
    const conflictB = createProjectDocument(manifest)
    const left = await outcome()
    const right = structuredClone(left)
    right.record.synthesis.text = 'A different but structurally valid synthesis.'
    await save(conflictA, left)
    await save(conflictB, right)
    applyProjectUpdate(conflictA, encodeProjectState(conflictB))
    const inspection = await inspectAdversarialReviewHistory(getProjectSharedTypes(conflictA).discussions)
    expect(await readAdversarialReviewArchive(getProjectSharedTypes(conflictA).discussions, request.runId)).toBeNull()
    expect(inspection.healthy).toBe(false)
    expect(inspection.conflictedRunIds).toEqual([request.runId])
  })

  it('appends revision-guarded human decisions without changing policy content', async () => {
    const doc = createProjectDocument(manifest)
    const saved = await save(doc)
    const acceptInput = {
      expectedResearchRevision: saved.researchRevision,
      projectId: manifest.id,
      runId: request.runId,
      recordSha256: saved.archive.recordSha256,
      expectedCurrentDecisionId: null,
      decision: 'accepted' as const,
      eventId: 'decision-accept',
      participantId: 'reviewer-a',
      displayName: 'Reviewer A',
      notes: 'Accepted as research evidence, not as a draft edit.',
      timestamp: 20,
    }
    const accepted = await decideAdversarialReview(doc, acceptInput)
    expect(accepted.decision.current.decision).toBe('accepted')
    const replayed = await decideAdversarialReview(doc, acceptInput)
    expect(replayed.decision.current.eventId).toBe('decision-accept')
    expect(replayed.researchRevision).toBe(accepted.researchRevision)
    expect(getProjectSharedTypes(doc).editorRoot.toString()).toBe('')
    await expect(decideAdversarialReview(doc, {
      expectedResearchRevision: saved.researchRevision,
      projectId: manifest.id,
      runId: request.runId,
      recordSha256: saved.archive.recordSha256,
      expectedCurrentDecisionId: 'decision-accept',
      decision: 'rejected',
      eventId: 'decision-reject-stale',
      participantId: 'reviewer-b',
      displayName: 'Reviewer B',
      notes: '',
      timestamp: 21,
    })).rejects.toThrow('Research state changed')
    const revised = await decideAdversarialReview(doc, {
      expectedResearchRevision: accepted.researchRevision,
      projectId: manifest.id,
      runId: request.runId,
      recordSha256: saved.archive.recordSha256,
      expectedCurrentDecisionId: 'decision-accept',
      decision: 'rejected',
      eventId: 'decision-reject',
      participantId: 'reviewer-b',
      displayName: 'Reviewer B',
      notes: 'Later source review rejected it.',
      timestamp: 22,
    })
    expect(revised.decision.current.decision).toBe('rejected')
    expect(revised.decision.history.map(({ eventId }) => eventId)).toEqual(['decision-accept', 'decision-reject'])
  })

  it('retains concurrent decision branches and reports the conflict instead of choosing a winner', async () => {
    const base = createProjectDocument(manifest)
    await save(base)
    const baseUpdate = encodeProjectState(base)
    const left = createProjectDocument(manifest)
    const right = createProjectDocument(manifest)
    applyProjectUpdate(left, baseUpdate)
    applyProjectUpdate(right, baseUpdate)
    const archive = (await readAdversarialReviewArchive(getProjectSharedTypes(left).discussions, request.runId))!
    await decideAdversarialReview(left, {
      expectedResearchRevision: projectStateFingerprint(left),
      projectId: manifest.id,
      runId: request.runId,
      recordSha256: archive.recordSha256,
      expectedCurrentDecisionId: null,
      decision: 'accepted',
      eventId: 'decision-left',
      participantId: 'reviewer-left',
      displayName: 'Left reviewer',
      notes: '',
      timestamp: 30,
    })
    await decideAdversarialReview(right, {
      expectedResearchRevision: projectStateFingerprint(right),
      projectId: manifest.id,
      runId: request.runId,
      recordSha256: archive.recordSha256,
      expectedCurrentDecisionId: null,
      decision: 'rejected',
      eventId: 'decision-right',
      participantId: 'reviewer-right',
      displayName: 'Right reviewer',
      notes: '',
      timestamp: 31,
    })
    applyProjectUpdate(left, encodeProjectState(right))
    expect(readAdversarialReviewDecision(getProjectSharedTypes(left).discussions, request.runId)).toBeNull()
    const inspection = await inspectAdversarialReviewHistory(getProjectSharedTypes(left).discussions)
    expect(inspection.healthy).toBe(false)
    expect(inspection.items[0].decision).toBe('conflicted')
    expect(inspection.conflictedRunIds).toEqual([request.runId])
  })

  it('fails closed when a decision targets a different or missing archive hash', async () => {
    const doc = createProjectDocument(manifest)
    await save(doc)
    getProjectSharedTypes(doc).discussions.set(
      'adversarial-review-decision:v1:hostile-hash',
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'hostile-hash',
        runId: request.runId,
        recordSha256: 'f'.repeat(64),
        expectedCurrentDecisionId: null,
        decision: 'accepted',
        participantId: 'hostile-peer',
        displayName: 'Hostile peer',
        notes: 'decision-note-secret-canary',
        timestamp: 40,
      }),
    )
    const inspection = await inspectAdversarialReviewHistory(getProjectSharedTypes(doc).discussions)
    expect(inspection.healthy).toBe(false)
    expect(inspection.conflictedRunIds).toEqual([request.runId])
    expect(inspection.items[0].decision).toBe('conflicted')
    expect(JSON.stringify(inspection)).not.toContain('decision-note-secret-canary')
  })

  it('counts hostile collaborative records without returning their bodies', async () => {
    const doc = createProjectDocument(manifest)
    getProjectSharedTypes(doc).discussions.set(
      'adversarial-review:v1:hostile',
      JSON.stringify({ runId: request.runId, prompt: 'archive-secret-canary' }),
    )
    const inspection = await inspectAdversarialReviewHistory(getProjectSharedTypes(doc).discussions)
    expect(inspection.invalidRecords).toBe(1)
    expect(inspection.healthy).toBe(false)
    expect(JSON.stringify(inspection)).not.toContain('archive-secret-canary')

    const nestedDoc = createProjectDocument(manifest)
    await save(nestedDoc)
    const nestedDiscussions = getProjectSharedTypes(nestedDoc).discussions
    const archiveKey = Array.from(nestedDiscussions.keys())
      .find((key) => key.startsWith('adversarial-review:v1:'))!
    const hostileArchive = JSON.parse(nestedDiscussions.get(archiveKey) as string)
    hostileArchive.outcome.record = null
    nestedDiscussions.set(archiveKey, JSON.stringify(hostileArchive))
    const nestedInspection = await inspectAdversarialReviewHistory(nestedDiscussions)
    expect(nestedInspection.invalidRecords).toBe(1)
    expect(nestedInspection.items).toEqual([])
  })
})
