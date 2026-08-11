import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  collaborationRelayMemberIssue,
  collaborationRelayMemberRevoke,
  collaborationRelayMemberRotate,
  collaborationRelayRoomCreate,
  collaborationRelayRoomStatus,
  collaborationRelaySettings,
  collaborationIdentityStatus,
  desktopRuntimeAvailable,
  type RelayDeviceBinding,
  type RelayMemberCredential,
  type RelayMemberRole,
  type RelayRoomMembershipReport,
} from '../tauri'
import type { ResearchProjectManifest } from './schema'
import {
  createWebsocketRoomId,
  normalizeWebsocketProjectBinding,
  type ManagedRelayAccess,
} from './websocketProjectBinding'
import {
  createManagedWebsocketProjectInvite,
  createWebsocketProjectInvite,
  parseWebsocketProjectInvite,
} from './websocketProjectInvite'
import {
  getWebsocketProjectStatus,
  subscribeWebsocketProjectStatus,
  type WebsocketProjectStatus,
} from './websocketProjectStatus'
import { parseRelayDeviceEnrollment } from './relayDeviceEnrollment'

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function connectionLabel(status: WebsocketProjectStatus | null): string {
  if (!status || status.state === 'connecting') return 'Self-hosted relay · connecting'
  if (status.state === 'connected') return 'Self-hosted relay · live'
  if (status.state === 'disconnected') return 'Self-hosted relay · offline copy available'
  return 'Self-hosted relay · connection failed'
}

function memberAccess(credential: RelayMemberCredential): ManagedRelayAccess {
  const common = {
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
  }
  if (credential.schemaVersion === 3) {
    if (!credential.deviceKeyId) throw new Error('Relay returned a bound credential without its device key ID')
    return {
      schemaVersion: 3,
      ...common,
      capabilityGeneration: credential.capabilityGeneration,
      expiresAtMs: credential.expiresAtMs,
      deviceKeyId: credential.deviceKeyId,
    }
  }
  return {
    schemaVersion: credential.schemaVersion,
    ...common,
    capabilityGeneration: credential.capabilityGeneration,
    expiresAtMs: credential.expiresAtMs,
  }
}

async function localDeviceBinding(): Promise<RelayDeviceBinding | null> {
  try {
    const identity = await collaborationIdentityStatus()
    return {
      schemaVersion: 1,
      algorithm: identity.algorithm,
      keyId: identity.keyId,
      publicKey: identity.publicKey,
    }
  } catch {
    return null
  }
}

function expirationCopy(expiresAtMs: number | null): string {
  if (expiresAtMs === null) return 'no automatic expiry'
  const timestamp = new Date(expiresAtMs).toISOString()
  return expiresAtMs <= Date.now() ? `expired ${timestamp}` : `expires ${timestamp}`
}

function useWebsocketProjectStatus(projectId: string | null): WebsocketProjectStatus | null {
  const [status, setStatus] = useState<WebsocketProjectStatus | null>(
    () => projectId ? getWebsocketProjectStatus(projectId) : null,
  )
  useEffect(() => {
    if (!projectId) {
      setStatus(null)
      return
    }
    const update = () => setStatus(getWebsocketProjectStatus(projectId))
    update()
    return subscribeWebsocketProjectStatus(projectId, update)
  }, [projectId])
  return status
}

export function SelfHostedProjectControls({
  project,
  managedRelayEndpoint: suppliedManagedRelayEndpoint,
  initialMembership = null,
}: {
  project?: ResearchProjectManifest
  managedRelayEndpoint?: string
  initialMembership?: RelayRoomMembershipReport | null
}) {
  const bindProject = useStore((state) => state.bindProjectToWebsocket)
  const setProjectAccess = useStore((state) => state.setSelfHostedProjectAccess)
  const addProject = useStore((state) => state.addSelfHostedProject)
  const leaveProject = useStore((state) => state.leaveSelfHostedProject)
  const [endpoint, setEndpoint] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteRole, setInviteRole] = useState<RelayMemberRole>('editor')
  const [inviteLifetime, setInviteLifetime] = useState('604800')
  const [issuedInvite, setIssuedInvite] = useState('')
  const [issuedInviteRole, setIssuedInviteRole] = useState<RelayMemberRole | null>(null)
  const [issuedInviteExpiresAtMs, setIssuedInviteExpiresAtMs] = useState<number | null>(null)
  const [deviceEnrollmentInput, setDeviceEnrollmentInput] = useState('')
  const [membership, setMembership] = useState<RelayRoomMembershipReport | null>(initialMembership)
  const [managedRelayEndpoint, setManagedRelayEndpoint] = useState(suppliedManagedRelayEndpoint ?? '')
  const websocketProject = project?.transport.kind === 'websocket' ? project : null
  const websocketBinding = project?.transport.kind === 'websocket' ? project.transport : null
  const status = useWebsocketProjectStatus(websocketProject?.id ?? null)
  const legacyInvite = useMemo(
    () => websocketProject && !websocketBinding?.access ? createWebsocketProjectInvite(websocketProject) : '',
    [websocketProject, websocketBinding?.access],
  )
  const locallyManaged = Boolean(
    websocketProject && websocketBinding && managedRelayEndpoint &&
    websocketBinding.endpoint === managedRelayEndpoint && membership?.projectId === websocketProject.id,
  )
  const selectedLifetimeSeconds = inviteLifetime === 'never' ? null : Number(inviteLifetime)

  useEffect(() => {
    if (suppliedManagedRelayEndpoint !== undefined || !desktopRuntimeAvailable()) return
    let disposed = false
    void collaborationRelaySettings()
      .then((report) => {
        if (!disposed && report.endpoint) setManagedRelayEndpoint(report.endpoint)
      })
      .catch(() => {})
    return () => { disposed = true }
  }, [suppliedManagedRelayEndpoint])

  useEffect(() => {
    setMembership(null)
    if (!websocketProject || !websocketBinding || !desktopRuntimeAvailable() ||
      !managedRelayEndpoint || websocketBinding.endpoint !== managedRelayEndpoint) return
    let disposed = false
    void collaborationRelayRoomStatus(websocketBinding.roomId)
      .then((report) => { if (!disposed && report.projectId === websocketProject.id) setMembership(report) })
      .catch(() => {})
    return () => { disposed = true }
  }, [managedRelayEndpoint, websocketBinding?.roomId, websocketProject?.id])

  const connect = async () => {
    if (!project || project.transport.kind !== 'local' || busy) return
    setError('')
    setMessage('')
    setBusy(true)
    try {
      const binding = normalizeWebsocketProjectBinding({ endpoint, roomId: createWebsocketRoomId() })
      if (desktopRuntimeAvailable() && managedRelayEndpoint && binding.endpoint === managedRelayEndpoint) {
        const created = await collaborationRelayRoomCreate(
          project.id,
          binding.roomId,
          await localDeviceBinding(),
        )
        bindProject(project.id, { ...binding, access: memberAccess(created.credential) })
        setMembership(created.room)
        setMessage(created.credential.schemaVersion === 3
          ? 'Member access is on and this installation key is enrolled. Issue a separate device-bound invitation for each collaborator.'
          : 'Member access is on in bearer-only compatibility mode because this installation key was unavailable.')
      } else {
        bindProject(project.id, binding)
      }
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const join = () => {
    setError('')
    setMessage('')
    try {
      const sharedProject = parseWebsocketProjectInvite(inviteInput)
      addProject(sharedProject)
    } catch (value) {
      setError(errorText(value))
    }
  }

  const copyText = async (value: string, success: string) => {
    setError('')
    try {
      await navigator.clipboard.writeText(value)
      setMessage(success)
    } catch {
      setError('Could not access the clipboard. Select and copy the invitation manually.')
    }
  }

  const protectLegacyRoom = async () => {
    if (!websocketProject || !websocketBinding || busy) return
    setBusy(true)
    setError('')
    try {
      const created = await collaborationRelayRoomCreate(
        websocketProject.id,
        websocketBinding.roomId,
        await localDeviceBinding(),
      )
      setProjectAccess(websocketProject.id, memberAccess(created.credential))
      setMembership(created.room)
      setMessage(created.credential.schemaVersion === 3
        ? 'Member access is on and this installation key is enrolled. Previous room-only invitations can no longer connect.'
        : 'Member access is on in bearer-only compatibility mode. Previous room-only invitations can no longer connect.')
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const issueInvite = async () => {
    if (!websocketProject || !websocketBinding || !membership || busy) return
    setBusy(true)
    setError('')
    setIssuedInvite('')
    setIssuedInviteRole(null)
    setIssuedInviteExpiresAtMs(null)
    try {
      const device = await parseRelayDeviceEnrollment(deviceEnrollmentInput)
      const issued = await collaborationRelayMemberIssue(
        websocketBinding.roomId,
        membership.registryRevision,
        inviteRole,
        selectedLifetimeSeconds,
        device,
      )
      const invite = createManagedWebsocketProjectInvite(websocketProject, {
        ...memberAccess(issued.credential),
        roomId: issued.credential.roomId,
      })
      setMembership(issued.room)
      setIssuedInvite(invite)
      setIssuedInviteRole(issued.credential.role)
      setIssuedInviteExpiresAtMs(issued.credential.expiresAtMs)
      setMessage(`${inviteRole} invitation issued with ${expirationCopy(issued.credential.expiresAtMs)}. This is the only copy of its member capability.`)
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async (memberId: string) => {
    if (!websocketProject || !websocketBinding || !membership || busy) return
    setBusy(true)
    setError('')
    setIssuedInvite('')
    setIssuedInviteRole(null)
    setIssuedInviteExpiresAtMs(null)
    try {
      const device = deviceEnrollmentInput.trim()
        ? await parseRelayDeviceEnrollment(deviceEnrollmentInput)
        : null
      const rotated = await collaborationRelayMemberRotate(
        websocketBinding.roomId,
        memberId,
        membership.registryRevision,
        selectedLifetimeSeconds,
        device,
      )
      const access = memberAccess(rotated.credential)
      const invite = createManagedWebsocketProjectInvite(websocketProject, {
        ...access,
        roomId: rotated.credential.roomId,
      })
      if (memberId === websocketBinding.access?.memberId) {
        setProjectAccess(websocketProject.id, access)
      }
      setMembership(rotated.room)
      setIssuedInvite(invite)
      setIssuedInviteRole(rotated.credential.role)
      setIssuedInviteExpiresAtMs(rotated.credential.expiresAtMs)
      setMessage(`Member capability rotated to generation ${rotated.credential.capabilityGeneration} with ${expirationCopy(rotated.credential.expiresAtMs)}. The previous invitation can no longer connect.`)
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (memberId: string) => {
    if (!websocketBinding || !membership || busy) return
    setBusy(true)
    setError('')
    try {
      const next = await collaborationRelayMemberRevoke(
        websocketBinding.roomId,
        memberId,
        membership.registryRevision,
      )
      setMembership(next)
      setMessage('Member revoked. The relay restarted and every connection must authenticate again.')
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const leave = () => {
    if (!websocketProject) return
    setError('')
    try {
      leaveProject(websocketProject.id)
    } catch (value) {
      setError(errorText(value))
    }
  }

  if (websocketProject && websocketBinding) {
    return (
      <section className="self-hosted-project-controls" aria-label="Self-hosted collaboration">
        <div className="self-hosted-project-heading">
          <div>
            <div className="workspace-panel-label mono">Self-hosted collaboration</div>
            <strong>{connectionLabel(status)}</strong>
            <p>
              Research updates and ephemeral presence use {websocketBinding.endpoint}.
              Local IndexedDB remains the durable copy on this installation.
            </p>
            {websocketBinding.access ? <p>
              Member access · <strong>{websocketBinding.access.role}</strong>. The capability is a
              bearer credential stored only in this installation’s project settings.
              {websocketBinding.access.schemaVersion === 2
                ? ` Generation ${websocketBinding.access.capabilityGeneration}; ${expirationCopy(websocketBinding.access.expiresAtMs)}.`
                : websocketBinding.access.schemaVersion === 3
                  ? ` Generation ${websocketBinding.access.capabilityGeneration}; ${expirationCopy(websocketBinding.access.expiresAtMs)}; signed device ${websocketBinding.access.deviceKeyId.slice(-8)}.`
                  : ' Legacy managed invitation without an expiry claim.'}
              {websocketBinding.access.role === 'viewer'
                ? ' Viewer document updates are rejected by the relay; local edits remain local.'
                : ''}
            </p> : null}
          </div>
          <button className="btn sm" type="button" onClick={leave}>Leave relay · keep local copy</button>
        </div>

        {!websocketBinding.access ? <>
          <label className="self-hosted-invite-field">
            <span>Legacy read/edit bearer invitation</span>
            <textarea readOnly rows={3} value={legacyInvite} aria-label="Self-hosted project invitation" />
          </label>
          <div className="self-hosted-project-actions">
            <button className="btn sm" type="button" onClick={() => void copyText(
              legacyInvite,
              'Invitation copied. Anyone holding it can read and edit this project.',
            )}>Copy invitation</button>
            <span>Anyone with this legacy invitation can read and edit. Participant names are not authenticated.</span>
          </div>
          {managedRelayEndpoint === websocketBinding.endpoint && desktopRuntimeAvailable() ? <div>
            <p>Protecting this room disables every previous room-only invitation and enables separate member revocation.</p>
            <button className="btn sm" type="button" disabled={busy} onClick={() => void protectLegacyRoom()}>
              {busy ? 'Protecting…' : 'Turn on member access'}
            </button>
          </div> : null}
        </> : null}

        {locallyManaged && membership ? <div aria-label="Relay room members">
          <div className="workspace-panel-label mono">Relay members · revision {membership.registryRevision}</div>
          <ul>
            {membership.members.map((member) => <li key={member.memberId}>
              <span className="mono">{member.memberId.slice(0, 12)}…</span>
              {' · '}{member.role}{member.memberId === websocketBinding.access?.memberId ? ' · this credential' : ''}
              {' · '}generation {member.capabilityGeneration}
              {' · '}{expirationCopy(member.expiresAtMs)}
              {member.deviceKeyId ? ` · device ${member.deviceKeyId.slice(-8)}` : ' · bearer only'}
              {member.revokedAtMs ? ' · revoked' : ''}
              {!member.revokedAtMs ? <>
                <button
                  className="btn sm ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void rotate(member.memberId)}
                >Rotate / recover</button>
                <button
                  className="btn sm ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(member.memberId)}
                >Revoke</button>
              </> : null}
            </li>)}
          </ul>
          <div className="self-hosted-project-actions">
            <label>
              <span>New member role</span>
              <select
                value={inviteRole}
                disabled={busy}
                onChange={(event) => setInviteRole(event.target.value as RelayMemberRole)}
              >
                <option value="viewer">Viewer · shared document read-only</option>
                <option value="editor">Editor · shared document read/write</option>
                <option value="admin">Admin · read/write; relay operator still manages membership</option>
              </select>
            </label>
            <label>
              <span>Invitation lifetime</span>
              <select
                value={inviteLifetime}
                disabled={busy}
                onChange={(event) => setInviteLifetime(event.target.value)}
              >
                <option value="3600">1 hour</option>
                <option value="86400">24 hours</option>
                <option value="604800">7 days</option>
                <option value="2592000">30 days</option>
                <option value="never">No automatic expiry</option>
              </select>
            </label>
            <label className="self-hosted-invite-field">
              <span>Collaborator device enrollment request</span>
              <textarea
                rows={3}
                value={deviceEnrollmentInput}
                disabled={busy}
                aria-label="Collaborator device enrollment request"
                onChange={(event) => setDeviceEnrollmentInput(event.target.value)}
              />
            </label>
            <button
              className="btn sm primary"
              type="button"
              disabled={busy || !deviceEnrollmentInput.trim()}
              onClick={() => void issueInvite()}
            >
              {busy ? 'Applying…' : 'Issue separate invitation'}
            </button>
          </div>
          <p>
            Membership is managed only on this relay-host installation. Admin credentials do not
            expose a remote management endpoint; the relay operator retains that authority. Expiry uses
            the relay host’s clock. Rotate / recover replaces a member’s capability, preserves
            its role and member ID, and invalidates every prior copy.
            New members require the intended collaborator’s public enrollment request. On rotation,
            leave the field empty to retain the current device binding, or paste a new request to
            move access to a replacement installation.
          </p>
          {issuedInvite ? <>
            <label className="self-hosted-invite-field">
              <span>New {issuedInviteRole} invitation · {expirationCopy(issuedInviteExpiresAtMs)} · shown for this issuance</span>
              <textarea readOnly rows={4} value={issuedInvite} aria-label="Issued member invitation" />
            </label>
            <button className="btn sm" type="button" onClick={() => void copyText(
              issuedInvite,
              'Member invitation copied. Send it only to its intended collaborator.',
            )}>Copy member invitation</button>
          </> : null}
        </div> : null}

        {message && <p className="drive-project-message" role="status">{message}</p>}
        {(error || status?.error) && <p className="drive-project-message error" role="alert">{error || status?.error}</p>}
      </section>
    )
  }

  const acknowledgement = (
    <label className="self-hosted-warning">
      <input
        type="checkbox"
        checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)}
      />
      <span>I understand that invitations contain bearer access: managed invitations enforce their assigned role, while legacy invitations grant read and edit. Identities remain self-reported.</span>
    </label>
  )

  if (project) {
    return (
      <details className="self-hosted-project-controls">
        <summary>Self-hosted relay (advanced)</summary>
        <p>
          Connect this project to a y-websocket-compatible relay you operate. Plaintext is limited
          to loopback/private LAN addresses; public relays require WSS. The relay is not a backup.
          This app’s relay adds member roles and revocation; third-party relays use legacy bearer access.
        </p>
        <label className="self-hosted-endpoint-field">
          <span>Relay endpoint</span>
          <input
            type="url"
            value={endpoint}
            placeholder="ws://192.168.1.20:1234"
            aria-label="Self-hosted relay endpoint"
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        {managedRelayEndpoint ? (
          <button
            className="btn sm ghost"
            type="button"
            onClick={() => setEndpoint(managedRelayEndpoint)}
          >
            Use this app’s relay · {managedRelayEndpoint}
          </button>
        ) : null}
        {acknowledgement}
        <button className="btn primary sm" type="button" disabled={!acknowledged || busy} onClick={() => void connect()}>
          {busy ? 'Creating…' : 'Create invitation and connect'}
        </button>
        {message && <p className="drive-project-message" role="status">{message}</p>}
        {error && <p className="drive-project-message error" role="alert">{error}</p>}
      </details>
    )
  }

  return (
    <details className="self-hosted-project-controls self-hosted-project-join">
      <summary>Join a self-hosted project (advanced)</summary>
      <p>Paste the complete invitation from a collaborator. Joining starts a local durable copy and connects to their configured relay.</p>
      <label className="self-hosted-invite-field">
        <span>Bearer invitation</span>
        <textarea
          rows={4}
          value={inviteInput}
          aria-label="Join self-hosted project invitation"
          onChange={(event) => setInviteInput(event.target.value)}
        />
      </label>
      {acknowledgement}
      <button className="btn primary sm" type="button" disabled={!acknowledged || !inviteInput.trim()} onClick={join}>
        Join self-hosted project
      </button>
      {error && <p className="drive-project-message error" role="alert">{error}</p>}
    </details>
  )
}
