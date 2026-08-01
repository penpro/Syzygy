import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ScenarioGeneratorContent, type ScenarioGeneratorContentProps } from './ScenarioGenerator'

const props = (): ScenarioGeneratorContentProps => ({
  provider: 'local', model: 'local-model', instructions: 'Continue carefully.', localAvailable: true,
  phase: 'idle', message: 'Ready.', generationDisabled: false, generationBlockReason: '',
  onProvider: vi.fn(), onModel: vi.fn(),
  onInstructions: vi.fn(), onGenerate: vi.fn(), onCancel: vi.fn(),
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

  it('hosts the shared editable response workspace after the generation controls', () => {
    const html = renderToStaticMarkup(<ScenarioGeneratorContent
      {...props()}
      responseWorkspace={<section aria-label="Shared scenario responses">Editable attributed history</section>}
    />)
    expect(html).toContain('Generate a response')
    expect(html).toContain('Shared scenario responses')
    expect(html).toContain('Editable attributed history')
    expect(html.indexOf('Ready.')).toBeLessThan(html.indexOf('Editable attributed history'))
  })

  it('disables generation before provider work when shared response integrity fails', () => {
    const html = renderToStaticMarkup(<ScenarioGeneratorContent
      {...props()}
      generationDisabled
      generationBlockReason="1 scenario response record failed validation"
    />)
    expect(html).toContain('Response generation is paused')
    expect(html).toContain('failed validation')
    expect(html).toMatch(/type="button" disabled="">Generate variant/)
  })
})
