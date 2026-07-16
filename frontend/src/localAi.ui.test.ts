import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SetupWizard } from './components/SetupWizard'
import { LocalAiToggle } from './components/ModelBar'

describe('local AI visible states', () => {
  it('offers an explicit first-run path with no local model', () => {
    const html = renderToStaticMarkup(
      createElement(SetupWizard, { onReady: () => {}, onSkip: () => {} }),
    )
    expect(html).toContain('Continue without local AI')
    expect(html).toContain('use projects or remote API providers')
  })

  it('renders an accessible off switch for the title-bar statistics surface', () => {
    const html = renderToStaticMarkup(
      createElement(LocalAiToggle, { enabled: false, busy: false, onToggle: () => {} }),
    )
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Turn local AI on')
    expect(html).toContain('LOCAL AI')
  })
})
