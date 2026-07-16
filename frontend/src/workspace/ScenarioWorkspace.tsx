import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type * as Y from 'yjs'
import { now, uid } from '../util'
import { useStore } from '../store'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import {
  addScenarioTurn,
  createScenario,
  inspectScenarioGraph,
  listScenarios,
  readScenario,
  updateScenario,
  type ResearchScenario,
  type ScenarioStatus,
  type ScenarioTurnRole,
} from './scenarioModel'
import {
  castScenarioVote,
  readScenarioVotes,
  type ScenarioVoteChoice,
  type ScenarioVoteSummary,
} from './scenarioVoteModel'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

interface ScenarioWorkspaceContentProps {
  ready: boolean
  scenarios: ResearchScenario[]
  selected: ResearchScenario | null
  voteSummary: ScenarioVoteSummary | null
  currentVote: ScenarioVoteChoice | null
  integrityIssues: string[]
  createOpen: boolean
  createTitle: string
  createBackground: string
  editTitle: string
  editBackground: string
  turnRole: ScenarioTurnRole
  turnContent: string
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
  onTurnRole: (role: ScenarioTurnRole) => void
  onTurnContent: (value: string) => void
  onAddTurn: (event: FormEvent<HTMLFormElement>) => void
  onVote: (choice: ScenarioVoteChoice) => void
}

const voteChoices: Array<Exclude<ScenarioVoteChoice, 'withdrawn'>> = ['support', 'oppose', 'abstain']

export function ScenarioWorkspaceContent({
  ready,
  scenarios,
  selected,
  voteSummary,
  currentVote,
  integrityIssues,
  createOpen,
  createTitle,
  createBackground,
  editTitle,
  editBackground,
  turnRole,
  turnContent,
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
  onTurnRole,
  onTurnContent,
  onAddTurn,
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
        <button className="btn sm" type="button" disabled={!canWrite} onClick={onOpenCreate}>New</button>
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
            <button className="btn primary sm" type="submit" disabled={!canWrite}>Create scenario</button>
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
            <button className="btn primary sm" type="button" disabled={!canWrite} onClick={onSaveDetails}>Save details</button>
            <button className="btn sm" type="button" onClick={onReloadDetails}>Reload shared</button>
          </div>
          <label>
            Workflow state
            <select value={selected.status} disabled={!canWrite} onChange={(event) => onSetStatus(event.target.value as ScenarioStatus)}>
              <option value="draft">Draft</option>
              <option value="ready">Ready to test</option>
              <option value="archived">Archived</option>
            </select>
          </label>

          <div className="scenario-section-heading">
            <h3>Conversation turns</h3>
            <span className="mono">{selected.turns.length}</span>
          </div>
          {selected.turns.length === 0 && <p className="scenario-state">No turns yet.</p>}
          <ol className="scenario-turns">
            {selected.turns.map((turn) => (
              <li key={turn.id}>
                <div className="scenario-turn-meta mono">{turn.role} · {turn.revisions.length} revision{turn.revisions.length === 1 ? '' : 's'}</div>
                <div className="scenario-turn-content">{turn.content || <em>Empty turn</em>}</div>
              </li>
            ))}
          </ol>
          <form className="scenario-form compact" aria-label="Add scenario turn" onSubmit={onAddTurn}>
            <label>
              Role
              <select value={turnRole} onChange={(event) => onTurnRole(event.target.value as ScenarioTurnRole)}>
                <option value="system">System</option>
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
              </select>
            </label>
            <label>
              Turn content
              <textarea value={turnContent} maxLength={200_000} required onChange={(event) => onTurnContent(event.target.value)} />
            </label>
            <button className="btn sm" type="submit" disabled={!canWrite}>Add turn</button>
          </form>

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
                disabled={!canWrite}
                onClick={() => onVote(choice)}
              >
                {choice[0].toUpperCase() + choice.slice(1)} {voteSummary?.counts[choice] ?? 0}
              </button>
            ))}
            {currentVote && (
              <button className="btn sm" type="button" disabled={!canWrite} onClick={() => onVote('withdrawn')}>Withdraw mine</button>
            )}
          </div>
          <p className="scenario-identity-note">Votes use this installation’s researcher identity; identity is not authenticated.</p>
        </section>
      )}
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
  const [turnRole, setTurnRole] = useState<ScenarioTurnRole>('user')
  const [turnContent, setTurnContent] = useState('')
  const [error, setError] = useState('')

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
    loadDetails(selected)
  }, [selected?.id])

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
  const mutate = (operation: () => void) => {
    setError('')
    try { operation() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Scenario update failed') }
  }
  const currentScenario = () => {
    if (!selected) throw new Error('Select a scenario first')
    const current = readScenario(writableShared().scenarios, selected.id)
    if (!current) throw new Error('Scenario changed or is no longer available')
    return current
  }

  const selectScenario = (id: string) => {
    setSelectedId(id)
    loadDetails(snapshot.scenarios.find((scenario) => scenario.id === id) ?? null)
  }

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      const author = identity()
      const scenario = createScenario(writableShared().scenarios, {
        id: uid(), title: createTitle.trim(), background: createBackground,
        authorId: author.authorId, timestamp: now(), editId: uid(),
      })
      setCreateTitle('')
      setCreateBackground('')
      setCreateOpen(false)
      setSelectedId(scenario.id)
      loadDetails(scenario)
    })
  }

  const saveDetails = () => mutate(() => {
    const author = identity()
    const current = currentScenario()
    if (scenarioDetailsRevision(current) !== editingHead) {
      throw new Error('This scenario changed while you were editing. Reload shared details before saving.')
    }
    const changes: { title?: string; background?: string } = {}
    if (editTitle.trim() !== current.title) changes.title = editTitle.trim()
    if (editBackground !== current.background) changes.background = editBackground
    if (Object.keys(changes).length === 0) return
    const updated = updateScenario(writableShared().scenarios, {
      id: current.id, authorId: author.authorId, timestamp: now(), editId: uid(), changes,
    })
    loadDetails(updated)
  })

  const setStatus = (status: ScenarioStatus) => mutate(() => {
    const author = identity()
    const current = currentScenario()
    if (current.status === status) return
    const updated = updateScenario(writableShared().scenarios, {
      id: current.id, authorId: author.authorId, timestamp: now(), editId: uid(), changes: { status },
    })
    loadDetails(updated)
  })

  const addTurn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      const author = identity()
      const current = currentScenario()
      if (!turnContent.trim()) throw new Error('Turn content is required')
      addScenarioTurn(writableShared().scenarios, {
        scenarioId: current.id, turnId: uid(), role: turnRole, content: turnContent,
        authorId: author.authorId, timestamp: now(), editId: uid(),
      })
      setTurnContent('')
    })
  }

  const vote = (choice: ScenarioVoteChoice) => mutate(() => {
    const author = identity()
    const current = currentScenario()
    const types = writableShared()
    castScenarioVote(types.discussions, types.scenarios, {
      eventId: uid(), scenarioId: current.id, participantId: author.authorId,
      displayName: author.displayName, choice, timestamp: now(),
    })
  })

  return (
    <ScenarioWorkspaceContent
      ready={Boolean(doc)} scenarios={snapshot.scenarios} selected={selected}
      voteSummary={voteSummary} currentVote={currentVote} integrityIssues={snapshot.issues}
      createOpen={createOpen} createTitle={createTitle} createBackground={createBackground}
      editTitle={editTitle} editBackground={editBackground} turnRole={turnRole} turnContent={turnContent}
      error={error} onSelect={selectScenario} onOpenCreate={() => { setCreateOpen(true); setError('') }}
      onCancelCreate={() => setCreateOpen(false)} onCreateTitle={setCreateTitle}
      onCreateBackground={setCreateBackground} onCreate={create} onEditTitle={setEditTitle}
      onEditBackground={setEditBackground} onSaveDetails={saveDetails}
      onReloadDetails={() => loadDetails(selected)} onSetStatus={setStatus}
      onTurnRole={setTurnRole} onTurnContent={setTurnContent} onAddTurn={addTurn} onVote={vote}
    />
  )
}