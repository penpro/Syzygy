import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PolicyContentBridgeNotice } from './PolicyContentBridgeProvider'

describe('stable policy content product notice', () => {
  it('renders nothing for a healthy fully stable document', () => {
    expect(renderToStaticMarkup(<PolicyContentBridgeNotice state={{
      healthy: true,
      error: null,
      stablePolicyCount: 2,
      legacyPolicyIds: [],
    }} />)).toBe('')
  })

  it('keeps legacy and invalid shared documents visibly reorder-closed', () => {
    const legacy = renderToStaticMarkup(<PolicyContentBridgeNotice state={{
      healthy: true,
      error: null,
      stablePolicyCount: 1,
      legacyPolicyIds: ['policy-a', 'policy-b'],
    }} />)
    expect(legacy).toContain('2 legacy policy blocks')
    expect(legacy).toContain('Reordering stays paused')
    expect(legacy).toContain('role="status"')

    const invalid = renderToStaticMarkup(<PolicyContentBridgeNotice state={{
      healthy: false,
      error: 'Policy content record attributes are malformed',
      stablePolicyCount: 0,
      legacyPolicyIds: [],
    }} />)
    expect(invalid).toContain('Stable policy content is unavailable')
    expect(invalid).toContain('role="alert"')
    expect(invalid).toContain('record attributes are malformed')
  })
})
