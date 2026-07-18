import { describe, expect, it } from 'vitest'
import { AUTOMATION_CAPABILITIES } from './automationCapabilities'

describe('live MCP capability self-description', () => {
  it('reports shipped version, restore, scenario UI, and stable-link surfaces as available', () => {
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'product version save, restore-as-new-head, and engine-free diff controls',
    )
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'product scenario gallery, editing, voting, and stable-ID scenario links',
    )
    expect(AUTOMATION_CAPABILITIES.available.join(' ')).not.toContain('MCP restore remains unavailable')
  })

  it('keeps only genuinely open generation, evaluation, embed, and presence work unavailable', () => {
    expect(AUTOMATION_CAPABILITIES.unavailable).toEqual([
      'scenario generation, response evaluation, and spotlight/embed workflows',
      'real-time collaborator presence',
    ])
  })
})