import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DevicePresenceProof } from '../tauri'
import type { PresenceInspection } from './presenceModel'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import { ProjectDeviceDirectoryView, ResearchPresenceView } from './ResearchPresence'

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

const directoryInspection: ProjectDeviceDirectoryInspection = {
  healthy: true,
  registrationCount: 1,
  verifiedRegistrations: [{
    keyId: deviceProof.keyId,
    publicKey: deviceProof.publicKey,
    participantId: 'alice',
  }],
  devices: [{
    keyId: deviceProof.keyId,
    publicKey: deviceProof.publicKey,
    fingerprint: 'A'.repeat(43),
    participantIds: ['alice'],
    registrationCount: 1,
    status: 'registered-device',
  }],
  conflictingDevices: 0,
  invalidRecords: 0,
  unavailableRecords: 0,
  excessRecords: 0,
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

describe('project device directory surface', () => {
  it('requires explicit registration and discloses persistence, correlation, identity, role, and access boundaries', () => {
    const html = renderToStaticMarkup(<ProjectDeviceDirectoryView
      mode="drive-polling"
      inspection={{ ...directoryInspection, registrationCount: 0, verifiedRegistrations: [], devices: [] }}
      state="ready"
      localKeyId={deviceProof.keyId}
      identityState="ready"
      trustState="ready"
      participantId="alice"
      onRegister={() => {}}
    />)
    expect(html).toContain('Register this device in project')
    expect(html).toContain('stable public fingerprint')
    expect(html).toContain('correlate this installation across projects')
    expect(html).toContain('Registration does not verify a person or assign a role')
    expect(html).toContain('does not grant or remove relay access')
  })

  it('shows durable registered state, short fingerprint, conflicts, and fail-closed health', () => {
    const registered = renderToStaticMarkup(<ProjectDeviceDirectoryView
      mode="live"
      inspection={directoryInspection}
      state="ready"
      localKeyId={deviceProof.keyId}
      identityState="ready"
      trustState="ready"
      participantId="alice"
    />)
    expect(registered).toContain('1 signed device key registered in shared project state')
    expect(registered).toContain('key AAAAAAAAAAAA')
    expect(registered).toContain('this device key')
    expect(registered).toContain('This installation key is registered')

    const approvedRemote = renderToStaticMarkup(<ProjectDeviceDirectoryView
      mode="drive-polling"
      inspection={directoryInspection}
      state="ready"
      localKeyId={`ed25519-sha256:${'B'.repeat(43)}`}
      identityState="ready"
      trustState="ready"
      trustDecisions={new Map([[deviceProof.keyId, 'approved']])}
      participantId="local-researcher"
      onRevokeDevice={() => {}}
    />)
    expect(approvedRemote).toContain('key approved locally')
    expect(approvedRemote).toContain('Revoke key')

    const unhealthy = renderToStaticMarkup(<ProjectDeviceDirectoryView
      mode="live"
      inspection={{
        ...directoryInspection,
        healthy: false,
        conflictingDevices: 1,
        invalidRecords: 1,
        devices: [{
          ...directoryInspection.devices[0],
          participantIds: ['alice', 'mallory'],
          status: 'participant-claim-conflict',
        }],
      }}
      state="ready"
      localKeyId={null}
      identityState="unavailable"
      trustState="ready"
      participantId="alice"
      onRegister={() => {}}
    />)
    expect(unhealthy).toContain('Registration is blocked')
    expect(unhealthy).toContain('conflicting self-reported names')
    expect(unhealthy).toContain('OS device identity is unavailable')
    expect(unhealthy).toContain('disabled=""')
  })

  it('does not expose the shared directory in a local-only project', () => {
    expect(renderToStaticMarkup(<ProjectDeviceDirectoryView
      mode="local-only"
      inspection={directoryInspection}
      state="ready"
      localKeyId={deviceProof.keyId}
      identityState="ready"
      trustState="ready"
      participantId="alice"
    />)).toBe('')
  })
})
