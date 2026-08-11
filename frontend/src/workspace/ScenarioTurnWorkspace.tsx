import { useEffect, useRef, useState, type FormEvent } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { now, uid } from '../util'
import { getProjectSharedTypes } from './projectModel'
import {
  attestScenarioTurnRevisionEvent,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'
import {
  addScenarioTurn,
  inspectScenarioGraph,
  readScenario,
  reconcileScenarioTurn,
  updateScenarioTurn,
  type ResearchScenario,
  type ScenarioTurn,
  type ScenarioTurnRole,
} from './scenarioModel'

const TURN_PAGE_SIZE = 50
const TURN_LINEAGE_SIZE = 50

export interface CreateHumanScenarioTurnInput {
  scenarioId: string
  turnId: string
  role: ScenarioTurnRole
  content: string
  authorId: string
  timestamp: number
  editId: string
}

export interface EditHumanScenarioTurnInput extends CreateHumanScenarioTurnInput {
  expectedCurrentEditId: string
}

export interface ReconcileHumanScenarioTurnInput extends EditHumanScenarioTurnInput {
  expectedTipEditIds: string[]
}

export function inspectScenarioTurnWorkspace(doc: Y.Doc) {
  const { scenarios } = getProjectSharedTypes(doc)
  return inspectScenarioGraph(scenarios)
}

function writableScenarios(doc: Y.Doc) {
  const shared = getProjectSharedTypes(doc)
  const integrity = inspectScenarioGraph(shared.scenarios)
  if (!integrity.healthy) throw new Error('Scenario data failed integrity checks; turn writes are disabled')
  return shared.scenarios
}

export function createHumanScenarioTurn(doc: Y.Doc, input: CreateHumanScenarioTurnInput): ResearchScenario {
  return addScenarioTurn(writableScenarios(doc), input)
}

export function editHumanScenarioTurn(doc: Y.Doc, input: EditHumanScenarioTurnInput): ResearchScenario {
  return updateScenarioTurn(writableScenarios(doc), input)
}

export function reconcileHumanScenarioTurn(doc: Y.Doc, input: ReconcileHumanScenarioTurnInput): ResearchScenario {
  return reconcileScenarioTurn(writableScenarios(doc), input)
}

export type TurnEditSession =
  | { mode: 'create' }
  | { mode: 'edit'; turnId: string; expectedCurrentEditId: string }

export interface ScenarioTurnWorkspaceContentProps {
  turns: ScenarioTurn[]
  totalTurns: number
  page: number
  pageCount: number
  editSession: TurnEditSession | null
  role: ScenarioTurnRole
  content: string
  conflict: boolean
  writesDisabled: boolean
  integrityIssues: string[]
  error: string
  turnAttribution: ResearchEventAttributionResult | null
  turnAttributionPending: boolean
  onOpenCreate: () => void
  onOpenEdit: (turn: ScenarioTurn) => void
  onReconcile: (turn: ScenarioTurn, revision: ScenarioTurn['revisions'][number]) => void
  onRole: (role: ScenarioTurnRole) => void
  onContent: (content: string) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
  onReload: () => void
  onCancel: () => void
  onPreviousPage: () => void
  onNextPage: () => void
}

function currentTurnRevision(turn: ScenarioTurn) {
  return turn.revisions.find((revision) => revision.editId === turn.headEditId)
}

export function hasScenarioTurnEditConflict(
  editSession: TurnEditSession | null,
  turn: ScenarioTurn | null | undefined,
) {
  return editSession?.mode === 'edit'
    && (turn?.headEditId !== editSession.expectedCurrentEditId || (turn?.tipEditIds.length ?? 0) > 1)
}

export function ScenarioTurnWorkspaceContent(props: ScenarioTurnWorkspaceContentProps) {
  return (
    <section className="scenario-turn-workspace" aria-label="Shared scenario conversation turns">
      <div className="scenario-section-heading">
        <div>
          <h3>Conversation turns</h3>
          <p className="scenario-generation-intro">
            Add or revise the shared test conversation without starting a model. Every save retains attributed history.
          </p>
        </div>
        <span className="mono">{props.totalTurns}</span>
      </div>

      {props.integrityIssues.length > 0 && (
        <div className="scenario-state error" role="alert">
          Turn editing is paused: {props.integrityIssues.join('; ')}
        </div>
      )}
      {props.error && <div className="scenario-state error" role="alert">{props.error}</div>}
      {props.turnAttributionPending && (
        <div className="scenario-state" role="status">
          Turn change saved. Checking registered-device attribution…
        </div>
      )}
      {!props.turnAttributionPending && props.turnAttribution?.status === 'signed-device' && (
        <div className="scenario-state success" role="status">
          Turn revision signed by registered device{' '}
          <span className="mono">
            {props.turnAttribution.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…
          </span>. This proves installation-key possession, not a person or organization.
        </div>
      )}
      {!props.turnAttributionPending && props.turnAttribution?.status === 'unsigned' && (
        <div className="scenario-state error" role="status">
          Turn change saved without a device signature: {
            props.turnAttribution.reason === 'device-directory-unhealthy'
              ? 'the project device directory needs attention.'
              : props.turnAttribution.reason === 'attestation-history-unhealthy'
                ? 'signed attribution history needs attention.'
                : 'this installation is not registered here or signing is unavailable.'}
        </div>
      )}

      {!props.editSession && (
        <div className="scenario-actions">
          <button className="btn sm" type="button" disabled={props.writesDisabled} onClick={props.onOpenCreate}>Add turn</button>
        </div>
      )}

      {props.editSession && (
        <form
          className="scenario-form scenario-turn-editor"
          aria-label={props.editSession.mode === 'create' ? 'Add scenario turn' : 'Edit scenario turn'}
          onSubmit={props.onSave}
        >
          <div className="scenario-section-heading">
            <h4>{props.editSession.mode === 'create' ? 'New conversation turn' : 'Edit current turn'}</h4>
            {props.editSession.mode === 'edit' && (
              <span className="mono">based on {props.editSession.expectedCurrentEditId.slice(0, 12)}</span>
            )}
          </div>
          <label>
            Role
            <select value={props.role} onChange={(event) => props.onRole(event.target.value as ScenarioTurnRole)}>
              <option value="system">System</option>
              <option value="user">User</option>
              <option value="assistant">Assistant</option>
            </select>
          </label>
          <label>
            Turn content
            <textarea
              value={props.content}
              maxLength={200_000}
              rows={7}
              required
              onChange={(event) => props.onContent(event.target.value)}
            />
          </label>
          <p className="scenario-generation-note">
            Saving appends an exact-parent revision under this installation's researcher identity. Identity and time are not authenticated.
          </p>
          {props.conflict && (
            <div className="scenario-state error" role="alert">
              This turn changed while you were editing. Reload the shared version before saving; your draft remains here until then.
            </div>
          )}
          <div className="scenario-actions">
            <button className="btn primary sm" type="submit" disabled={props.writesDisabled || props.conflict}>
              {props.editSession.mode === 'create' ? 'Save turn' : 'Save revision'}
            </button>
            {props.editSession.mode === 'edit' && (
              <button className="btn sm" type="button" onClick={props.onReload}>Reload shared</button>
            )}
            <button className="btn sm" type="button" onClick={props.onCancel}>Cancel</button>
          </div>
        </form>
      )}

      {props.totalTurns === 0 && !props.editSession && <p className="scenario-state">No turns yet.</p>}

      {props.turns.length > 0 && (
        <ol className="scenario-turns" aria-label="Scenario conversation turns">
          {props.turns.map((turn) => {
            const current = currentTurnRevision(turn)
            const lineage = turn.revisions.slice(-TURN_LINEAGE_SIZE)
            return (
              <li key={turn.id}>
                <div className="scenario-turn-meta mono">
                  {turn.role} · {turn.revisions.length} revision{turn.revisions.length === 1 ? '' : 's'} · {current?.authorId}
                </div>
                <div className="scenario-turn-content">{turn.content || <em>Empty turn</em>}</div>
                {turn.tipEditIds.length > 1 && (
                  <div className="scenario-state error" role="alert">
                    <p>This turn has {turn.tipEditIds.length} sibling revisions. Choose the content to retain; the new resolution records every sibling as a parent.</p>
                    <div className="scenario-actions" aria-label="Resolve sibling turn revisions">
                      {turn.tipEditIds.map((editId) => {
                        const revision = turn.revisions.find((candidate) => candidate.editId === editId)!
                        return <button
                          key={editId}
                          className="btn sm"
                          type="button"
                          disabled={props.writesDisabled}
                          onClick={() => props.onReconcile(turn, revision)}
                        >Use {revision.authorId} · {editId.slice(0, 12)}</button>
                      })}
                    </div>
                  </div>
                )}
                <div className="scenario-actions">
                  <button className="btn sm" type="button" disabled={props.writesDisabled || turn.tipEditIds.length > 1} onClick={() => props.onOpenEdit(turn)}>Edit</button>
                </div>
                <details className="scenario-turn-lineage">
                  <summary>Turn lineage · {turn.revisions.length} retained</summary>
                  {turn.revisions.length > TURN_LINEAGE_SIZE && (
                    <p>Showing the {TURN_LINEAGE_SIZE} most recent revisions.</p>
                  )}
                  <ol>
                    {lineage.map((revision) => (
                      <li key={revision.editId}>
                        <div className="scenario-turn-meta mono">
                          {revision.role} · {revision.authorId} · {revision.editId.slice(0, 12)} · {revision.source} · {revision.parentEditIds.length} parent{revision.parentEditIds.length === 1 ? '' : 's'}
                        </div>
                        <div className="scenario-turn-content">{revision.content || <em>Empty turn</em>}</div>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            )
          })}
        </ol>
      )}

      {props.pageCount > 1 && (
        <nav className="scenario-pagination" aria-label="Conversation turn pages">
          <button className="btn sm" type="button" disabled={props.page === 0} onClick={props.onPreviousPage}>Previous</button>
          <span className="mono">Page {props.page + 1} of {props.pageCount}</span>
          <button className="btn sm" type="button" disabled={props.page + 1 >= props.pageCount} onClick={props.onNextPage}>Next</button>
        </nav>
      )}
    </section>
  )
}

export function ScenarioTurnWorkspace({
  doc,
  projectId,
  scenario,
  parentWritesDisabled,
}: {
  doc: Y.Doc
  projectId: string
  scenario: ResearchScenario
  parentWritesDisabled: boolean
}) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [, setRevision] = useState(0)
  const [editSession, setEditSession] = useState<TurnEditSession | null>(null)
  const [role, setRole] = useState<ScenarioTurnRole>('user')
  const [content, setContent] = useState('')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [turnAttribution, setTurnAttribution] = useState<ResearchEventAttributionResult | null>(null)
  const [turnAttributionPending, setTurnAttributionPending] = useState(false)
  const turnOperation = useRef(0)

  useEffect(() => {
    const onUpdate = () => setRevision((value) => value + 1)
    doc.on('update', onUpdate)
    return () => doc.off('update', onUpdate)
  }, [doc])

  useEffect(() => {
    turnOperation.current += 1
    setEditSession(null)
    setRole('user')
    setContent('')
    setPage(0)
    setError('')
    setTurnAttribution(null)
    setTurnAttributionPending(false)
    return () => { turnOperation.current += 1 }
  }, [projectId, scenario.id])

  const integrity = inspectScenarioTurnWorkspace(doc)
  const currentScenario = readScenario(getProjectSharedTypes(doc).scenarios, scenario.id)
  const integrityIssues = [
    ...integrity.issues,
    ...(currentScenario ? [] : ['Selected scenario is missing or failed validation']),
  ]
  const turns = currentScenario?.turns ?? []
  const pageCount = Math.max(1, Math.ceil(turns.length / TURN_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visibleTurns = turns.slice(safePage * TURN_PAGE_SIZE, (safePage + 1) * TURN_PAGE_SIZE)
  const editingTurn = editSession?.mode === 'edit'
    ? turns.find((turn) => turn.id === editSession.turnId)
    : null
  const conflict = hasScenarioTurnEditConflict(editSession, editingTurn)
  const writesDisabled = parentWritesDisabled || integrityIssues.length > 0

  const identity = () => {
    if (getProjectSharedTypes(doc).metadata.get('projectId') !== projectId) {
      throw new Error('Live collaboration document project identity does not match')
    }
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before editing shared turns')
    }
    return researcherId
  }

  const beginEdit = (turn: ScenarioTurn) => {
    if (turn.tipEditIds.length > 1) {
      setError('Resolve the sibling revisions before starting another edit')
      return
    }
    const current = currentTurnRevision(turn)
    if (!current) {
      setError('Scenario turn history is invalid')
      return
    }
    setEditSession({ mode: 'edit', turnId: turn.id, expectedCurrentEditId: current.editId })
    setRole(turn.role)
    setContent(turn.content)
    setError('')
  }

  const reload = () => {
    if (!editingTurn) {
      setError('The shared turn is no longer available')
      return
    }
    beginEdit(editingTurn)
  }

  const publishAttribution = async (
    turnId: string,
    revision: ScenarioTurn['revisions'][number],
  ) => {
    const operation = turnOperation.current + 1
    turnOperation.current = operation
    setTurnAttribution(null)
    setTurnAttributionPending(true)
    try {
      const attribution = await attestScenarioTurnRevisionEvent(
        doc, projectId, scenario.id, turnId, revision,
      )
      if (turnOperation.current === operation) setTurnAttribution(attribution)
    } finally {
      if (turnOperation.current === operation) setTurnAttributionPending(false)
    }
  }

  const reconcile = async (turn: ScenarioTurn, revision: ScenarioTurn['revisions'][number]) => {
    setError('')
    try {
      const editId = `scenario-turn-reconciliation-${uid()}`
      const changed = reconcileHumanScenarioTurn(doc, {
        scenarioId: scenario.id,
        turnId: turn.id,
        role: revision.role,
        content: revision.content,
        authorId: identity(),
        timestamp: now(),
        editId,
        expectedCurrentEditId: turn.headEditId,
        expectedTipEditIds: [...turn.tipEditIds],
      })
      if (editSession?.mode === 'edit' && editSession.turnId === turn.id) setEditSession(null)
      const committed = changed.turns.find(({ id }) => id === turn.id)?.revisions.find(
        (candidate) => candidate.editId === editId,
      )
      if (!committed) throw new Error('Scenario turn revision was not retained')
      await publishAttribution(turn.id, committed)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario turn reconciliation failed')
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    try {
      if (!editSession) throw new Error('Open a turn editor first')
      if (!content.trim()) throw new Error('Turn content is required')
      if (content.length > 200_000) throw new Error('Turn content is too large')
      const authorId = identity()
      let turnId: string
      let editId: string
      let changed: ResearchScenario
      if (editSession.mode === 'create') {
        turnId = `scenario-turn-${uid()}`
        editId = `scenario-turn-revision-${uid()}`
        changed = createHumanScenarioTurn(doc, {
          scenarioId: scenario.id,
          turnId,
          role,
          content,
          authorId,
          timestamp: now(),
          editId,
        })
      } else {
        turnId = editSession.turnId
        editId = `scenario-turn-revision-${uid()}`
        changed = editHumanScenarioTurn(doc, {
          scenarioId: scenario.id,
          turnId: editSession.turnId,
          role,
          content,
          authorId,
          timestamp: now(),
          editId,
          expectedCurrentEditId: editSession.expectedCurrentEditId,
        })
      }
      setEditSession(null)
      setRole('user')
      setContent('')
      const committed = changed.turns.find(({ id }) => id === turnId)?.revisions.find(
        (candidate) => candidate.editId === editId,
      )
      if (!committed) throw new Error('Scenario turn revision was not retained')
      await publishAttribution(turnId, committed)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario turn update failed')
    }
  }

  return <ScenarioTurnWorkspaceContent
    turns={visibleTurns}
    totalTurns={turns.length}
    page={safePage}
    pageCount={pageCount}
    editSession={editSession}
    role={role}
    content={content}
    conflict={Boolean(conflict)}
    writesDisabled={writesDisabled}
    integrityIssues={integrityIssues}
    error={error}
    turnAttribution={turnAttribution}
    turnAttributionPending={turnAttributionPending}
    onOpenCreate={() => { setEditSession({ mode: 'create' }); setRole('user'); setContent(''); setError('') }}
    onOpenEdit={beginEdit}
    onReconcile={reconcile}
    onRole={setRole}
    onContent={setContent}
    onSave={save}
    onReload={reload}
    onCancel={() => { setEditSession(null); setRole('user'); setContent(''); setError('') }}
    onPreviousPage={() => setPage(Math.max(0, safePage - 1))}
    onNextPage={() => setPage(Math.min(pageCount - 1, safePage + 1))}
  />
}
