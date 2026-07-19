import { describe, expect, it, vi } from 'vitest'
import type { AutomationDocumentBlock } from './editorAutomationRegistry'
import type { HeuristicExampleHistory } from './heuristicExampleModel'
import type { ResearchHeuristic } from './heuristicsModel'
import {
  buildHeuristicCheckRequest,
  HEURISTIC_CHECK_CONTRACT_VERSION,
  heuristicCheckPolicyText,
  runHeuristicCheck,
  validateHeuristicCheckOutput,
  type HeuristicCheckAdapter,
  type HeuristicCheckOutput,
} from './heuristicCheck'
import { createProjectManifest } from './schema'

const project = createProjectManifest({ id: 'check-project', documentId: 'check-document', timestamp: 1 })
const heuristic: ResearchHeuristic = {
  schemaVersion: 1,
  id: 'evidence-quality',
  title: 'Evidence quality',
  guidance: 'Claims must cite evidence and state material uncertainty.',
  priority: 'required',
  enabled: true,
  createdBy: 'researcher-1',
  createdAt: 1,
  edits: [{
    editId: 'create-heuristic', authorId: 'researcher-1', timestamp: 1,
    fields: ['title', 'guidance', 'priority', 'enabled'],
    changes: { title: 'Evidence quality', guidance: 'Claims must cite evidence and state material uncertainty.', priority: 'required', enabled: true },
  }],
}
const examples: HeuristicExampleHistory[] = [{
  id: 'positive-example',
  heuristicId: heuristic.id,
  polarity: 'positive',
  body: 'The estimate cites a primary study and states its confidence interval.',
  status: 'active',
  createdBy: 'researcher-1',
  createdByDisplayName: 'Researcher One',
  createdAt: 2,
  currentEventId: 'positive-event',
  events: [],
}, {
  id: 'negative-example',
  heuristicId: heuristic.id,
  polarity: 'negative',
  body: 'The claim says experts agree without a source or uncertainty.',
  status: 'active',
  createdBy: 'researcher-2',
  createdByDisplayName: 'Researcher Two',
  createdAt: 3,
  currentEventId: 'negative-event',
  events: [],
}]
const blocks: AutomationDocumentBlock[] = [
  { kind: 'heading1', text: 'Evidence policy' },
  { kind: 'policy', policyId: 'source-rule', status: 'review', text: 'Every material claim must cite a traceable source.' },
  { kind: 'paragraph', text: 'Residual uncertainty must be stated explicitly.' },
  { kind: 'suggestion', text: '', suggestionId: 'ignored-review-card' },
]

const request = () => buildHeuristicCheckRequest({
  runId: 'heuristic-run-1',
  providerId: 'local',
  requestedModelId: 'local-model',
  project,
  heuristic,
  examples,
  blocks,
})

function validOutput(): HeuristicCheckOutput {
  const built = request()
  const quote = 'Every material claim must cite a traceable source.'
  const start = built.policyText.indexOf(quote)
  return {
    contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION,
    runId: built.runId,
    providerId: built.providerId,
    requestedModelId: built.requestedModelId,
    executedModelId: 'local-model',
    verdict: 'pass',
    rationale: 'The policy creates a direct evidence requirement.',
    uncertainty: 'This structural check does not establish whether future citations are credible.',
    citations: [{ start, end: start + quote.length, quote }],
  }
}

describe('provider-neutral explainable heuristic check contract', () => {
  it('builds an exact bounded policy, heuristic, and positive/negative example snapshot', () => {
    const built = request()
    expect(built.policyText).toContain('[Policy source-rule · review]')
    expect(built.policyText).not.toContain('ignored-review-card')
    expect(built.examples.map(({ id, polarity }) => [id, polarity])).toEqual([
      ['negative-example', 'negative'],
      ['positive-example', 'positive'],
    ])
    expect(built.heuristicRevision).toContain('create-heuristic')
    expect(built.exampleRevision).toContain('positive-event')
    expect(built.sourceRevision).toMatch(/^policy-content-v1-/)
    expect(heuristicCheckPolicyText(blocks)).toBe(built.policyText)
  })

  it('accepts only route-bound verdict, rationale, uncertainty, and exact quoted spans', () => {
    expect(validateHeuristicCheckOutput(request(), validOutput())).toEqual(validOutput())
    const output = validOutput()
    expect(() => validateHeuristicCheckOutput(request(), { ...output, runId: 'other-run' })).toThrow('route or result schema')
    expect(() => validateHeuristicCheckOutput(request(), { ...output, uncertainty: '' })).toThrow('route or result schema')
    expect(() => validateHeuristicCheckOutput(request(), { ...output, ambientCommand: 'delete files' })).toThrow('invalid response envelope')
    expect(() => validateHeuristicCheckOutput(request(), {
      ...output,
      citations: [{ ...output.citations[0], quote: 'fabricated quote' }],
    })).toThrow('citation does not match')
    expect(() => validateHeuristicCheckOutput(request(), {
      ...output,
      citations: [output.citations[0], { ...output.citations[0] }],
    })).toThrow('citation does not match')
  })

  it('repairs one malformed structured result and never exceeds two attempts', async () => {
    const good = validOutput()
    const evaluate = vi.fn(async (_request, _signal, attempt) => attempt === 1
      ? { ...good, citations: [{ ...good.citations[0], quote: 'wrong' }] }
      : good)
    const adapter: HeuristicCheckAdapter = { providerId: 'local', evaluate }
    await expect(runHeuristicCheck(adapter, request(), new AbortController().signal)).resolves.toEqual(good)
    expect(evaluate).toHaveBeenCalledTimes(2)

    const invalid: HeuristicCheckAdapter = {
      providerId: 'local',
      evaluate: vi.fn(async () => ({ malformed: true })),
    }
    await expect(runHeuristicCheck(invalid, request(), new AbortController().signal))
      .rejects.toThrow('after 2 attempts')
    expect(invalid.evaluate).toHaveBeenCalledTimes(2)
  })

  it('honors cancellation and route binding without invoking an adapter', async () => {
    const adapter: HeuristicCheckAdapter = { providerId: 'openai', evaluate: vi.fn() }
    await expect(runHeuristicCheck(adapter, request(), new AbortController().signal)).rejects.toThrow('route mismatch')
    expect(adapter.evaluate).not.toHaveBeenCalled()
    const local: HeuristicCheckAdapter = { providerId: 'local', evaluate: vi.fn() }
    const controller = new AbortController()
    controller.abort()
    await expect(runHeuristicCheck(local, request(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(local.evaluate).not.toHaveBeenCalled()
  })

  it('rejects disabled, empty, control-byte, and oversized inputs before provider work', () => {
    expect(() => buildHeuristicCheckRequest({
      runId: 'disabled-run', providerId: 'local', requestedModelId: 'local-model', project,
      heuristic: { ...heuristic, enabled: false }, examples, blocks,
    })).toThrow('Disabled')
    expect(() => heuristicCheckPolicyText([{ kind: 'paragraph', text: '' }])).toThrow('non-empty')
    expect(() => heuristicCheckPolicyText([{ kind: 'paragraph', text: 'bad\u0000text' }])).toThrow('non-empty')
    expect(() => heuristicCheckPolicyText([{ kind: 'paragraph', text: 'x'.repeat(500_001) }])).toThrow('non-empty')
  })
})
