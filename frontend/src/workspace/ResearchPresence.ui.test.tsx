import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DevicePresenceProof } from '../tauri'
import type { PresenceInspection } from './presenceModel'
import { ResearchPresenceView } from './ResearchPresence'

const inspection: PresenceInspection = {
  healthy: true,
  totalRecords: 2,
  invalidRecords: 0,
  truncated: false,
  participants: [
    { clientId: 1, participantId: 'ada', displayName: 'Ada', focusing: true, local: true, deviceProof: null },
    { clientId: 2, participantId: 'bob', displayName: 'Bob', focusing: false, local: false, deviceProof: null },
  ],
}

const deviceProof: DevicePresenceProof = {
  schemaVersion: 1,
  algorithm: 'Ed25519',
  keyId: `ed25519-sha256:${'A'.repeat(43)}`,
  publicKey: 'A'.repeat(43),
  claim: {
    schemaVersion: 1,
    projectId: 'project-a',
    documentId: 'document-a',
    participantId: 'bob',
    awarenessClientId: 2,
    sessionNonce: 'A'.repeat(43),
  },
  signature: 'A'.repeat(86),
}

const signedRemoteInspection: PresenceInspection = {
  ...inspection,
  participants: inspection.participants.map((participant) =>
    participant.clientId === 2 ? { ...participant, deviceProof } : participant),
}

describe('research presence surface', () => {
  it('renders live participants with explicit ephemeral and unauthenticated copy', () => {
    const html = renderToStaticMarkup(<ResearchPresenceView mode="live" inspection={inspection} />)
    expect(html).toContain('2 live editing sessions')
    expect(html).toContain('Ada · this device')
    expect(html).toContain('Bob · viewing')
    expect(html).toContain('unsigned device')
    expect(html).toContain('does not verify a person')
    expect(html).toContain('Names remain self-reported')
  })

  it('distinguishes verified installation keys from invalid proofs without claiming a person', () => {
    const html = renderToStaticMarkup(<ResearchPresenceView
      mode="live"
      inspection={inspection}
      proofStatuses={new Map([[1, 'verified-device'], [2, 'invalid']])}
    />)
    expect(html).toContain('Ada · this device · signed device')
    expect(html).toContain('Bob · viewing · invalid device proof')
    expect(html).toContain('does not verify a person')
  })

  it('shows local project-scoped approval, revocation, fingerprint, and explicit non-authorization controls', () => {
    const unapproved = renderToStaticMarkup(<ResearchPresenceView
      mode="live"
      inspection={signedRemoteInspection}
      proofStatuses={new Map([[2, 'verified-device']])}
      trustStatuses={new Map([[2, 'unapproved']])}
      onApproveDevice={() => {}}
    />)
    expect(unapproved).toContain('key not approved')
    expect(unapproved).toContain('key AAAAAAAAAAAA')
    expect(unapproved).toContain('Approve key')
    expect(unapproved).toContain('do not grant or remove relay access')

    const busy = renderToStaticMarkup(<ResearchPresenceView
      mode="live"
      inspection={signedRemoteInspection}
      proofStatuses={new Map([[2, 'verified-device']])}
      trustStatuses={new Map([[2, 'unapproved']])}
      busyKeyId="another-device-key"
      onApproveDevice={() => {}}
    />)
    expect(busy).toContain('disabled=""')

    const approved = renderToStaticMarkup(<ResearchPresenceView
      mode="live"
      inspection={signedRemoteInspection}
      proofStatuses={new Map([[2, 'verified-device']])}
      trustStatuses={new Map([[2, 'approved']])}
      onRevokeDevice={() => {}}
    />)
    expect(approved).toContain('key approved locally')
    expect(approved).toContain('Revoke key')

    const revoked = renderToStaticMarkup(<ResearchPresenceView
      mode="live"
      inspection={signedRemoteInspection}
      proofStatuses={new Map([[2, 'verified-device']])}
      trustStatuses={new Map([[2, 'revoked']])}
      onApproveDevice={() => {}}
    />)
    expect(revoked).toContain('key revoked locally')
    expect(revoked).toContain('Re-approve key')
  })

  it('does not misrepresent Drive polling or a local project as live presence', () => {
    const drive = renderToStaticMarkup(<ResearchPresenceView mode="drive-polling" inspection={inspection} />)
    const local = renderToStaticMarkup(<ResearchPresenceView mode="local-only" inspection={inspection} />)
    expect(drive).toContain('does not provide live cursors or online status')
    expect(local).toContain('No remote editing sessions are connected')
    expect(drive).not.toContain('live editing sessions')
  })

  it('keeps malformed peer state visible as a bounded accessible warning', () => {
    const html = renderToStaticMarkup(<ResearchPresenceView mode="live" inspection={{
      ...inspection, healthy: false, invalidRecords: 2, truncated: true,
    }} />)
    expect(html).toContain('2 invalid or excess presence records hidden')
    expect(html).toContain('role="alert"')
  })
})
