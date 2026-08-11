import { useEffect, useRef, useState, type FormEvent } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { now, uid } from '../util'
import {
  createScenarioAnnotation,
  inspectScenarioAnnotations,
  readScenarioAnnotations,
  setScenarioAnnotationResolution,
  updateScenarioAnnotation,
  type ScenarioAnnotation,
  type ScenarioAnnotationEvent,
  type ScenarioAnnotationKind,
} from './scenarioAnnotationModel'
import {
  commitScenarioAnnotationWithAttribution,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'
import {
  createScenarioLabel,
  inspectScenarioLabels,
  listScenarioLabels,
  readScenarioLabelAssignment,
  renameScenarioLabel,
  setScenarioLabelAssignment,
  type ScenarioLabel,
  type ScenarioLabelAssignment,
} from './scenarioLabelModel'
import { inspectScenarioGraph, type ResearchScenario } from './scenarioModel'
import { getProjectSharedTypes } from './projectModel'

export const SCENARIO_COLLABORATION_PAGE_SIZE = 50

export interface ScenarioLabelRow {
  label: ScenarioLabel
  assignment: ScenarioLabelAssignment | null
}

interface ScenarioCollaborationPanelContentProps {
  scenario: ResearchScenario
  annotations: ScenarioAnnotation[]
  annotationTotal: number
  labels: ScenarioLabelRow[]
  labelTotal: number
  canWrite: boolean
  annotationAttribution: ResearchEventAttributionResult | null
  annotationPending: boolean
  integrityIssues: string[]
  error: string
  annotationKind: ScenarioAnnotationKind
  annotationTurnId: string
  annotationBody: string
  editingAnnotationId: string | null
  annotationEditBody: string
  labelName: string
  renamingLabelId: string | null
  labelRenameName: string
  onAnnotationKind: (kind: ScenarioAnnotationKind) => void
  onAnnotationTurn: (turnId: string) => void
  onAnnotationBody: (body: string) => void
  onCreateAnnotation: (event: FormEvent<HTMLFormElement>) => void
  onStartAnnotationEdit: (annotation: ScenarioAnnotation) => void
  onCancelAnnotationEdit: () => void
  onAnnotationEditBody: (body: string) => void
  onSaveAnnotationEdit: (event: FormEvent<HTMLFormElement>) => void
  onSetAnnotationResolved: (annotation: ScenarioAnnotation, resolved: boolean) => void
  onMoreAnnotations: () => void
  onLabelName: (name: string) => void
  onCreateLabel: (event: FormEvent<HTMLFormElement>) => void
  onToggleLabel: (row: ScenarioLabelRow) => void
  onStartLabelRename: (label: ScenarioLabel) => void
  onCancelLabelRename: () => void
  onLabelRenameName: (name: string) => void
  onSaveLabelRename: (event: FormEvent<HTMLFormElement>) => void
  onMoreLabels: () => void
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

export function ScenarioCollaborationPanelContent({
  scenario,
  annotations,
  annotationTotal,
  labels,
  labelTotal,
  canWrite,
  annotationAttribution,
  annotationPending,
  integrityIssues,
  error,
  annotationKind,
  annotationTurnId,
  annotationBody,
  editingAnnotationId,
  annotationEditBody,
  labelName,
  renamingLabelId,
  labelRenameName,
  onAnnotationKind,
  onAnnotationTurn,
  onAnnotationBody,
  onCreateAnnotation,
  onStartAnnotationEdit,
  onCancelAnnotationEdit,
  onAnnotationEditBody,
  onSaveAnnotationEdit,
  onSetAnnotationResolved,
  onMoreAnnotations,
  onLabelName,
  onCreateLabel,
  onToggleLabel,
  onStartLabelRename,
  onCancelLabelRename,
  onLabelRenameName,
  onSaveLabelRename,
  onMoreLabels,
}: ScenarioCollaborationPanelContentProps) {
  const annotationRemaining = annotationTotal - annotations.length
  const labelRemaining = labelTotal - labels.length
  const annotationCanWrite = canWrite && !annotationPending
  return (
    <section className="scenario-collaboration" aria-label="Scenario notes and labels">
      <div className="scenario-section-heading">
        <h3>Shared notes and flags</h3>
        <span className="mono">{annotationTotal}</span>
      </div>
      <p className="scenario-identity-note">
        Notes, flags, labels, and their history are shared project data. Researcher names and local time are self-reported.
      </p>
      {annotationPending && (
        <p className="scenario-identity-note" role="status">
          Shared annotation saved. Checking registered-device attribution…
        </p>
      )}
      {!annotationPending && annotationAttribution?.status === 'signed-device' && (
        <p className="scenario-identity-note" role="status">
          Shared annotation event signed by registered device{' '}
          <span className="mono">
            {annotationAttribution.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…
          </span>. This proves installation-key possession, not a person or organization.
        </p>
      )}
      {!annotationPending && annotationAttribution?.status === 'unsigned' && (
        <p className="scenario-identity-note" role="status">
          Shared annotation saved without a device signature: {
            annotationAttribution.reason === 'device-directory-unhealthy'
              ? 'the project device directory needs attention.'
              : annotationAttribution.reason === 'attestation-history-unhealthy'
                ? 'signed attribution history needs attention.'
                : 'this installation is not registered here or signing is unavailable.'}
        </p>
      )}
      {integrityIssues.length > 0 && (
        <div className="scenario-state error" role="alert">
          Collaboration history needs attention: {integrityIssues.join('; ')}
        </div>
      )}
      {error && <div className="scenario-state error" role="alert">{error}</div>}

      <form className="scenario-form compact" aria-label="Add shared scenario annotation" onSubmit={onCreateAnnotation}>
        <label>
          Type
          <select value={annotationKind} disabled={!annotationCanWrite} onChange={(event) => onAnnotationKind(event.target.value as ScenarioAnnotationKind)}>
            <option value="note">Note</option>
            <option value="flag">Flag</option>
          </select>
        </label>
        <label>
          Attach to
          <select value={annotationTurnId} disabled={!annotationCanWrite} onChange={(event) => onAnnotationTurn(event.target.value)}>
            <option value="">Whole scenario</option>
            {scenario.turns.map((turn, index) => (
              <option key={turn.id} value={turn.id}>Turn {index + 1} · {turn.role}</option>
            ))}
          </select>
        </label>
        <label>
          Shared text
          <textarea value={annotationBody} maxLength={50_000} required disabled={!annotationCanWrite} onChange={(event) => onAnnotationBody(event.target.value)} />
        </label>
        <button className="btn sm" type="submit" disabled={!annotationCanWrite}>Add shared {annotationKind}</button>
      </form>

      {annotationTotal === 0 && <p className="scenario-state">No shared notes or flags yet.</p>}
      <ol className="scenario-annotation-list" aria-label="Shared scenario annotations">
        {annotations.map((annotation) => (
          <li key={annotation.id}>
            <div className="scenario-annotation-meta mono">
              {annotation.kind} · {annotation.status} · {annotation.turnId ? `turn ${annotation.turnId.slice(0, 8)}` : 'whole scenario'}
            </div>
            <p>{annotation.body}</p>
            <div className="scenario-annotation-attribution">
              Last action by {annotation.lastActionDisplayName} · {formatTimestamp(annotation.lastActionAt)} · {annotation.events.length} event{annotation.events.length === 1 ? '' : 's'}
            </div>
            {editingAnnotationId === annotation.id ? (
              <form className="scenario-form compact" aria-label={`Edit ${annotation.kind}`} onSubmit={onSaveAnnotationEdit}>
                <label>
                  Revised shared text
                  <textarea value={annotationEditBody} maxLength={50_000} required disabled={!annotationCanWrite} onChange={(event) => onAnnotationEditBody(event.target.value)} />
                </label>
                <div className="scenario-actions">
                  <button className="btn primary sm" type="submit" disabled={!annotationCanWrite}>Save edit</button>
                  <button className="btn sm" type="button" onClick={onCancelAnnotationEdit}>Cancel</button>
                </div>
              </form>
            ) : (
              <div className="scenario-actions">
                {annotation.status === 'open' && (
                  <button className="btn sm" type="button" disabled={!annotationCanWrite} onClick={() => onStartAnnotationEdit(annotation)}>Edit</button>
                )}
                <button
                  className="btn sm"
                  type="button"
                  disabled={!annotationCanWrite}
                  onClick={() => onSetAnnotationResolved(annotation, annotation.status === 'open')}
                >
                  {annotation.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {annotationRemaining > 0 && (
        <button className="btn sm" type="button" onClick={onMoreAnnotations}>
          Show next {Math.min(SCENARIO_COLLABORATION_PAGE_SIZE, annotationRemaining)} · {annotationRemaining} remaining
        </button>
      )}

      <div className="scenario-section-heading">
        <h3>Context labels</h3>
        <span className="mono">{labelTotal}</span>
      </div>
      <form className="scenario-form compact" aria-label="Create shared scenario label" onSubmit={onCreateLabel}>
        <label>
          New label
          <input value={labelName} maxLength={200} required disabled={!canWrite} onChange={(event) => onLabelName(event.target.value)} />
        </label>
        <button className="btn sm" type="submit" disabled={!canWrite}>Create label</button>
      </form>
      {labelTotal === 0 && <p className="scenario-state">No project labels yet.</p>}
      <ul className="scenario-label-list" aria-label="Project scenario labels">
        {labels.map((row) => (
          <li key={row.label.id}>
            {renamingLabelId === row.label.id ? (
              <form className="scenario-form compact" aria-label="Rename shared scenario label" onSubmit={onSaveLabelRename}>
                <label>
                  Label name
                  <input value={labelRenameName} maxLength={200} required onChange={(event) => onLabelRenameName(event.target.value)} />
                </label>
                <div className="scenario-actions">
                  <button className="btn primary sm" type="submit" disabled={!canWrite}>Save name</button>
                  <button className="btn sm" type="button" onClick={onCancelLabelRename}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                <label className="scenario-label-toggle">
                  <input
                    type="checkbox"
                    checked={row.assignment?.assigned === true}
                    disabled={!canWrite}
                    onChange={() => onToggleLabel(row)}
                  />
                  <span>{row.label.name}</span>
                </label>
                <button className="btn sm" type="button" disabled={!canWrite} onClick={() => onStartLabelRename(row.label)}>Rename</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {labelRemaining > 0 && (
        <button className="btn sm" type="button" onClick={onMoreLabels}>
          Show next {Math.min(SCENARIO_COLLABORATION_PAGE_SIZE, labelRemaining)} · {labelRemaining} remaining
        </button>
      )}
    </section>
  )
}

export function ScenarioCollaborationPanel({
  doc,
  projectId,
  scenario,
  writesDisabled,
}: {
  doc: Y.Doc
  projectId: string
  scenario: ResearchScenario
  writesDisabled: boolean
}) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [annotationKind, setAnnotationKind] = useState<ScenarioAnnotationKind>('note')
  const [annotationTurnId, setAnnotationTurnId] = useState('')
  const [annotationBody, setAnnotationBody] = useState('')
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const [annotationEditBody, setAnnotationEditBody] = useState('')
  const [annotationEditHead, setAnnotationEditHead] = useState('')
  const [labelName, setLabelName] = useState('')
  const [renamingLabelId, setRenamingLabelId] = useState<string | null>(null)
  const [labelRenameName, setLabelRenameName] = useState('')
  const [labelRenameHead, setLabelRenameHead] = useState('')
  const [annotationLimit, setAnnotationLimit] = useState(SCENARIO_COLLABORATION_PAGE_SIZE)
  const [labelLimit, setLabelLimit] = useState(SCENARIO_COLLABORATION_PAGE_SIZE)
  const [error, setError] = useState('')
  const [annotationAttribution, setAnnotationAttribution] = useState<ResearchEventAttributionResult | null>(null)
  const [annotationPending, setAnnotationPending] = useState(false)
  const annotationOperation = useRef(0)

  useEffect(() => {
    annotationOperation.current += 1
    setAnnotationTurnId('')
    setAnnotationBody('')
    setEditingAnnotationId(null)
    setRenamingLabelId(null)
    setAnnotationLimit(SCENARIO_COLLABORATION_PAGE_SIZE)
    setLabelLimit(SCENARIO_COLLABORATION_PAGE_SIZE)
    setAnnotationAttribution(null)
    setAnnotationPending(false)
    setError('')
    return () => { annotationOperation.current += 1 }
  }, [projectId, scenario.id])

  const shared = getProjectSharedTypes(doc)
  const annotationInspection = inspectScenarioAnnotations(shared.discussions, shared.scenarios)
  const labelInspection = inspectScenarioLabels(shared.settings, shared.scenarios)
  const integrityIssues = [...annotationInspection.issues, ...labelInspection.issues]
  const allAnnotations = [...(readScenarioAnnotations(shared.discussions, scenario.id) ?? [])]
    .sort((left, right) => right.lastActionAt - left.lastActionAt || left.id.localeCompare(right.id))
  const allLabels = listScenarioLabels(shared.settings)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const canWrite = !writesDisabled && integrityIssues.length === 0

  const identity = () => {
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before editing shared scenario notes or labels')
    return { authorId: researcherId, displayName: researcherName.trim() }
  }
  const assertWritable = () => {
    if (writesDisabled || !inspectScenarioGraph(shared.scenarios).healthy ||
      !inspectScenarioAnnotations(shared.discussions, shared.scenarios).healthy ||
      !inspectScenarioLabels(shared.settings, shared.scenarios).healthy) {
      throw new Error('Shared scenario collaboration data failed integrity checks; writes are disabled')
    }
  }
  const mutate = (operation: () => void) => {
    setError('')
    try {
      assertWritable()
      operation()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario collaboration update failed')
    }
  }

  const runAnnotationMutation = async (operation: () => ScenarioAnnotationEvent) => {
    const operationId = annotationOperation.current + 1
    annotationOperation.current = operationId
    setError('')
    setAnnotationAttribution(null)
    setAnnotationPending(true)
    try {
      assertWritable()
      const result = await commitScenarioAnnotationWithAttribution(doc, projectId, operation)
      if (annotationOperation.current === operationId) setAnnotationAttribution(result.attribution)
    } catch (caught) {
      if (annotationOperation.current === operationId) {
        setError(caught instanceof Error ? caught.message : 'Scenario annotation update failed')
      }
    } finally {
      if (annotationOperation.current === operationId) setAnnotationPending(false)
    }
  }

  const createAnnotation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void runAnnotationMutation(() => {
      const author = identity()
      const eventId = uid()
      const annotation = createScenarioAnnotation(shared.discussions, shared.scenarios, {
        annotationId: uid(), eventId, scenarioId: scenario.id,
        turnId: annotationTurnId || null, kind: annotationKind, body: annotationBody,
        authorId: author.authorId, displayName: author.displayName, timestamp: now(),
      })
      setAnnotationBody('')
      const retainedEvent = annotation.events.find((candidate) => candidate.eventId === eventId)
      if (!retainedEvent) throw new Error('Scenario annotation event was not retained')
      return retainedEvent
    })
  }

  const startAnnotationEdit = (annotation: ScenarioAnnotation) => {
    setEditingAnnotationId(annotation.id)
    setAnnotationEditBody(annotation.body)
    setAnnotationEditHead(annotation.currentEventId)
    setError('')
  }
  const cancelAnnotationEdit = () => {
    setEditingAnnotationId(null)
    setAnnotationEditBody('')
    setAnnotationEditHead('')
  }
  const saveAnnotationEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void runAnnotationMutation(() => {
      if (!editingAnnotationId || !annotationEditHead) throw new Error('Select a shared note or flag to edit')
      const author = identity()
      const eventId = uid()
      const annotation = updateScenarioAnnotation(shared.discussions, shared.scenarios, {
        annotationId: editingAnnotationId, eventId, scenarioId: scenario.id,
        expectedCurrentEventId: annotationEditHead, body: annotationEditBody,
        authorId: author.authorId, displayName: author.displayName, timestamp: now(),
      })
      cancelAnnotationEdit()
      const retainedEvent = annotation.events.find((candidate) => candidate.eventId === eventId)
      if (!retainedEvent) throw new Error('Scenario annotation event was not retained')
      return retainedEvent
    })
  }
  const setAnnotationResolved = (annotation: ScenarioAnnotation, resolved: boolean) => {
    void runAnnotationMutation(() => {
      const author = identity()
      const eventId = uid()
      const changed = setScenarioAnnotationResolution(shared.discussions, shared.scenarios, {
        annotationId: annotation.id, eventId, scenarioId: scenario.id,
        expectedCurrentEventId: annotation.currentEventId, resolved,
        authorId: author.authorId, displayName: author.displayName, timestamp: now(),
      })
      const retainedEvent = changed.events.find((candidate) => candidate.eventId === eventId)
      if (!retainedEvent) throw new Error('Scenario annotation event was not retained')
      return retainedEvent
    })
  }

  const createLabel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      const author = identity()
      createScenarioLabel(shared.settings, {
        labelId: uid(), eventId: uid(), name: labelName.trim(), authorId: author.authorId, timestamp: now(),
      })
      setLabelName('')
    })
  }
  const toggleLabel = (row: ScenarioLabelRow) => mutate(() => {
    const author = identity()
    setScenarioLabelAssignment(shared.settings, shared.scenarios, {
      scenarioId: scenario.id, labelId: row.label.id, eventId: uid(),
      expectedCurrentEventId: row.assignment?.currentEventId ?? null,
      assigned: row.assignment?.assigned !== true, authorId: author.authorId, timestamp: now(),
    })
  })
  const startLabelRename = (label: ScenarioLabel) => {
    setRenamingLabelId(label.id)
    setLabelRenameName(label.name)
    setLabelRenameHead(label.currentEventId)
    setError('')
  }
  const cancelLabelRename = () => {
    setRenamingLabelId(null)
    setLabelRenameName('')
    setLabelRenameHead('')
  }
  const saveLabelRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      if (!renamingLabelId || !labelRenameHead) throw new Error('Select a label to rename')
      const author = identity()
      renameScenarioLabel(shared.settings, {
        labelId: renamingLabelId, eventId: uid(), expectedCurrentEventId: labelRenameHead,
        name: labelRenameName.trim(), authorId: author.authorId, timestamp: now(),
      })
      cancelLabelRename()
    })
  }

  return (
    <ScenarioCollaborationPanelContent
      scenario={scenario}
      annotations={allAnnotations.slice(0, annotationLimit)} annotationTotal={allAnnotations.length}
      labels={allLabels.slice(0, labelLimit).map((label) => ({
        label,
        assignment: readScenarioLabelAssignment(shared.settings, scenario.id, label.id),
      }))} labelTotal={allLabels.length}
      canWrite={canWrite} annotationAttribution={annotationAttribution}
      annotationPending={annotationPending} integrityIssues={integrityIssues} error={error}
      annotationKind={annotationKind} annotationTurnId={annotationTurnId} annotationBody={annotationBody}
      editingAnnotationId={editingAnnotationId} annotationEditBody={annotationEditBody}
      labelName={labelName} renamingLabelId={renamingLabelId} labelRenameName={labelRenameName}
      onAnnotationKind={setAnnotationKind} onAnnotationTurn={setAnnotationTurnId}
      onAnnotationBody={setAnnotationBody} onCreateAnnotation={createAnnotation}
      onStartAnnotationEdit={startAnnotationEdit} onCancelAnnotationEdit={cancelAnnotationEdit}
      onAnnotationEditBody={setAnnotationEditBody} onSaveAnnotationEdit={saveAnnotationEdit}
      onSetAnnotationResolved={setAnnotationResolved}
      onMoreAnnotations={() => setAnnotationLimit((value) => value + SCENARIO_COLLABORATION_PAGE_SIZE)}
      onLabelName={setLabelName} onCreateLabel={createLabel} onToggleLabel={toggleLabel}
      onStartLabelRename={startLabelRename} onCancelLabelRename={cancelLabelRename}
      onLabelRenameName={setLabelRenameName} onSaveLabelRename={saveLabelRename}
      onMoreLabels={() => setLabelLimit((value) => value + SCENARIO_COLLABORATION_PAGE_SIZE)}
    />
  )
}
