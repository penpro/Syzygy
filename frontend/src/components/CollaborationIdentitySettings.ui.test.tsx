import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CollaborationIdentitySettings } from './CollaborationIdentitySettings'

describe('CollaborationIdentitySettings', () => {
  it('states the device-only trust boundary before native status loads', () => {
    const html = renderToStaticMarkup(createElement(CollaborationIdentitySettings))
    expect(html).toContain('Signed device identity')
    expect(html).toContain('persisted only')
    expect(html).toContain('not a verified person or organization')
    expect(html).toContain('Researcher names remain self-reported')
    expect(html).toContain('public installation key')
    expect(html).toContain('copied invitation cannot connect from another installation')
  })
})
