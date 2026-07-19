import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HeuristicWorkspaceContent, type HeuristicWorkspaceContentProps } from './HeuristicWorkspace'

const props = (): HeuristicWorkspaceContentProps => ({
  ready: true,
  heuristics: [{ schemaVersion: 1, id: 'evidence-quality', title: 'Evidence quality', guidance: 'Cite evidence.', priority: 'required', enabled: true, createdBy: 'researcher', createdAt: 1, edits: [] }],
  selectedId: 'evidence-quality', examples: [], title: '', guidance: '', priority: 'recommended',
  polarity: 'positive', exampleBody: '', error: '', onSelect: vi.fn(), onTitle: vi.fn(),
  onGuidance: vi.fn(), onPriority: vi.fn(), onCreateHeuristic: vi.fn(), onPolarity: vi.fn(),
  onExampleBody: vi.fn(), onAddExample: vi.fn(), onRemoveExample: vi.fn(),
})

describe('heuristic examples product surface', () => {
  it('keeps heuristic and positive/negative example work engine-free and collaborative', () => {
    const html = renderToStaticMarkup(<HeuristicWorkspaceContent {...props()} />)
    expect(html).toContain('Shared evaluation examples')
    expect(html).toContain('work without AI')
    expect(html).toContain('Positive · follows the heuristic')
    expect(html).toContain('Negative · violates the heuristic')
    expect(html).toContain('Add shared example')
    expect(html).toContain('identity is not authenticated')
  })

  it('renders attributed polarity while keeping removal explicit', () => {
    const html = renderToStaticMarkup(<HeuristicWorkspaceContent {...props()} examples={[{
      id: 'example-1', heuristicId: 'evidence-quality', polarity: 'negative', body: 'Unsupported claim.',
      status: 'active', createdBy: 'researcher-1', createdByDisplayName: 'Researcher One', createdAt: 1,
      currentEventId: 'event-1', events: [],
    }]} />)
    expect(html).toContain('negative')
    expect(html).toContain('Unsupported claim.')
    expect(html).toContain('Researcher One')
    expect(html).toContain('Remove')
  })

  it('reports loading and mutation failure accessibly', () => {
    const html = renderToStaticMarkup(<HeuristicWorkspaceContent {...props()} ready={false} error="Peer example failed validation" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Peer example failed validation')
  })
})
