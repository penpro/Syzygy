import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { logError, logInfo } from '../log'
import { Modal } from './Modal'
import {
  googleOauthStart,
  googleOauthConnection,
  googleOauthCancel,
  googleOauthDisconnect,
  googleDriveSyncFolder,
  googleDriveWorkspace,
  googleDriveListWorkspaces,
  googleDriveSelectWorkspace,
  type DriveWorkspace,
  type DriveWorkspaceOption,
} from '../tauri'
import { driveWorkspaceLabel, driveWorkspaceOptionLabel } from '../workspace/driveProjectDiscovery'

/** The Drive folder every Syzygy instance shares (mirrored locally at Documents/Syzygy). */
export const DRIVE_FOLDER = 'Syzygy'

/** Google failures that all mean the same thing: the Drive permission checkbox on the consent
 * screen wasn't ticked, so the token can't touch Drive. */
const SCOPE_PROBLEM = /insufficient|scope|checkbox|drive access|collaboration access|app-file-only|re-link/i

const errorText = (error: unknown) => (error as { message?: string })?.message ?? String(error)

/**
 * Compact Google Drive control for the Ask top bar (lives next to the folder grant).
 * Auth + a create-folder smoke test for now; the shared-folder sync layer builds on this.
 * The OAuth flow and tokens live entirely in the Rust core — this only sees the email.
 */
export function GoogleDriveButton() {
  const clientId = useStore((s) => s.settings.googleClientId)
  const clientSecret = useStore((s) => s.settings.googleClientSecret)
  const [email, setEmail] = useState<string | null>(null)
  const [collaborationAccess, setCollaborationAccess] = useState(false)
  const [workspace, setWorkspace] = useState<DriveWorkspace | null>(null)
  const [workspaceOptions, setWorkspaceOptions] = useState<DriveWorkspaceOption[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState(false) // a sign-in is waiting on the browser (cancelable)
  const [flash, setFlash] = useState<{ label: string; title?: string } | null>(null)
  const [showScopeHelp, setShowScopeHelp] = useState(false)
  const flashTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    Promise.all([googleOauthConnection(), googleDriveWorkspace()])
      .then(([connection, savedWorkspace]) => {
        setEmail(connection?.email ?? null)
        setCollaborationAccess(connection?.collaborationAccess ?? false)
        setWorkspace(savedWorkspace)
        if (connection) {
          logInfo(
            'drive',
            `Connection restored (${connection.collaborationAccess ? 'collaboration access' : 'app-file-only'}); workspace: ${savedWorkspace?.name ?? 'not selected'}`,
          )
        } else {
          logInfo('drive', 'No stored Google Drive connection')
        }
      })
      .catch((error) => {
        setEmail(null)
        logError('drive', `Connection status check failed: ${errorText(error)}`)
      }) // not running under Tauri (browser dev)
    return () => window.clearTimeout(flashTimer.current)
  }, [])

  const showFlash = (label: string, title?: string, ms = 4000) => {
    window.clearTimeout(flashTimer.current)
    setFlash({ label, title })
    flashTimer.current = window.setTimeout(() => setFlash(null), ms)
  }

  const connect = async () => {
    setBusy(true)
    setLinking(true)
    logInfo('drive', 'Opening Google sign-in')
    try {
      const who = await googleOauthStart(clientId, clientSecret)
      setEmail(who)
      setCollaborationAccess(true)
      logInfo('drive', `Linked Google Drive as ${who}`)
      try {
        const options = await googleDriveListWorkspaces()
        logInfo('drive', `Workspace discovery returned ${options.length} folder(s)`)
        const syzygyFolders = options.filter((option) => option.name.toLowerCase() === DRIVE_FOLDER.toLowerCase())
        if (syzygyFolders.length === 1) {
          const selected = await googleDriveSelectWorkspace(syzygyFolders[0].id)
          setWorkspace(selected)
          logInfo('drive', `Selected Drive workspace: ${driveWorkspaceLabel(selected)}`)
          showFlash('✅ Linked', `Linked as ${who}; workspace: ${driveWorkspaceLabel(selected)}`)
        } else {
          setWorkspaceOptions(options)
          setSelectedWorkspaceId(options[0]?.id ?? '')
          setShowWorkspace(true)
          showFlash('✅ Linked', `Linked as ${who}; choose a workspace folder`)
        }
      } catch (workspaceError) {
        const msg = errorText(workspaceError)
        logError('drive', `Account linked, but workspace setup failed: ${msg}`)
        if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
        else showFlash('⚠ Linked; folder setup failed', msg, 15000)
      }
    } catch (e) {
      const msg = errorText(e)
      logError('drive', `Google sign-in failed: ${msg}`)
      if (/canceled/i.test(msg)) showFlash('Sign-in canceled', undefined, 2500)
      else if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
      else showFlash('⚠ Link failed', msg, 15000)
    } finally {
      setBusy(false)
      setLinking(false)
    }
  }

  const syncNow = async () => {
    setBusy(true)
    try {
      const r = await googleDriveSyncFolder(DRIVE_FOLDER)
      const activeWorkspace = await googleDriveWorkspace()
      setWorkspace(activeWorkspace)
      logInfo('drive', `Sync: pulled ${r.pulled}, pushed ${r.pushed} (${r.mirror})`)
      showFlash(
        `✅ Synced ⬇${r.pulled} ⬆${r.pushed}`,
        `Mirror: ${r.mirror} ↔ Drive/${activeWorkspace?.name ?? DRIVE_FOLDER}`,
      )
    } catch (e) {
      const msg = errorText(e)
      logError('drive', `Sync failed: ${msg}`)
      if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
      else showFlash('⚠ Sync failed', msg, 8000)
    } finally {
      setBusy(false)
    }
  }

  const openWorkspacePicker = async () => {
    setBusy(true)
    try {
      const options = await googleDriveListWorkspaces()
      logInfo('drive', `Workspace discovery returned ${options.length} folder(s)`)
      setWorkspaceOptions(options)
      setSelectedWorkspaceId(workspace?.id ?? options[0]?.id ?? '')
      setShowWorkspace(true)
    } catch (e) {
      const msg = errorText(e)
      logError('drive', `Workspace discovery failed: ${msg}`)
      if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
      else showFlash('⚠ Folder list failed', msg, 10000)
    } finally {
      setBusy(false)
    }
  }

  const chooseWorkspace = async () => {
    if (!selectedWorkspaceId) return
    setBusy(true)
    try {
      const selected = await googleDriveSelectWorkspace(selectedWorkspaceId)
      setWorkspace(selected)
      setShowWorkspace(false)
      logInfo('drive', `Selected Drive workspace: ${driveWorkspaceLabel(selected)}`)
      showFlash('✅ Folder selected', `Direct Drive workspace: ${driveWorkspaceLabel(selected)}`)
    } catch (e) {
      const msg = errorText(e)
      logError('drive', `Workspace selection failed: ${msg}`)
      showFlash('⚠ Folder selection failed', msg, 10000)
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setBusy(true)
    try {
      await googleOauthDisconnect()
      setEmail(null)
      setCollaborationAccess(false)
      setWorkspace(null)
      logInfo('drive', 'Google Drive disconnected')
      showFlash('Unlinked')
    } catch (e) {
      const msg = errorText(e)
      logError('drive', `Disconnect failed: ${msg}`)
      showFlash('⚠ Unlink failed', msg, 8000)
    } finally {
      setBusy(false)
    }
  }

  // Google does not offer a folder-only OAuth scope for this loopback desktop flow. Syzygy asks
  // for Drive collaboration access, then constrains every read/write to the selected workspace.
  const scopeHelp = showScopeHelp && (
    <Modal
      title="Allow collaborator files"
      onClose={() => setShowScopeHelp(false)}
      footer={
        <div className="row full">
          <div className="grow" />
          <button className="btn ghost" onClick={() => setShowScopeHelp(false)}>
            Close
          </button>
          <button
            className="btn"
            onClick={async () => {
              setShowScopeHelp(false)
              try {
                await googleOauthDisconnect()
              } catch {
                /* nothing stored — fine */
              }
              setEmail(null)
              setCollaborationAccess(false)
              setWorkspace(null)
              connect()
            }}
          >
            🔗 Re-link now
          </button>
        </div>
      }
    >
      <p>
        This Drive link can only see files Syzygy created. It cannot see a Google Doc that a collaborator adds to the
        same folder, so shared-folder answers would be incomplete.
      </p>
      <p>
        Re-link and approve Google Drive collaboration access. Google does not provide a folder-only permission for
        this desktop sign-in flow; after authorization, Syzygy stores one workspace folder ID locally and constrains
        its file operations to that folder.
      </p>
      <p className="muted xs">
        The local model never receives a Drive token. Syzygy's Rust core exports only supported text from the selected
        workspace into the question context. The optional Sync button is still the only action that creates a mirror.
      </p>
    </Modal>
  )

  const workspacePicker = showWorkspace && (
    <Modal
      title="Choose the shared Drive folder"
      onClose={() => setShowWorkspace(false)}
      footer={
        <div className="row full">
          <div className="grow" />
          <button className="btn ghost" onClick={() => setShowWorkspace(false)}>
            Cancel
          </button>
          <button className="btn" disabled={!selectedWorkspaceId || busy} onClick={chooseWorkspace}>
            Use this folder
          </button>
        </div>
      }
    >
      <p>
        Syzygy reads supported files directly from this folder for Shared mode. It does not download the folder unless
        you click Sync.
      </p>
      {workspaceOptions.length ? (
        <label className="field">
          <span>Drive folder</span>
          <select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
            {workspaceOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {driveWorkspaceOptionLabel(option)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">No Drive folders are available to this account.</p>
      )}
    </Modal>
  )

  if (flash) {
    return (
      <>
        <button className="btn sm ghost" title={flash.title} disabled>
          {flash.label}
        </button>
        {scopeHelp}
        {workspacePicker}
      </>
    )
  }

  if (!email) {
    // While a sign-in is pending the button stays LIVE as a cancel control — never a dead
    // "Waiting…" that can only be escaped by finishing (or timing out) in the browser.
    if (linking) {
      return (
        <button className="btn sm ghost" title="Abort the sign-in waiting in your browser" onClick={() => googleOauthCancel()}>
          Waiting for browser… ✕ cancel
        </button>
      )
    }
    return (
      <>
        <button
          className="btn sm ghost"
          title="Link Google Drive for a selected collaboration workspace (sign-in happens in your browser)"
          disabled={busy || !clientId.trim()}
          onClick={connect}
        >
          🔗 Link Drive
        </button>
        {scopeHelp}
        {workspacePicker}
      </>
    )
  }

  if (!collaborationAccess) {
    return (
      <>
        <button
          className="btn sm ghost"
          title="This older Drive link cannot see collaborator-created Google Docs"
          onClick={() => setShowScopeHelp(true)}
        >
          ⚠ Re-link Drive
        </button>
        <button className="icon-btn sm" title={`Unlink Google Drive (${email})`} disabled={busy} onClick={unlink}>
          ✕
        </button>
        {scopeHelp}
      </>
    )
  }

  return (
    <>
      <span className="row" style={{ gap: 4, alignItems: 'center' }}>
        <button
          className="btn sm ghost"
          title={`Linked as ${email} — selected ${workspace ? driveWorkspaceLabel(workspace) : 'no Drive folder'}`}
          disabled={busy}
          onClick={openWorkspacePicker}
        >
          📁 {workspace ? driveWorkspaceLabel(workspace) : 'Choose Drive folder'}
        </button>
        <button
          className="btn sm ghost"
          title={`Create or refresh the optional local mirror for ${workspace?.name ?? DRIVE_FOLDER}`}
          disabled={busy || !workspace}
          onClick={syncNow}
        >
          {busy ? '…' : '☁ Sync'}
        </button>
        <button className="icon-btn sm" title={`Unlink Google Drive (${email})`} disabled={busy} onClick={unlink}>
          ✕
        </button>
      </span>
      {scopeHelp}
      {workspacePicker}
    </>
  )
}
