import { useCallback, useEffect, useState } from 'react'
import * as Y from 'yjs'
import {
  googleDriveProjectList,
  googleDriveProjectPublish,
  googleDriveWorkspace,
  type DriveProjectDescriptor,
  type DriveWorkspace,
} from '../tauri'
import { useStore } from '../store'
import { bytesToBase64 } from './driveProjectProvider'
import { subscribeDriveProjectStatus, type DriveProjectSyncStatus } from './driveProjectStatus'
import type { ResearchProjectManifest } from './schema'
import {
  automationProjectDocumentReady,
  getAutomationProjectDocument,
  subscribeAutomationProjectDocument,
} from './workspaceAutomationRegistry'

function syncLabel(status: DriveProjectSyncStatus | null): string {
  if (!status) return 'Drive shared · starting sync'
  if (status.state === 'connecting') return 'Drive shared · connecting'
  if (status.state === 'error') return `Drive sync error · ${status.error}`
  if (status.state === 'disconnected') return 'Drive shared · offline copy available'
  return `Drive shared · synced ${new Date(status.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export function DriveProjectControls({ project }: { project?: ResearchProjectManifest }) {
  const bindProjectToDrive = useStore((state) => state.bindProjectToDrive)
  const addSharedProject = useStore((state) => state.addSharedProject)
  const projects = useStore((state) => state.projects)
  const [workspace, setWorkspace] = useState<DriveWorkspace | null>(null)
  const [available, setAvailable] = useState<DriveProjectDescriptor[]>([])
  const [documentReady, setDocumentReady] = useState(
    project ? automationProjectDocumentReady(project.id) : false,
  )
  const [syncStatus, setSyncStatus] = useState<DriveProjectSyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!project) {
      setDocumentReady(false)
      return
    }
    return subscribeAutomationProjectDocument(project.id, (doc) => setDocumentReady(Boolean(doc)))
  }, [project?.id])

  useEffect(() => {
    if (!project || project.transport.kind !== 'drive') {
      setSyncStatus(null)
      return
    }
    return subscribeDriveProjectStatus(project.id, setSyncStatus)
  }, [project?.id, project?.transport.kind])

  const refresh = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const selected = await googleDriveWorkspace()
      setWorkspace(selected)
      if (!selected) {
        setAvailable([])
        setMessage('Link Google Drive and choose a shared workspace in Settings first.')
        return
      }
      const descriptors = await googleDriveProjectList()
      setAvailable(descriptors)
      setMessage(descriptors.length === 0 ? 'No shared Syzygy projects are published in this workspace yet.' : '')
    } catch (value) {
      setAvailable([])
      setError(String(value))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!project) void refresh()
  }, [project, refresh])

  const share = async () => {
    if (!project || project.transport.kind !== 'local') return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const selected = await googleDriveWorkspace()
      if (!selected) throw new Error('Link Google Drive and choose a shared workspace in Settings first.')
      const doc = getAutomationProjectDocument(project.id)
      const descriptor = await googleDriveProjectPublish(
        project.id,
        project.documentId,
        project.title,
        project.createdAt,
        bytesToBase64(Y.encodeStateAsUpdate(doc)),
      )
      if (descriptor.workspaceId !== selected.id || descriptor.projectId !== project.id || descriptor.documentId !== project.documentId) {
        throw new Error('Drive returned a project identity that does not match this project.')
      }
      bindProjectToDrive(project.id, selected.id)
      setWorkspace(selected)
      setMessage('Shared to Drive. This project now merges edits from every joined installation.')
    } catch (value) {
      setError(String(value))
    } finally {
      setBusy(false)
    }
  }

  const join = (descriptor: DriveProjectDescriptor) => {
    try {
      addSharedProject({
        schemaVersion: 1,
        id: descriptor.projectId,
        documentId: descriptor.documentId,
        title: descriptor.title,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.createdAt,
        transport: { kind: 'drive', workspaceId: descriptor.workspaceId },
      })
    } catch (value) {
      setError(String(value))
    }
  }

  if (project?.transport.kind === 'drive') {
    return <span className={`workspace-status mono${syncStatus?.state === 'error' ? ' error' : ''}`}>{syncLabel(syncStatus)}</span>
  }

  if (project) {
    return (
      <div className="drive-project-controls">
        <button className="btn sm" type="button" disabled={busy || !documentReady} onClick={() => void share()}>
          {busy ? 'Sharing…' : 'Share to Drive'}
        </button>
        {!documentReady && <span className="workspace-status mono">Preparing local project…</span>}
        {message && <span className="drive-project-message">{message}</span>}
        {error && <span className="drive-project-message error" role="alert">{error}</span>}
      </div>
    )
  }

  return (
    <div className="drive-project-browser" aria-label="Shared Drive projects">
      <div className="drive-project-browser-heading">
        <div>
          <div className="workspace-panel-label mono">Shared Drive projects</div>
          <p>{workspace ? `Join a project from ${workspace.name}.` : 'Use the same selected Drive workspace on each computer.'}</p>
        </div>
        <button className="btn sm" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Checking…' : 'Refresh'}</button>
      </div>
      {available.map((descriptor) => {
        const alreadyAdded = projects.some((candidate) =>
          candidate.id === descriptor.projectId || candidate.documentId === descriptor.documentId)
        return (
          <div className="drive-project-row" key={`${descriptor.projectId}:${descriptor.documentId}`}>
            <div>
              <strong>{descriptor.title}</strong>
              <span className="mono">{descriptor.projectId}</span>
            </div>
            <button className="btn sm" type="button" disabled={alreadyAdded} onClick={() => join(descriptor)}>
              {alreadyAdded ? 'Already added' : 'Join'}
            </button>
          </div>
        )
      })}
      {message && <p className="drive-project-message">{message}</p>}
      {error && <p className="drive-project-message error" role="alert">{error}</p>}
    </div>
  )
}
