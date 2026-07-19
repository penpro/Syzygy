import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ScenarioGeneratorContent, type ScenarioGeneratorContentProps } from './ScenarioGenerator'

const props = (): ScenarioGeneratorContentProps => ({
  provider: 'local', model: 'local-model', instructions: 'Continue carefully.', localAvailable: true,
  phase: 'idle', message: 'Ready.', responses: [], onProvider: vi.fn(), onModel: vi.fn(),
  onInstructions: vi.fn(), onGenerate: vi.fn(), onRegenerate: vi.fn(), onCancel: vi.fn(),
})

describe('scenario generator product surface', () => {
  it('keeps local, API, and no-AI/manual paths explicit', () => {
    const html = renderToStaticMarkup(<ScenarioGeneratorContent {...props()} localAvailable={false} />)
    expect(html).toContain('Local model · this computer')
    expect(html).toContain('OpenAI API · Send once approval')
    expect(html).toContain('Manual scenario work still functions')
    expect(html).toContain('Nothing is applied to the policy draft')
    expect(html).toContain('disabled=""')
  })

  it('renders attributed response variants without claiming they changed policy', () => {
    const html = renderToStaticMarkup(<ScenarioGeneratorContent {...props()} responses={[{
      id: 'response-1', scenarioId: 'scenario-1', createdBy: 'model-local', createdByDisplayName: 'Local model',
      createdAt: 1, currentRevisionId: 'revision-1', content: 'Generated variant.', revisions: [{
        schemaVersion: 1, revisionId: 'revision-1', responseId: 'response-1', scenarioId: 'scenario-1',
        parentRevisionId: null, content: 'Generated variant.', authorId: 'model-local', authorDisplayName: 'Local model',
        timestamp: 1, sourceKind: 'model', providerId: 'local', modelId: 'local-model', runId: 'run-1',
      }],
    }]} />)
    expect(html).toContain('local · local-model')
    expect(html).toContain('Generated variant.')
    expect(html).toContain('1 revision')
    expect(html).toContain('Regenerate')
    expect(html).toContain('Variant lineage · 1 retained')
    expect(html).toContain('parent root')
  })
})
