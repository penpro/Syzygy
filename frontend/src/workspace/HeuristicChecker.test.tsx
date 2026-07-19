import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HeuristicCheckerContent } from './HeuristicChecker'
import type { HeuristicCheckResult } from './heuristicCheckResultModel'

const result: HeuristicCheckResult = {
  schemaVersion: 1,
  resultId: 'result-1', runId: 'run-1', projectId: 'project-1', documentId: 'document-1',
  heuristicId: 'heuristic-1', heuristicRevision: 'heuristic-revision', exampleRevision: 'example-revision',
  sourceRevision: 'policy-content-v1-source', providerId: 'openai', requestedModelId: 'requested-model',
  executedModelId: 'executed-model', verdict: 'uncertain', rationale: 'A source is named but not characterized.',
  uncertainty: 'The source quality cannot be established from the policy.',
  citations: [{ start: 4, end: 19, quote: 'named evidence' }],
  authorId: 'alice', authorDisplayName: 'Alice', timestamp: 1,
}

describe('heuristic checker product surface', () => {
  it('renders verdict, rationale, uncertainty, verified spans, and route provenance', () => {
    const html = renderToStaticMarkup(<HeuristicCheckerContent
      provider="openai" model="requested-model" localAvailable={false} phase="complete"
      message="Saved" results={[result]} onProvider={vi.fn()} onModel={vi.fn()} onRun={vi.fn()} onCancel={vi.fn()}
    />)
    expect(html).toContain('UNCERTAIN · openai · executed-model · Alice')
    expect(html).toContain('A source is named but not characterized.')
    expect(html).toContain('The source quality cannot be established')
    expect(html).toContain('Policy offsets 4–19')
    expect(html).toContain('named evidence')
    expect(html).toContain('Send once')
  })

  it('keeps manual research usable when local AI is unavailable', () => {
    const html = renderToStaticMarkup(<HeuristicCheckerContent
      provider="local" model="local-model" localAvailable={false} phase="idle"
      message="Ready" results={[]} onProvider={vi.fn()} onModel={vi.fn()} onRun={vi.fn()} onCancel={vi.fn()}
    />)
    expect(html).toContain('Shared heuristics and examples still work')
    expect(html).toContain('disabled=""')
  })
})
