import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ScenarioComparisonPanelContent } from './ScenarioComparisonPanel'
import type { ScenarioComparisonArtifact } from './scenarioComparison'

describe('scenario comparison product surface', () => {
  it('states exact compatibility, neutral interpretation, export contents, and side-by-side evidence', () => {
    const artifact = {
      artifactSha256: 'a'.repeat(64),
      summary: {
        scenarioCount: 1, changedOutcomeCount: 1, unchangedOutcomeCount: 0,
        outcomeMatrix: {
          handled: { handled: 0, unhandled: 1, uncertain: 0 },
          unhandled: { handled: 0, unhandled: 0, uncertain: 0 },
          uncertain: { handled: 0, unhandled: 0, uncertain: 0 },
        },
      },
      rows: [{
        scenarioId: 'appeal-case', scenarioRevisionSha256: 'b'.repeat(64), outcomeChanged: true,
        baseline: { outcome: 'handled', response: 'Baseline response', rationale: 'Baseline rationale',
          uncertainty: 'Baseline uncertainty', executedModelId: 'model-a', runId: 'run-a' },
        candidate: { outcome: 'unhandled', response: 'Candidate response', rationale: 'Candidate rationale',
          uncertainty: 'Candidate uncertainty', executedModelId: 'model-b', runId: 'run-b' },
      }],
    } as unknown as ScenarioComparisonArtifact
    const html = renderToStaticMarkup(<ScenarioComparisonPanelContent
      jobs={[]} baselineId="" candidateId="" artifact={artifact} busy={false}
      message="Comparison ready." error="" onBaseline={vi.fn()} onCandidate={vi.fn()}
      onCompare={vi.fn()} onExport={vi.fn()}
    />)
    expect(html).toContain('Baseline comparison')
    expect(html).toContain('same exact scenario revisions')
    expect(html).toContain('not scored as better or worse')
    expect(html).toContain('Outcome transition counts')
    expect(html).toContain('Baseline response')
    expect(html).toContain('Candidate uncertainty')
    expect(html).toContain('verified policy snapshots')
    expect(html).toContain('missing seed/sampler/model-hash fields')
    expect(html).toContain('SHA-256 checksum')
  })

  it('keeps export unavailable until an exact comparison exists', () => {
    const html = renderToStaticMarkup(<ScenarioComparisonPanelContent
      jobs={[]} baselineId="" candidateId="" artifact={null} busy={false}
      message="" error="" onBaseline={vi.fn()} onCandidate={vi.fn()}
      onCompare={vi.fn()} onExport={vi.fn()}
    />)
    expect(html).toContain('Complete two compatible rerun queues')
    expect(html).not.toContain('Export verifiable JSON')
  })
})
