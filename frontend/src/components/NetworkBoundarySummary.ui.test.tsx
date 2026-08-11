import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NetworkBoundarySummary } from './NetworkBoundarySummary'

describe('NetworkBoundarySummary', () => {
  it('states every optional network boundary and keeps local, remote, Drive, and control paths distinct', () => {
    const html = renderToStaticMarkup(createElement(NetworkBoundarySummary))
    expect(html).toContain('aria-label="Network boundaries"')
    expect(html).toContain('Loopback on this computer only')
    expect(html).toContain('choose Send once')
    expect(html).toContain('Google OAuth, Drive, and Sheets services')
    expect(html).toContain('The WS/WSS relay endpoint in the invitation')
    expect(html).toContain('The invitation is the access key')
    expect(html).toContain('Hugging Face for models; GitHub for signed Syzygy releases')
    expect(html).toContain('Only after you opt in and an unexpected error occurs')
    expect(html).toContain('The control link does not sync research data by itself')
    expect(html).toContain('remote AI is never automatic')
  })
})
