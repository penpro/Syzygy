import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { now, uid } from '../util'
import { useStore } from '../store'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import {
  createScenario,
  inspectScenarioGraph,
  listScenarios,
  readScenario,
  updateScenario,
  type ResearchScenario,
  type ScenarioStatus,
} from './scenarioModel'
import {
  readScenarioVotes,
  type ScenarioVoteChoice,
  type ScenarioVoteSummary,
} from './scenarioVoteModel'
import {
  castScenarioVoteWithAttribution,
  commitScenarioEditWithAttribution,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'
import { ScenarioGenerator } from './ScenarioGenerator'
import { HeuristicWorkspace } from './HeuristicWorkspace'
import { ScenarioRerunQueuePanel } from './ScenarioRerunQueuePanel'
import { ScenarioPackControls } from './ScenarioPackControls'
import { ScenarioCollaborationPanel } from './ScenarioCollaborationPanel'
import { ScenarioTurnWorkspace } from './ScenarioTurnWorkspace'

interface ScenarioWorkspaceContentProps {
  ready: boolean
  scenarios: ResearchScenario[]
  selected: ResearchScenario | null
  voteSummary: ScenarioVoteSummary | null
  currentVote: ScenarioVoteChoice | null
  scenarioAttribution: ResearchEventAttributionResult | null
  scenarioPending: boolean
  voteAttribution: ResearchEventAttributionResult | null
  votePending: boolean
  integrityIssues: string[]
  generation?: ReactNode
  collaboration?: ReactNode
  heuristics?: ReactNode
  reruns?: ReactNode
  packs?: ReactNode
  turnWorkspace?: ReactNode
  createOpen: boolean
  createTitle: string
  createBackground: string
  editTitle: string
  editBackground: string
  error: string
  onSelect: (id: string) => void
  onOpenCreate: () => void
  onCancelCreate: () => void
  onCreateTitle: (value: string) => void
  onCreateBackground: (value: string) => void
  onCreate: (event: FormEvent<HTMLFormElement>) => void
  onEditTitle: (value: string) => void
  onEditBackground: (value: string) => void
  onSaveDetails: () => void
  onReloadDetails: () => void
  onSetStatus: (status: ScenarioStatus) => void
  onVote: (choice: ScenarioVoteChoice) => void
}

const voteChoices: Array<Exclude<ScenarioVoteChoice, 'withdrawn'>> = ['support', 'oppose', 'abstain']

export function ScenarioWorkspaceContent({
  ready,
  scenarios,
  selected,
  voteSummary,
  currentVote,
  scenarioAttribution,
  scenarioPending,
  voteAttribution,
  votePending,
  integrityIssues,
  generation,
  collaboration,
  heuristics,
  reruns,
  packs,
  turnWorkspace,
  createOpen,
  createTitle,
  createBackground,
  editTitle,
  editBackground,
  error,
  onSelect,
  onOpenCreate,
  onCancelCreate,
  onCreateTitle,
  onCreateBackground,
  onCreate,
  onEditTitle,
  onEditBackground,
  onSaveDetails,
  onReloadDetails,
  onSetStatus,
  onVote,
}: ScenarioWorkspaceContentProps) {
  const canWrite = ready && integrityIssues.length === 0
  return (
    <div className="scenario-workspace" aria-label="Scenario workspace">
      <div className="scenario-heading">
        <div>
          <div className="workspace-panel-label mono">Scenarios</div>
          <h2>Collaborative test cases</h2>
        </div>
        <button className="btn sm" type="button" disabled={!canWrite || scenarioPending} onClick={onOpenCreate}>New</button>
      </div>

      {!ready && <p className="scenario-state" role="status">Preparing shared scenario data…</p>}
      {integrityIssues.length > 0 && (
        <div className="scenario-state error" role="alert">
          Scenario data needs attention: {integrityIssues.join('; ')}
        </div>
      )}
      {error && <div className="scenario-state error" role="alert">{error}</div>}

      {createOpen && (
        <form className="scenario-form" aria-label="Create scenario" onSubmit={onCreate}>
          <label>
            Title
            <input value={createTitle} maxLength={200} required onChange={(event) => onCreateTitle(event.target.value)} />
          </label>
          <label>
            Background <span>(optional)</span>
            <textarea value={createBackground} maxLength={50_000} onChange={(event) => onCreateBackground(event.target.value)} />
          </label>
          <div className="scenario-actions">
            <button className="btn primary sm" type="submit" disabled={!canWrite || scenarioPending}>Create scenario</button>
            <button className="btn sm" type="button" onClick={onCancelCreate}>Cancel</button>
          </div>
        </form>
      )}

      {ready && !createOpen && scenarios.length === 0 && (
        <p className="scenario-state">No scenarios yet. Create a test case without starting a model.</p>
      )}

      {scenarios.length > 0 && (
        <nav className="scenario-list" aria-label="Project scenarios">
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              className={scenario.id === selected?.id ? 'scenario-list-item active' : 'scenario-list-item'}
              type="button"
              aria-current={scenario.id === selected?.id ? 'true' : undefined}
              onClick={() => onSelect(scenario.id)}
            >
              <span>{scenario.title}</span>
              <small className="mono">{scenario.status} · {scenario.turns.length} turn{scenario.turns.length === 1 ? '' : 's'}</small>
            </button>
          ))}
        </nav>
      )}

      {selected && (
        <section className="scenario-detail" aria-label={`Selected scenario: ${selected.title}`}>
          {selected.parentScenarioId && <div className="scenario-parent mono">Branch of {selected.parentScenarioId.slice(0, 8)}</div>}
          <label>
            Scenario title
            <input value={editTitle} maxLength={200} onChange={(event) => onEditTitle(event.target.value)} />
          </label>
          <label>
            Background
            <textarea value={editBackground} maxLength={50_000} onChange={(event) => onEditBackground(event.target.value)} />
          </label>
          <div className="scenario-actions">
            <button className="btn primary sm" type="button" disabled={!canWrite || scenarioPending} onClick={onSaveDetails}>Save details</button>
            <button className="btn sm" type="button" onClick={onReloadDetails}>Reload shared</button>
          </div>
          <label>
            Workflow state
            <select value={selected.status} disabled={!canWrite || scenarioPending} onChange={(event) => onSetStatus(event.target.value as ScenarioStatus)}>
              <option value="draft">Draft</option>
              <option value="ready">Ready to test</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {scenarioPending && (
            <p className="scenario-identity-note" role="status">
              Scenario change saved; checking registered-device attribution…
            </p>
          )}
          {!scenarioPending && scenarioAttribution?.status === 'signed-device' && (
            <p className="scenario-identity-note" role="status">
              Scenario change saved with registered-device signature from key{' '}
              <span className="mono">
                {scenarioAttribution.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…
              </span>.
              This proves the exact retained edit was signed by that installation key, not a person
              or organization.
            </p>
          )}
          {!scenarioPending && scenarioAttribution?.status === 'unsigned' && (
            <p className="scenario-identity-note" role="status">
              Scenario change saved without a device signature: {scenarioAttribution.reason === 'device-directory-unhealthy'
                ? 'the project device directory needs attention.'
                : scenarioAttribution.reason === 'attestation-history-unhealthy'
                  ? 'signed attribution history needs attention.'
                  : 'this installation is not registered here or signing is unavailable.'}
            </p>
          )}

          {turnWorkspace}

          {generation}

          <div className="scenario-section-heading">
            <h3>Team vote</h3>
            <span className="mono">{voteSummary?.activeVotes.length ?? 0} active</span>
          </div>
          <div className="scenario-votes" aria-label="Vote on selected scenario">
            {voteChoices.map((choice) => (
              <button
                key={choice}
                className="btn sm"
                type="button"
                aria-pressed={currentVote === choice}
                disabled={!canWrite || votePending}
                onClick={() => onVote(choice)}
              >
                {choice[0].toUpperCase() + choice.slice(1)} {voteSummary?.counts[choice] ?? 0}
              </button>
            ))}
            {currentVote && (
              <button className="btn sm" type="button" disabled={!canWrite || votePending} onClick={() => onVote('withdrawn')}>Withdraw mine</button>
            )}
          </div>
          <p className="scenario-identity-note">
            Votes use this installation’s researcher name and local time; both are self-reported.
          </p>
          {votePending && (
            <p className="scenario-identity-note" role="status">
              Saving vote and checking registered-device attribution…
            </p>
          )}
          {!votePending && voteAttribution?.status === 'signed-device' && (
            <p className="scenario-identity-note" role="status">
              Vote saved with registered-device signature from key{' '}
              <span className="mono">
                {voteAttribution.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…
              </span>.
              This proves the exact retained event was signed by that installation key, not a person
              or organization.
            </p>
          )}
          {!votePending && voteAttribution?.status === 'unsigned' && (
            <p className="scenario-identity-note" role="status">
              Vote saved without a device signature: {voteAttribution.reason === 'device-directory-unhealthy'
                ? 'the project device directory needs attention.'
                : voteAttribution.reason === 'attestation-history-unhealthy'
                  ? 'signed attribution history needs attention.'
                  : 'this installation is not registered here or signing is unavailable.'}
            </p>
          )}
          {collaboration}
        </section>
      )}

      {packs}
      {reruns}
      {heuristics}
    </div>
  )
}

export function scenarioDetailsRevision(scenario: ResearchScenario): string {
  return scenario.edits.map((edit) => edit.editId).sort().join('.')
}

export function ScenarioWorkspace({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createBackground, setCreateBackground] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editBackground, setEditBackground] = useState('')
  const [editingHead, setEditingHead] = useState('')
  const [error, setError] = useState('')
  const [scenarioAttribution, setScenarioAttribution] = useState<ResearchEventAttributionResult | null>(null)
  const [scenarioPending, setScenarioPending] = useState(false)
  const [voteAttribution, setVoteAttribution] = useState<ResearchEventAttributionResult | null>(null)
  const [votePending, setVotePending] = useState(false)
  const scenarioOperation = useRef(0)
  const voteOperation = useRef(0)

  useEffect(() => {
    let active: Y.Doc | null = null
    const onUpdate = () => setRevision((value) => value + 1)
    const unsubscribe = subscribeAutomationProjectDocument(project.id, (next) => {
      active?.off('update', onUpdate)
      active = next
      setDoc(next)
      next?.on('update', onUpdate)
      setRevision((value) => value + 1)
    })
    return () => {
      active?.off('update', onUpdate)
      unsubscribe()
    }
  }, [project.id])

  const snapshot = useMemo(() => {
    if (!doc) return { scenarios: [] as ResearchScenario[], issues: [] as string[] }
    const { scenarios } = getProjectSharedTypes(doc)
    const graph = inspectScenarioGraph(scenarios)
    return { scenarios: listScenarios(scenarios), issues: graph.issues }
  }, [doc, revision])

  const selected = snapshot.scenarios.find((scenario) => scenario.id === selectedId) ?? snapshot.scenarios[0] ?? null
  const voteSummary = useMemo(() => {
    if (!doc || !selected) return null
    return readScenarioVotes(getProjectSharedTypes(doc).discussions, selected.id)
  }, [doc, revision, selected?.id])
  const currentVote = voteSummary?.activeVotes.find((vote) => vote.participantId === researcherId)?.choice ?? null

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
    if (!selected && selectedId !== null) setSelectedId(null)
  }, [selected, selectedId])

  const loadDetails = (scenario: ResearchScenario | null) => {
    setEditTitle(scenario?.title ?? '')
    setEditBackground(scenario?.background ?? '')
    setEditingHead(scenario ? scenarioDetailsRevision(scenario) : '')
    setError('')
  }

  useEffect(() => {
    scenarioOperation.current += 1
    setScenarioAttribution(null)
    setScenarioPending(false)
    return () => { scenarioOperation.current += 1 }
  }, [project.id])

  useEffect(() => {
    loadDetails(selected)
    voteOperation.current += 1
    setVoteAttribution(null)
    setVotePending(false)
    return () => { voteOperation.current += 1 }
  }, [project.id, selected?.id])

  const shared = () => {
    if (!doc) throw new Error('Shared scenario data is not ready')
    return getProjectSharedTypes(doc)
  }
  const writableShared = () => {
    const types = shared()
    const graph = inspectScenarioGraph(types.scenarios)
    if (!graph.healthy) throw new Error('Scenario data failed integrity checks; writes are disabled')
    return types
  }
  const identity = () => {
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before editing shared scenarios')
    return { authorId: researcherId, displayName: researcherName.trim() }
  }
  const currentScenario = () => {
    if (!selected) throw new Error('Select a scenario first')
    const current = readScenario(writableShared().scenarios, selected.id)
    if (!current) throw new Error('Scenario changed or is no longer available')
    return current
  }

  const selectScenario = (id: string) => {
    scenarioOperation.current += 1
    setScenarioAttribution(null)
    setScenarioPending(false)
    setSelectedId(id)
    loadDetails(snapshot.scenarios.find((scenario) => scenario.id === id) ?? null)
  }

  const commitScenarioMutation = async (
    scenarioId: string,
    editId: string,
    commit: () => ResearchScenario,
    onComplete: (scenario: ResearchScenario) => void,
  ) => {
    const operation = scenarioOperation.current + 1
    scenarioOperation.current = operation
    setError('')
    setScenarioAttribution(null)
    setScenarioPending(true)
    try {
      const document = doc
      if (!document) throw new Error('Shared scenario data is not ready')
      const result = await commitScenarioEditWithAttribution(
        document, project.id, scenarioId, editId, commit,
      )
      if (scenarioOperation.current === operation) {
        setScenarioAttribution(result.attribution)
        onComplete(result.scenario)
      }
    } catch (caught) {
      if (scenarioOperation.current === operation) {
        setError(caught instanceof Error ? caught.message : 'Scenario update failed')
      }
    } finally {
      if (scenarioOperation.current === operation) setScenarioPending(false)
    }
  }

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const scenarioId = uid()
    const editId = uid()
    await commitScenarioMutation(scenarioId, editId, () => {
      const author = identity()
      return createScenario(writableShared().scenarios, {
        id: scenarioId, title: createTitle.trim(), background: createBackground,
        authorId: author.authorId, timestamp: now(), editId,
      })
    }, (scenario) => {
      setCreateTitle('')
      setCreateBackground('')
      setCreateOpen(false)
      setSelectedId(scenario.id)
      loadDetails(scenario)
    })
  }

  const saveDetails = async () => {
    setError('')
    try {
      const author = identity()
      const current = currentScenario()
      if (scenarioDetailsRevision(current) !== editingHead) {
        throw new Error('This scenario changed while you were editing. Reload shared details before saving.')
      }
      const changes: { title?: string; background?: string } = {}
      if (editTitle.trim() !== current.title) changes.title = editTitle.trim()
      if (editBackground !== current.background) changes.background = editBackground
      if (Object.keys(changes).length === 0) return
      const editId = uid()
      await commitScenarioMutation(current.id, editId, () => updateScenario(writableShared().scenarios, {
        id: current.id, authorId: author.authorId, timestamp: now(), editId, changes,
      }), loadDetails)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario update failed')
    }
  }

  const setStatus = async (status: ScenarioStatus) => {
    setError('')
    try {
      const author = identity()
      const current = currentScenario()
      if (current.status === status) return
      const editId = uid()
      await commitScenarioMutation(current.id, editId, () => updateScenario(writableShared().scenarios, {
        id: current.id, authorId: author.authorId, timestamp: now(), editId, changes: { status },
      }), loadDetails)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario update failed')
    }
  }

  const vote = async (choice: ScenarioVoteChoice) => {
    const operation = voteOperation.current + 1
    voteOperation.current = operation
    setError('')
    setVoteAttribution(null)
    setVotePending(true)
    try {
      const author = identity()
      const current = currentScenario()
      const document = doc
      if (!document) throw new Error('Shared scenario data is not ready')
      const result = await castScenarioVoteWithAttribution(document, project.id, {
        eventId: uid(), scenarioId: current.id, participantId: author.authorId,
        displayName: author.displayName, choice, timestamp: now(),
      })
      if (voteOperation.current === operation) setVoteAttribution(result.attribution)
    } catch (caught) {
      if (voteOperation.current === operation) {
        setError(caught instanceof Error ? caught.message : 'Scenario vote failed')
      }
    } finally {
      if (voteOperation.current === operation) setVotePending(false)
    }
  }

  return (
    <ScenarioWorkspaceContent
      ready={Boolean(doc)} scenarios={snapshot.scenarios} selected={selected}
      voteSummary={voteSummary} currentVote={currentVote} integrityIssues={snapshot.issues}
      scenarioAttribution={scenarioAttribution} scenarioPending={scenarioPending}
      voteAttribution={voteAttribution} votePending={votePending}
      generation={doc && selected ? <ScenarioGenerator key={selected.id} project={project} doc={doc} scenario={selected} /> : undefined}
      collaboration={doc && selected ? <ScenarioCollaborationPanel
        key={selected.id} doc={doc} projectId={project.id} scenario={selected}
        writesDisabled={snapshot.issues.length > 0}
      /> : undefined}
      heuristics={doc ? <HeuristicWorkspace project={project} doc={doc} /> : undefined}
      reruns={doc ? <ScenarioRerunQueuePanel project={project} doc={doc} /> : undefined}
      packs={<ScenarioPackControls project={project} doc={doc} scenarios={snapshot.scenarios} selected={selected} integrityIssues={snapshot.issues} />}
      turnWorkspace={doc && selected ? <ScenarioTurnWorkspace
        key={selected.id}
        doc={doc}
        projectId={project.id}
        scenario={selected}
        parentWritesDisabled={snapshot.issues.length > 0}
      /> : undefined}
      createOpen={createOpen} createTitle={createTitle} createBackground={createBackground}
      editTitle={editTitle} editBackground={editBackground}
      error={error} onSelect={selectScenario} onOpenCreate={() => { setCreateOpen(true); setError('') }}
      onCancelCreate={() => setCreateOpen(false)} onCreateTitle={setCreateTitle}
      onCreateBackground={setCreateBackground} onCreate={create} onEditTitle={setEditTitle}
      onEditBackground={setEditBackground} onSaveDetails={saveDetails}
      onReloadDetails={() => loadDetails(selected)} onSetStatus={setStatus}
      onVote={vote}
    />
  )
}
