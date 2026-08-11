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
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'explicit bounded MCP scenario index and one selected turn-revision body readback',
    )
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'explicit revision-guarded adversarial review archival and immutable human accept/reject history in the shared project',
    )
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'product and MCP scenario voting with best-effort registered-device exact-event attribution',
    )
    expect(AUTOMATION_CAPABILITIES.available).toContain(
      'product and MCP scenario annotation lifecycle with best-effort registered-device exact-event attribution',
    )
    expect(AUTOMATION_CAPABILITIES.available.join(' ')).not.toContain('MCP restore remains unavailable')
  })

  it('keeps only genuinely open attribution, generation, evaluation, embed, and presence work unavailable', () => {
    expect(AUTOMATION_CAPABILITIES.unavailable).toEqual([
      'durable device attribution for research event domains other than scenario votes and annotations',
      'scenario generation, response evaluation, and spotlight/embed workflows',
      'real-time collaborator presence',
    ])
  })
})
