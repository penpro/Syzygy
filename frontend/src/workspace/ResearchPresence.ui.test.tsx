import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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
