import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SharedRelayAdminDecisionHistory } from './SelfHostedProjectControls'
import type { ProjectRelayAdminDecisionInspection } from './projectRelayAdminDecision'

const inspection: ProjectRelayAdminDecisionInspection = {
  healthy: true,
  decisionCount: 1,
  conflictingRevisions: 0,
  invalidRecords: 0,
  unavailableRecords: 0,
  excessRecords: 0,
  decisions: [{
    storageKey: 'decision-one',
    participantIds: ['participant-admin'],
    action: { kind: 'revoke', memberId: 'member_aaaaaaaaaaaaaaaaaaaaaa' },
    proof: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: `ed25519-sha256:${'k'.repeat(43)}`,
      publicKey: 'p'.repeat(43),
      signature: 's'.repeat(86),
      claim: {
        schemaVersion: 1,
        projectId: 'project-a',
        roomId: 'r'.repeat(43),
        administratorMemberId: 'a'.repeat(22),
        expectedRevision: 4,
        resultingRevision: 5,
        affectedMemberId: 'member_aaaaaaaaaaaaaaaaaaaaaa',
        actionSha256: 'h'.repeat(43),
        recordedAtMs: 1_750_000_000_000,
        decisionNonce: 'n'.repeat(43),
      },
    },
  }],
}

describe('shared relay administration history UI contract', () => {
  it('distinguishes installation statements from relay or human authority', () => {
    const html = renderToStaticMarkup(<SharedRelayAdminDecisionHistory inspection={inspection} />)
    expect(html).toContain('Shared signed decisions · 1')
    expect(html).toContain('The relay remains the membership authority')
    expect(html).toContain('are not relay receipts')
    expect(html).toContain('do not establish a person or organization')
    expect(html).toContain('Revision 5')
    expect(html).toContain('revoked member')
  })

  it('renders contradictory history as an accessible read-only warning', () => {
    const html = renderToStaticMarkup(<SharedRelayAdminDecisionHistory inspection={{
      ...inspection,
      healthy: false,
      decisionCount: 2,
      conflictingRevisions: 1,
    }} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('history is read-only')
    expect(html).toContain('1 conflicting revision records')
  })
})
