import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  collaborationRelayMemberIssue,
  collaborationRelayMemberRevoke,
  collaborationRelayRoomCreate,
  collaborationRelayRoomStatus,
  collaborationRelaySettings,
  desktopRuntimeAvailable,
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
  return {
    schemaVersion: credential.schemaVersion,
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
  }
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
}: {
  project?: ResearchProjectManifest
  managedRelayEndpoint?: string
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
  const [issuedInvite, setIssuedInvite] = useState('')
  const [issuedInviteRole, setIssuedInviteRole] = useState<RelayMemberRole | null>(null)
  const [membership, setMembership] = useState<RelayRoomMembershipReport | null>(null)
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
        const created = await collaborationRelayRoomCreate(project.id, binding.roomId)
        bindProject(project.id, { ...binding, access: memberAccess(created.credential) })
        setMembership(created.room)
        setMessage('Member access is on. Issue a separate invitation for each collaborator.')
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
      const created = await collaborationRelayRoomCreate(websocketProject.id, websocketBinding.roomId)
      setProjectAccess(websocketProject.id, memberAccess(created.credential))
      setMembership(created.room)
      setMessage('Member access is on. Previous room-only invitations can no longer connect.')
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
    try {
      const issued = await collaborationRelayMemberIssue(
        websocketBinding.roomId,
        membership.registryRevision,
        inviteRole,
      )
      const invite = createManagedWebsocketProjectInvite(websocketProject, {
        schemaVersion: issued.credential.schemaVersion,
        roomId: issued.credential.roomId,
        memberId: issued.credential.memberId,
        capability: issued.credential.capability,
        role: issued.credential.role,
      })
      setMembership(issued.room)
      setIssuedInvite(invite)
      setIssuedInviteRole(issued.credential.role)
      setMessage(`${inviteRole} invitation issued. This is the only copy of its member capability.`)
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
              {member.revokedAtMs ? ' · revoked' : ''}
              {!member.revokedAtMs ? <button
                className="btn sm ghost"
                type="button"
                disabled={busy}
                onClick={() => void revoke(member.memberId)}
              >Revoke</button> : null}
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
            <button className="btn sm primary" type="button" disabled={busy} onClick={() => void issueInvite()}>
              {busy ? 'Applying…' : 'Issue separate invitation'}
            </button>
          </div>
          <p>
            Membership is managed only on this relay-host installation. Admin credentials do not
            expose a remote management endpoint; the relay operator retains that authority.
          </p>
          {issuedInvite ? <>
            <label className="self-hosted-invite-field">
              <span>New {issuedInviteRole} invitation · shown for this issuance</span>
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
