import { useRef, useState } from 'react'
import type * as Y from 'yjs'
import { saveTextFile } from '../tauri'
import { useStore } from '../store'
import { now, uid } from '../util'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import type { ResearchScenario } from './scenarioModel'
import {
  createScenarioPack,
  decodeScenarioPack,
  importScenarioPack,
  planScenarioPackImport,
  scenarioPackFilename,
  SCENARIO_PACK_MAX_FILE_BYTES,
  type ScenarioPack,
  type ScenarioPackImportPlan,
} from './scenarioPack'

interface PendingImport {
  pack: ScenarioPack
  plan: ScenarioPackImportPlan
}

export interface ScenarioPackControlsContentProps {
  ready: boolean
  healthy: boolean
  scenarioCount: number
  selectedTitle: string
  title: string
  description: string
  license: string
  busy: boolean
  pending: PendingImport | null
  status: string
  error: string
  onTitle: (value: string) => void
  onDescription: (value: string) => void
  onLicense: (value: string) => void
  onExportSelected: () => void
  onExportAll: () => void
  onChooseImport: () => void
  onConfirmImport: () => void
  onCancelImport: () => void
}

export function ScenarioPackControlsContent({
  ready, healthy, scenarioCount, selectedTitle, title, description, license, busy, pending,
  status, error, onTitle, onDescription, onLicense, onExportSelected, onExportAll,
  onChooseImport, onConfirmImport, onCancelImport,
}: ScenarioPackControlsContentProps) {
  const usable = ready && healthy && !busy
  return (
    <section className="scenario-detail scenario-pack-controls" aria-label="Portable scenario packs">
      <div className="scenario-section-heading">
        <div>
          <div className="workspace-panel-label mono">Open format</div>
          <h3>Portable scenario packs</h3>
        </div>
      </div>
      <p className="scenario-state">
        Move reusable scenario authoring between projects or tools without copying the rest of a project.
      </p>
      <details>
        <summary>Pack details and included data</summary>
        <div className="scenario-form compact">
          <label>Pack title<input value={title} maxLength={200} required onChange={(event) => onTitle(event.target.value)} /></label>
          <label>Description<textarea value={description} maxLength={20_000} onChange={(event) => onDescription(event.target.value)} /></label>
          <label>License (optional)<input value={license} maxLength={200} placeholder="For example, CC0-1.0" onChange={(event) => onLicense(event.target.value)} /></label>
        </div>
        <p className="scenario-identity-note">
          Includes titles, backgrounds, lineage, ordered turns, full revision and edit history, timestamps, and author IDs.
          Excludes votes, annotations, labels, model outputs, policies, and project files. Import does not contact a model or network.
        </p>
      </details>
      <div className="scenario-actions">
        <button className="btn sm" type="button" disabled={!usable || !selectedTitle} onClick={onExportSelected}>
          Export selected{selectedTitle ? `: ${selectedTitle}` : ''}
        </button>
        <button className="btn sm" type="button" disabled={!usable || scenarioCount === 0} onClick={onExportAll}>Export all</button>
        <button className="btn sm" type="button" disabled={!usable} onClick={onChooseImport}>Choose pack to import</button>
      </div>
      {pending && (
        <div className="scenario-state" role="status">
          <strong>{pending.pack.title}</strong> is valid: {pending.plan.addScenarioIds.length} new,
          {' '}{pending.plan.existingScenarioIds.length} already present, {pending.pack.scenarios.length} total.
          <div className="scenario-actions">
            <button className="btn primary sm" type="button" disabled={!usable} onClick={onConfirmImport}>Import validated pack</button>
            <button className="btn sm" type="button" disabled={busy} onClick={onCancelImport}>Cancel</button>
          </div>
        </div>
      )}
      {status && !error && <p className="scenario-state mono" role="status" aria-live="polite">{status}</p>}
      {error && <p className="scenario-state error" role="alert">{error}</p>}
    </section>
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Scenario pack operation failed'
}

export function ScenarioPackControls({
  project, doc, scenarios, selected, integrityIssues,
}: {
  project: ResearchProjectManifest
  doc: Y.Doc | null
  scenarios: ResearchScenario[]
  selected: ResearchScenario | null
  integrityIssues: string[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [title, setTitle] = useState(`${project.title} scenarios`)
  const [description, setDescription] = useState('')
  const [license, setLicense] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const begin = () => { setBusy(true); setStatus(''); setError('') }
  const identity = () => {
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before exporting scenario history')
    return { id: researcherId, name: researcherName.trim() }
  }
  const exportPack = async (selectedScenarioIds?: string[]) => {
    begin()
    try {
      const author = identity()
      const text = await createScenarioPack({
        packId: uid(), title: title.trim(), description, license: license.trim() || null,
        source: {
          projectId: project.id, documentId: project.documentId, projectTitle: project.title,
          exportedBy: author.id, exportedByDisplayName: author.name, exportedAt: now(),
        },
        scenarios, selectedScenarioIds,
      })
      const saved = await saveTextFile(scenarioPackFilename(title), text, 'application/json')
      setStatus(saved ? 'Scenario pack saved.' : 'Export cancelled.')
    } catch (caught) {
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }
  const chooseImport = async (file: File) => {
    begin()
    try {
      if (file.size > SCENARIO_PACK_MAX_FILE_BYTES) throw new Error('Scenario pack exceeds the file size limit')
      const pack = await decodeScenarioPack(await file.text())
      const plan = planScenarioPackImport(scenarios, pack)
      if (plan.collisionScenarioIds.length) {
        throw new Error(`Scenario ID collision: ${plan.collisionScenarioIds.join(', ')}`)
      }
      setPending({ pack, plan })
      setStatus('Pack checksum, schema, graph, and authoring history are valid. Review before importing.')
    } catch (caught) {
      setPending(null)
      setError(message(caught))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }
  const confirmImport = () => {
    if (!doc || !pending) return
    begin()
    try {
      const result = importScenarioPack(getProjectSharedTypes(doc).scenarios, pending.pack)
      setPending(null)
      setStatus(`Imported ${result.addedScenarioIds.length} scenario(s); ${result.existingScenarioIds.length} exact duplicate(s) skipped.`)
    } catch (caught) {
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input ref={inputRef} className="project-archive-file" type="file"
        accept="application/json,.json,.syzygy-scenarios.json" aria-label="Choose a Syzygy scenario pack"
        disabled={busy || !doc || integrityIssues.length > 0}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void chooseImport(file) }} />
      <ScenarioPackControlsContent
        ready={Boolean(doc)} healthy={integrityIssues.length === 0} scenarioCount={scenarios.length}
        selectedTitle={selected?.title ?? ''} title={title} description={description} license={license}
        busy={busy} pending={pending} status={status} error={error}
        onTitle={setTitle} onDescription={setDescription} onLicense={setLicense}
        onExportSelected={() => { if (selected) void exportPack([selected.id]) }}
        onExportAll={() => void exportPack()} onChooseImport={() => inputRef.current?.click()}
        onConfirmImport={confirmImport} onCancelImport={() => { setPending(null); setStatus('Import cancelled.') }} />
    </>
  )
}
