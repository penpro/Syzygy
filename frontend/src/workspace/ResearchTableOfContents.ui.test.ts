import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ResearchTableOfContentsContent } from './ResearchTableOfContents'

const render = (headings: Parameters<typeof ResearchTableOfContentsContent>[0]['headings']) =>
  renderToStaticMarkup(createElement(ResearchTableOfContentsContent, { headings, onSelect: vi.fn() }))

describe('research table of contents UI contract', () => {
  it('renders a labeled live outline with nested heading controls', () => {
    const html = render([
      { key: 'heading-1', level: 1, text: 'Research policy' },
      { key: 'heading-2', level: 2, text: 'Evidence' },
    ])
    expect(html).toContain('aria-label="Document outline"')
    expect(html).toContain('Research policy')
    expect(html).toContain('Evidence')
    expect(html).toContain('class="nested"')
  })

  it('renders an honest empty state and substitutes an untitled label', () => {
    expect(render([])).toContain('Add a heading to build this outline.')
    expect(render([{ key: 'heading-empty', level: 2, text: '  ' }])).toContain('Untitled heading')
  })
})
