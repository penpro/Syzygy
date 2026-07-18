import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanAgentSettings } from './LanAgentSettings'

describe('LanAgentSettings', () => {
  it('offers app-owned developer hosting while keeping the default outbound boundary honest', () => {
    const markup = renderToStaticMarkup(createElement(LanAgentSettings))
    expect(markup).toContain('Private LAN test connection')
    expect(markup).toContain('Host the collaboration developer network on this computer')
    expect(markup).toContain('starts and supervises the interconnect server with Syzygy')
    expect(markup).toContain('stops and reaps it during shutdown')
    expect(markup).toContain('PowerShell is diagnostic-only')
    expect(markup).toContain('outbound encrypted control connection')
    expect(markup).toContain('never opens a LAN listener')
    expect(markup).toContain('does not sync research data by itself')
    expect(markup).toContain('Apply developer connection')
  })
})
