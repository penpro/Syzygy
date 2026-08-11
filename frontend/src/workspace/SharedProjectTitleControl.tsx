import { useEffect, useState } from 'react'
import type { DriveProjectTitleState } from '../tauri'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { compactDriveProjectTitle, updateDriveProjectTitle } from './driveProjectMaintenanceRegistry'
import { subscribeDriveProjectTitleState } from './driveProjectTitleStatus'

export interface SharedProjectTitleDraft {
  title: string
  revisionGuards: string[]
  dirty: boolean
}

export function syncSharedProjectTitleDraft(
  draft: SharedProjectTitleDraft,
  state: DriveProjectTitleState,
): SharedProjectTitleDraft {
  if (draft.dirty) return draft
  return { title: state.title, revisionGuards: [...state.revisionGuards], dirty: false }
}

export function editSharedProjectTitleDraft(
  draft: SharedProjectTitleDraft,
  title: string,
  state: DriveProjectTitleState | null,
): SharedProjectTitleDraft {
  return {
    title,
    revisionGuards: draft.dirty ? draft.revisionGuards : [...(state?.revisionGuards ?? [])],
    dirty: true,
  }
}

export function SharedProjectTitleControl({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [state, setState] = useState<DriveProjectTitleState | null>(null)
  const [draft, setDraft] = useState<SharedProjectTitleDraft>({
    title: project.title,
    revisionGuards: [],
    dirty: false,
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeDriveProjectTitleState(project.id, (next) => {
    setState(next)
    if (next) setDraft((current) => syncSharedProjectTitleDraft(current, next))
  }), [project.id])

  const submit = async () => {
    if (!state) throw new Error('Shared title state is still loading')
    const title = draft.title.trim()
    if (!title || [...title].length > 200) throw new Error('Project title must be 1–200 characters')
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before renaming a shared project')
    }
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const updated = await updateDriveProjectTitle(
        project.id,
        title,
        draft.revisionGuards,
        researcherId,
        researcherName.trim(),
      )
      setState(updated)
      setDraft({ title: updated.title, revisionGuards: [...updated.revisionGuards], dirty: false })
      setMessage(updated.conflict
        ? 'Another rename arrived at the same time. Both titles remain available below.'
        : state.conflict
          ? 'Shared title conflict reconciled; every prior title remains in history.'
          : 'Shared title updated for collaborators.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const retainHistory = async () => {
    if (!state) throw new Error('Shared title state is still loading')
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const result = await compactDriveProjectTitle(project.id, state.revisionGuards)
      setState(result.state)
      setDraft((current) => syncSharedProjectTitleDraft(current, result.state))
      setMessage(result.complete
        ? `Retained ${result.retainedEventCount} shared-title events and archived ${result.archivedRecordCount} active history records.`
        : `Title history is safely snapshotted. Archived ${result.archivedRecordCount} records; ${result.remainingRecordCount} remain active and can be retried.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shared-title-control">
      <div className="workspace-title-row">
        <input
          className="workspace-title-input"
          aria-label="Shared project title"
          value={draft.title}
          maxLength={200}
          disabled={!state || busy}
          onChange={(event) => {
            setDraft((current) => editSharedProjectTitleDraft(current, event.target.value, state))
            setMessage(null)
            setError(null)
          }}
        />
        <button
          className="btn sm ghost"
          type="button"
          disabled={!state || busy || !draft.dirty || !draft.title.trim() || draft.revisionGuards.length === 0}
          onClick={() => void submit().catch((cause) => setError(String(cause)))}
        >
          {busy ? 'Saving…' : state?.conflict ? 'Reconcile shared title' : 'Rename shared project'}
        </button>
      </div>
      {!state && <div className="workspace-status mono" role="status">Loading shared title…</div>}
      {state?.conflict && (
        <div className="workspace-inline-alert" role="alert">
          <strong>{state.tips.length} simultaneous project titles need reconciliation.</strong>
          <p>Choose or edit a title, then reconcile. Every competing title remains in the shared history.</p>
          <div className="workspace-inline-actions">
            {state.tips.map((tip) => (
              <button
                className="btn xs ghost"
                type="button"
                key={tip.revision}
                disabled={busy}
                onClick={() => {
                  setDraft({
                    title: tip.title,
                    revisionGuards: [...state.revisionGuards],
                    dirty: true,
                  })
                  setMessage(null)
                  setError(null)
                }}
              >
                Use “{tip.title}” · {tip.displayName}
              </button>
            ))}
          </div>
        </div>
      )}
      {state && state.eventCount > 0 && (
        <div className="workspace-inline-actions">
          <button
            className="btn xs ghost"
            type="button"
            disabled={busy || state.revisionGuards.length === 0}
            title="Append a complete content-addressed title snapshot before moving active history records into a recoverable Drive archive."
            onClick={() => void retainHistory().catch((cause) => setError(String(cause)))}
          >
            {busy ? 'Working...' : 'Retain title history'}
          </button>
          <span className="workspace-status mono">
            {state.eventCount} retained / {state.activeEventCount} active / {state.snapshotCount} snapshots
          </span>
        </div>
      )}
      {message && <div className="workspace-status mono" role="status">{message}</div>}
      {error && <div className="workspace-inline-alert" role="alert">{error}</div>}
    </div>
  )
}
