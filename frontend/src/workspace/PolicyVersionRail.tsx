import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { cx } from '../util'
import { readAutomationEditor } from './editorAutomation'
import { automationEditorReady } from './editorAutomationRegistry'
import { deterministicChangeNote, diffPolicyVersions, type PolicyVersionDiff } from './policyVersionHistory'
import { getProjectSharedTypes } from './projectModel'
import {
  listPolicyVersions,
  readPolicyVersionHead,
  type PolicyVersion,
} from './policyVersionModel'
import type { ResearchProjectManifest } from './schema'
import { saveAutomationPolicyVersion } from './versionAutomation'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

export interface VersionRailSelection {
  version: PolicyVersion | null
  parent: PolicyVersion | null
  diff: PolicyVersionDiff | null
  changeNote: string | null
}

export function selectVersionRailEntry(
  versions: PolicyVersion[],
  selectedVersionId: string | null,
): VersionRailSelection {
  const byId = new Map(versions.map((version) => [version.versionId, version]))
  const version = selectedVersionId ? (byId.get(selectedVersionId) ?? null) : null
  const parent = version?.parentVersionId ? (byId.get(version.parentVersionId) ?? null) : null
  if (version?.parentVersionId && !parent) throw new Error('Selected policy version has a missing parent')
  const diff = version && parent ? diffPolicyVersions(parent, version) : null
  return {
    version,
    parent,
    diff,
    changeNote: diff ? deterministicChangeNote(diff) : null,
  }
}

export function assertVersionRailHistory(
  versions: PolicyVersion[],
  storedCount: number,
  headVersionId: string | null,
): void {
  if (versions.length !== storedCount) throw new Error('Version history contains an invalid checkpoint')
  const byId = new Set(versions.map((version) => version.versionId))
  if (headVersionId && !byId.has(headVersionId)) throw new Error('Version history head is missing')
  for (const version of versions) {
    if (version.parentVersionId && !byId.has(version.parentVersionId)) {
      throw new Error('Version history contains a missing parent')
    }
  }
}

const shortVersionId = (versionId: string) => versionId.slice(0, 10)
const versionTime = (createdAt: number) => new Date(createdAt).toLocaleString()
const changeText = (change: PolicyVersionDiff['changes'][number]) => {
  const text = change.after?.text ?? change.before?.text ?? change.identity
  return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

export function PolicyVersionRailContent({
  ready,
  versions,
  headVersionId,
  selectedVersionId,
  note,
  busy,
  error,
  savedStatus,
  onSelect,
  onNoteChange,
  onSave,
}: {
  ready: boolean
  versions: PolicyVersion[]
  headVersionId: string | null
  selectedVersionId: string | null
  note: string
  busy: boolean
  error: string
  savedStatus: string
  onSelect: (versionId: string) => void
  onNoteChange: (note: string) => void
  onSave: () => void
}) {
  const ordered = [...versions].reverse()
  const selection = selectVersionRailEntry(versions, selectedVersionId)

  return (
    <aside className="workspace-rail" aria-label="Project versions">
      <div className="workspace-panel-label mono">Version history</div>
      <div className="workspace-rail-node active">
        <span>Live draft</span>
        <small>{headVersionId ? `Based on ${shortVersionId(headVersionId)}` : 'No saved version yet'}</small>
      </div>

      <form
        className="version-save"
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
      >
        <label htmlFor="version-note">Version note <span>(optional)</span></label>
        <input
          id="version-note"
          value={note}
          maxLength={20_000}
          placeholder="What changed?"
          onChange={(event) => onNoteChange(event.target.value)}
        />
        <button className="btn sm" type="submit" disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Save current draft'}
        </button>
      </form>

      {!ready && !error && <p className="version-status">Opening the live project…</p>}
      {ready && versions.length === 0 && <p className="version-status">Saved versions will appear here.</p>}
      {savedStatus && <p className="version-status success" role="status">{savedStatus}</p>}
      {error && <p className="version-status error" role="alert">{error}</p>}

      {ordered.length > 0 && (
        <div className="version-list" aria-label="Saved versions">
          {ordered.map((version, index) => {
            const selected = version.versionId === selectedVersionId
            const head = version.versionId === headVersionId
            return (
              <button
                key={version.versionId}
                type="button"
                className={cx('version-row', selected && 'selected', head && 'head')}
                aria-pressed={selected}
                onClick={() => onSelect(version.versionId)}
              >
                <span className="version-row-title">
                  Version {versions.length - index}
                  {head && <em>Current head</em>}
                </span>
                <small>{version.author.displayName} · {versionTime(version.createdAt)}</small>
                <code>{shortVersionId(version.versionId)}</code>
              </button>
            )
          })}
        </div>
      )}

      {selection.version && (
        <section className="version-detail" aria-label="Selected version details">
          <div className="workspace-panel-label mono">Selected checkpoint</div>
          <h3>{selection.version.note?.trim() || 'Untitled checkpoint'}</h3>
          <p>
            Saved by {selection.version.author.displayName} on {versionTime(selection.version.createdAt)}.
          </p>
          {selection.changeNote ? <p className="version-change-note">{selection.changeNote}</p> : (
            <p className="version-change-note">Initial version with {selection.version.policy.blocks.length} blocks.</p>
          )}
          {selection.diff && selection.diff.changes.length > 0 && (
            <ol className="version-changes">
              {selection.diff.changes.slice(0, 8).map((change) => (
                <li key={`${change.kind}:${change.identity}`}>
                  <span>{change.kind}</span>
                  <p>{changeText(change)}</p>
                </li>
              ))}
            </ol>
          )}
          {selection.diff && selection.diff.changes.length > 8 && (
            <p className="version-status">{selection.diff.changes.length - 8} more changes</p>
          )}
          <p className="version-restore-note">
            Inspection is read-only. Safe restore will arrive with one atomic live-draft and history operation.
          </p>
        </section>
      )}
    </aside>
  )
}

export function PolicyVersionRail({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [versions, setVersions] = useState<PolicyVersion[]>([])
  const [headVersionId, setHeadVersionId] = useState<string | null>(null)
  const [historyValid, setHistoryValid] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedStatus, setSavedStatus] = useState('')

  useEffect(
    () => subscribeAutomationProjectDocument(project.id, setDoc),
    [project.id],
  )

  useEffect(() => {
    if (!doc) {
      setVersions([])
      setHeadVersionId(null)
      setHistoryValid(false)
      setSelectedVersionId(null)
      return
    }
    let active = true
    let loadGeneration = 0
    const { metadata, versions: versionMap } = getProjectSharedTypes(doc)
    const load = async () => {
      const generation = ++loadGeneration
      if (active) setHistoryValid(false)
      try {
        const nextVersions = await listPolicyVersions(versionMap)
        const nextHead = readPolicyVersionHead(metadata)
        assertVersionRailHistory(nextVersions, versionMap.size, nextHead)
        if (!active || generation !== loadGeneration) return
        setVersions(nextVersions)
        setHeadVersionId(nextHead)
        setSelectedVersionId((current) =>
          current && nextVersions.some((version) => version.versionId === current)
            ? current
            : (nextHead ?? nextVersions[nextVersions.length - 1]?.versionId ?? null),
        )
        setError('')
        setHistoryValid(true)
      } catch (cause) {
        if (active && generation === loadGeneration) {
          setHistoryValid(false)
          setVersions([])
          setHeadVersionId(null)
          setSelectedVersionId(null)
          setError((cause as Error)?.message ?? 'Could not read version history.')
        }
      }
    }
    const observe = () => void load()
    versionMap.observeDeep(observe)
    metadata.observe(observe)
    void load()
    return () => {
      active = false
      versionMap.unobserveDeep(observe)
      metadata.unobserve(observe)
    }
  }, [doc])

  const ready = !!doc && historyValid && automationEditorReady(project.id)

  const save = async () => {
    if (!doc || busy || !historyValid) return
    setBusy(true)
    setError('')
    setSavedStatus('')
    try {
      if (!researcherName.trim()) throw new Error('Add your researcher name in Settings before saving a version.')
      const snapshot = readAutomationEditor(project.id)
      const { metadata } = getProjectSharedTypes(doc)
      const saved = await saveAutomationPolicyVersion(doc, project.id, {
        expectedDocumentRevision: snapshot.revision,
        expectedHeadVersionId: readPolicyVersionHead(metadata),
        participantId: researcherId,
        displayName: researcherName,
        createdAt: Date.now(),
        note: note.trim() || null,
      }, () => readAutomationEditor(project.id))
      setSelectedVersionId(saved.version.versionId)
      setNote('')
      setSavedStatus(saved.changeNote ?? `Initial version saved with ${saved.version.policy.blocks.length} blocks.`)
    } catch (cause) {
      setError((cause as Error)?.message ?? 'Could not save the current draft.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PolicyVersionRailContent
      ready={ready}
      versions={versions}
      headVersionId={headVersionId}
      selectedVersionId={selectedVersionId}
      note={note}
      busy={busy}
      error={error}
      savedStatus={savedStatus}
      onSelect={setSelectedVersionId}
      onNoteChange={setNote}
      onSave={() => void save()}
    />
  )
}
