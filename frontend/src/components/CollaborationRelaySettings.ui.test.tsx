import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CollaborationRelaySettings } from './CollaborationRelaySettings'

describe('CollaborationRelaySettings', () => {
  it('separates lifecycle, persistence, and identity claims', () => {
    const html = renderToStaticMarkup(createElement(CollaborationRelaySettings))
    expect(html).toContain('App-managed research relay')
    expect(html).toContain('does not require Node.js or PowerShell')
    expect(html).toContain('bearer member capabilities')
    expect(html).toContain('Legacy rooms still use the room ID as one read/edit key')
    expect(html).toContain('Participant names are self-reported')
    expect(html).toContain('Awareness is never written')
    expect(html).toContain('not a backup')
  })
})
