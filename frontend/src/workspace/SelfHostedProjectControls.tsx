import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import {
  createWebsocketRoomId,
  normalizeWebsocketProjectBinding,
} from './websocketProjectBinding'
import {
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

export function SelfHostedProjectControls({ project }: { project?: ResearchProjectManifest }) {
  const bindProject = useStore((state) => state.bindProjectToWebsocket)
  const addProject = useStore((state) => state.addSelfHostedProject)
  const leaveProject = useStore((state) => state.leaveSelfHostedProject)
  const [endpoint, setEndpoint] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const websocketProject = project?.transport.kind === 'websocket' ? project : null
  const websocketBinding = project?.transport.kind === 'websocket' ? project.transport : null
  const status = useWebsocketProjectStatus(websocketProject?.id ?? null)
  const invite = useMemo(
    () => websocketProject ? createWebsocketProjectInvite(websocketProject) : '',
    [websocketProject],
  )

  const connect = () => {
    if (!project || project.transport.kind !== 'local') return
    setError('')
    setMessage('')
    try {
      const binding = normalizeWebsocketProjectBinding({ endpoint, roomId: createWebsocketRoomId() })
      bindProject(project.id, binding)
    } catch (value) {
      setError(errorText(value))
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

  const copyInvite = async () => {
    setError('')
    try {
      await navigator.clipboard.writeText(invite)
      setMessage('Invitation copied. Share it only with people who may read and edit this project.')
    } catch {
      setError('Could not access the clipboard. Select and copy the invitation manually.')
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
          </div>
          <button className="btn sm" type="button" onClick={leave}>Leave relay · keep local copy</button>
        </div>
        <label className="self-hosted-invite-field">
          <span>Bearer invitation</span>
          <textarea readOnly rows={3} value={invite} aria-label="Self-hosted project invitation" />
        </label>
        <div className="self-hosted-project-actions">
          <button className="btn sm" type="button" onClick={() => void copyInvite()}>Copy invitation</button>
          <span>Anyone with this invitation can read and edit. Participant names are not authenticated.</span>
        </div>
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
      <span>I understand that the invitation is the access key: anyone who has it can read and edit, and identities are self-reported.</span>
    </label>
  )

  if (project) {
    return (
      <details className="self-hosted-project-controls">
        <summary>Self-hosted relay (advanced)</summary>
        <p>
          Connect this project to a y-websocket-compatible relay you operate. Plaintext is limited
          to loopback/private LAN addresses; public relays require WSS. The relay is not a backup.
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
        {acknowledgement}
        <button className="btn primary sm" type="button" disabled={!acknowledged} onClick={connect}>
          Create invitation and connect
        </button>
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
