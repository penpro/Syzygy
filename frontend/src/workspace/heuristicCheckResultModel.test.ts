import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import type { AutomationDocumentBlock } from './editorAutomationRegistry'
import { buildHeuristicCheckRequest, HEURISTIC_CHECK_CONTRACT_VERSION } from './heuristicCheck'
import {
  commitHeuristicCheckResult,
  heuristicCheckResultSha256,
  inspectHeuristicCheckResults,
  listHeuristicCheckResults,
  readHeuristicCheckResult,
} from './heuristicCheckResultModel'
import { createHeuristicExample, listActiveHeuristicExamples } from './heuristicExampleModel'
import { createHeuristic, updateHeuristic } from './heuristicsModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'check-project', documentId: 'check-document', timestamp: 1 })
const blocks: AutomationDocumentBlock[] = [
  { kind: 'policy', policyId: 'evidence-rule', status: 'review', text: 'Every claim must cite evidence.' },
  { kind: 'paragraph', text: 'Important uncertainty must be explicit.' },
]

function fixture(clientID?: number) {
  const doc = createProjectDocument(manifest)
  if (clientID) doc.clientID = clientID
  const { discussions, heuristics } = getProjectSharedTypes(doc)
  const heuristic = createHeuristic(heuristics, {
    id: 'evidence-quality', title: 'Evidence quality', guidance: 'Cite evidence and uncertainty.',
    priority: 'required', authorId: 'alice', timestamp: 1, editId: 'heuristic-create',
  })
  createHeuristicExample(discussions, heuristics, {
    eventId: 'example-event', exampleId: 'example-positive', heuristicId: heuristic.id,
    polarity: 'positive', body: 'A claim cites a study.', participantId: 'alice',
    displayName: 'Alice', timestamp: 2,
  })
  const request = buildHeuristicCheckRequest({
    runId: 'check-run', providerId: 'local', requestedModelId: 'model-a', project: manifest,
    heuristic, examples: listActiveHeuristicExamples(discussions, heuristic.id), blocks,
  })
  const quote = 'Every claim must cite evidence.'
  const start = request.policyText.indexOf(quote)
  const output = {
    contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION,
    runId: request.runId,
    providerId: request.providerId,
    requestedModelId: request.requestedModelId,
    executedModelId: 'model-a',
    verdict: 'pass' as const,
    rationale: 'The policy directly requires evidence.',
    uncertainty: 'This does not verify source quality.',
    citations: [{ start, end: start + quote.length, quote }],
  }
  return { doc, discussions, heuristics, heuristic, request, output }
}

describe('collaborative heuristic check results', () => {
  it('hashes and re-reads exact retained check results', async () => {
    const value = fixture()
    const result = commitHeuristicCheckResult(value.doc, value.request, value.output, {
      resultId: 'result-hash', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 3,
      currentBlocks: blocks,
    })
    expect(readHeuristicCheckResult(value.discussions, value.heuristic.id, result.resultId)).toEqual(result)
    const hash = await heuristicCheckResultSha256(result)
    await expect(heuristicCheckResultSha256({ ...result, rationale: 'Changed rationale' }))
      .resolves.not.toBe(hash)
  })

  it('commits an attributed route-bound result and replays the exact identity idempotently', () => {
    const value = fixture()
    const input = { resultId: 'result-1', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 3, currentBlocks: blocks }
    const first = commitHeuristicCheckResult(value.doc, value.request, value.output, input)
    expect(first).toMatchObject({ resultId: 'result-1', verdict: 'pass', providerId: 'local', authorId: 'alice' })
    expect(commitHeuristicCheckResult(value.doc, value.request, value.output, input)).toEqual(first)
    expect(inspectHeuristicCheckResults(value.discussions, value.heuristics)).toMatchObject({
      healthy: true, resultCount: 1, passCount: 1, remoteCount: 0,
    })
  })

  it('retains disconnected peer results after convergence', () => {
    const base = fixture()
    const snapshot = Y.encodeStateAsUpdate(base.doc)
    const left = new Y.Doc({ guid: manifest.documentId }); left.clientID = 101; Y.applyUpdate(left, snapshot)
    const right = new Y.Doc({ guid: manifest.documentId }); right.clientID = 202; Y.applyUpdate(right, snapshot)
    commitHeuristicCheckResult(left, base.request, base.output, {
      resultId: 'left-result', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 4, currentBlocks: blocks,
    })
    commitHeuristicCheckResult(right, base.request, { ...base.output, verdict: 'uncertain' }, {
      resultId: 'right-result', authorId: 'bob', authorDisplayName: 'Bob', timestamp: 5, currentBlocks: blocks,
    })
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right)); Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    expect(listHeuristicCheckResults(getProjectSharedTypes(left).discussions, base.heuristic.id).map(({ resultId }) => resultId))
      .toEqual(['left-result', 'right-result'])
    expect(inspectHeuristicCheckResults(getProjectSharedTypes(left).discussions, getProjectSharedTypes(left).heuristics))
      .toMatchObject({ healthy: true, resultCount: 2, passCount: 1, uncertainCount: 1 })
  })

  it('fails closed when the policy, heuristic, examples, or result identity changes', () => {
    const stalePolicy = fixture()
    expect(() => commitHeuristicCheckResult(stalePolicy.doc, stalePolicy.request, stalePolicy.output, {
      resultId: 'stale-policy', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 4,
      currentBlocks: [{ kind: 'paragraph', text: 'Changed policy.' }],
    })).toThrow('Policy changed')

    const staleHeuristic = fixture()
    updateHeuristic(staleHeuristic.heuristics, {
      id: staleHeuristic.heuristic.id, authorId: 'bob', timestamp: 5, editId: 'heuristic-edit',
      changes: { guidance: 'Changed guidance.' },
    })
    expect(() => commitHeuristicCheckResult(staleHeuristic.doc, staleHeuristic.request, staleHeuristic.output, {
      resultId: 'stale-heuristic', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 6, currentBlocks: blocks,
    })).toThrow('Heuristic changed')

    const staleExamples = fixture()
    createHeuristicExample(staleExamples.discussions, staleExamples.heuristics, {
      eventId: 'late-example-event', exampleId: 'late-example', heuristicId: staleExamples.heuristic.id,
      polarity: 'negative', body: 'A late counterexample.', participantId: 'bob', displayName: 'Bob', timestamp: 5,
    })
    expect(() => commitHeuristicCheckResult(staleExamples.doc, staleExamples.request, staleExamples.output, {
      resultId: 'stale-examples', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 6, currentBlocks: blocks,
    })).toThrow('examples changed')

    const collision = fixture()
    const input = { resultId: 'collision', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 3, currentBlocks: blocks }
    commitHeuristicCheckResult(collision.doc, collision.request, collision.output, input)
    expect(() => commitHeuristicCheckResult(collision.doc, collision.request, { ...collision.output, verdict: 'fail' }, input))
      .toThrow('result ID was reused')
  })

  it('reports hostile buckets without exposing result bodies', () => {
    const value = fixture()
    const hostile = new Y.Map<unknown>()
    hostile.set('heuristicId', value.heuristic.id)
    hostile.set('results', new Y.Map<unknown>())
    hostile.set('ambient', 'bad')
    value.discussions.set('heuristic-check-results:v1:hostile', hostile)
    expect(inspectHeuristicCheckResults(value.discussions, value.heuristics)).toMatchObject({
      healthy: false, invalidRecords: 2,
    })
  })
})
