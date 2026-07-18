import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanAgentSettings } from './LanAgentSettings'

describe('LanAgentSettings', () => {
  it('explains the opt-in outbound control boundary without claiming project sync', () => {
    const markup = renderToStaticMarkup(createElement(LanAgentSettings))
    expect(markup).toContain('Private LAN test connection')
    expect(markup).toContain('outbound encrypted control connection')
    expect(markup).toContain('never opens a LAN listener')
    expect(markup).toContain('does not sync research data by itself')
    expect(markup).toContain('Apply connection')
  })
})
