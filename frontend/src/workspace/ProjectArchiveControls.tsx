import { useEffect, useRef, useState } from 'react'
import { saveTextFile } from '../tauri'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import {
  assertProjectArchiveImportAvailable,
  createProjectArchive,
  decodeProjectArchive,
  persistDecodedProjectArchive,
  PROJECT_ARCHIVE_EXTENSION,
  PROJECT_ARCHIVE_MAX_FILE_BYTES,
} from './projectArchive'
import {
  getAutomationProjectDocument,
  subscribeAutomationProjectDocument,
} from './workspaceAutomationRegistry'

interface ProjectArchiveControlsContentProps {
  project: ResearchProjectManifest | null
  documentReady: boolean
  busy: boolean
  status: string
  error: string
  onExport: () => void
  onChooseImport: () => void
}

export function ProjectArchiveControlsContent({
  project,
  documentReady,
  busy,
  status,
  error,
  onExport,
  onChooseImport,
}: ProjectArchiveControlsContentProps) {
  return (
    <div className="project-archive-controls" aria-label="Portable project archive">
      {project && (
        <button className="btn" type="button" disabled={busy || !documentReady} onClick={onExport}>
          Export offline copy
        </button>
      )}
      <button className="btn" type="button" disabled={busy} onClick={onChooseImport}>
        Import offline copy
      </button>
      {(status || (project && !documentReady)) && !error && (
        <span className="project-archive-status mono" role="status" aria-live="polite">
          {status || 'Preparing project data…'}
        </span>
      )}
      {error && (
        <span className="project-archive-status error" role="alert">{error}</span>
      )}
    </div>
  )
}

function archiveFilename(title: string): string {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  return `${safeTitle || 'syzygy-project'}${PROJECT_ARCHIVE_EXTENSION}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The project archive operation failed'
}

export function ProjectArchiveControls({ project = null }: { project?: ResearchProjectManifest | null }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const addImportedProject = useStore((state) => state.addImportedProject)
  const [documentReady, setDocumentReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setDocumentReady(false)
    if (!project) return
    return subscribeAutomationProjectDocument(project.id, (doc) => setDocumentReady(Boolean(doc)))
  }, [project])

  const begin = () => {
    setBusy(true)
    setStatus('')
    setError('')
  }

  const exportProject = async () => {
    if (!project) return
    begin()
    try {
      const text = await createProjectArchive(project, getAutomationProjectDocument(project.id))
      const saved = await saveTextFile(archiveFilename(project.title), text, 'application/json')
      setStatus(saved ? 'Project archive saved.' : 'Export cancelled.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const importProject = async (file: File) => {
    begin()
    let decoded: Awaited<ReturnType<typeof decodeProjectArchive>> | null = null
    try {
      if (file.size > PROJECT_ARCHIVE_MAX_FILE_BYTES) {
        throw new Error('Project archive exceeds the size limit')
      }
      decoded = await decodeProjectArchive(await file.text())
      assertProjectArchiveImportAvailable(decoded.manifest, useStore.getState().projects)
      await persistDecodedProjectArchive(decoded)
      // Recheck after asynchronous persistence. The store action is synchronous, so no
      // competing import can enter between this check and manifest registration.
      assertProjectArchiveImportAvailable(decoded.manifest, useStore.getState().projects)
      addImportedProject(decoded.manifest)
      setStatus(`Imported ${decoded.manifest.title}.`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      decoded?.doc.destroy()
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        className="project-archive-file"
        type="file"
        accept="application/json,.json,.syzygy-project.json"
        aria-label="Choose a Syzygy project archive"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          if (file) void importProject(file)
        }}
      />
      <ProjectArchiveControlsContent
        project={project}
        documentReady={documentReady}
        busy={busy}
        status={status}
        error={error}
        onExport={() => void exportProject()}
        onChooseImport={() => inputRef.current?.click()}
      />
    </>
  )
}