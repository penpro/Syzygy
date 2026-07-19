import { useState, type FormEvent } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { now, uid } from '../util'
import { createHeuristic, listHeuristics, type HeuristicPriority } from './heuristicsModel'
import {
  createHeuristicExample,
  listActiveHeuristicExamples,
  removeHeuristicExample,
  type HeuristicExampleHistory,
  type HeuristicExamplePolarity,
} from './heuristicExampleModel'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import { HeuristicChecker } from './HeuristicChecker'

export interface HeuristicWorkspaceContentProps {
  ready: boolean
  heuristics: ReturnType<typeof listHeuristics>
  selectedId: string | null
  examples: HeuristicExampleHistory[]
  title: string
  guidance: string
  priority: HeuristicPriority
  polarity: HeuristicExamplePolarity
  exampleBody: string
  error: string
  onSelect: (id: string) => void
  onTitle: (value: string) => void
  onGuidance: (value: string) => void
  onPriority: (value: HeuristicPriority) => void
  onCreateHeuristic: (event: FormEvent<HTMLFormElement>) => void
  onPolarity: (value: HeuristicExamplePolarity) => void
  onExampleBody: (value: string) => void
  onAddExample: (event: FormEvent<HTMLFormElement>) => void
  onRemoveExample: (example: HeuristicExampleHistory) => void
}

export function HeuristicWorkspaceContent(props: HeuristicWorkspaceContentProps) {
  const selected = props.heuristics.find(({ id }) => id === props.selectedId) ?? null
  return (
    <section className="heuristic-workspace" aria-label="Research heuristics and examples">
      <div className="scenario-heading">
        <div>
          <div className="workspace-panel-label mono">Heuristics</div>
          <h2>Shared evaluation examples</h2>
        </div>
      </div>
      <p className="scenario-state">Project rules and examples work without AI. They sync with the collaboration document.</p>
      {!props.ready && <p className="scenario-state" role="status">Preparing shared heuristics…</p>}
      {props.error && <div className="scenario-state error" role="alert">{props.error}</div>}
      <form className="scenario-form compact" aria-label="Create heuristic" onSubmit={props.onCreateHeuristic}>
        <label>Title<input required maxLength={200} value={props.title} onChange={(event) => props.onTitle(event.target.value)} /></label>
        <label>Guidance<textarea required maxLength={10_000} value={props.guidance} onChange={(event) => props.onGuidance(event.target.value)} /></label>
        <label>Priority<select value={props.priority} onChange={(event) => props.onPriority(event.target.value as HeuristicPriority)}>
          <option value="required">Required</option><option value="recommended">Recommended</option><option value="watch">Watch</option>
        </select></label>
        <button className="btn sm" type="submit" disabled={!props.ready}>Add heuristic</button>
      </form>
      {props.heuristics.length > 0 && <nav className="scenario-list" aria-label="Project heuristics">
        {props.heuristics.map((heuristic) => <button key={heuristic.id} className={heuristic.id === props.selectedId ? 'scenario-list-item active' : 'scenario-list-item'} type="button" onClick={() => props.onSelect(heuristic.id)}>
          <span>{heuristic.title}</span><small className="mono">{heuristic.priority}</small>
        </button>)}
      </nav>}
      {selected && <>
        <p className="scenario-state">{selected.guidance}</p>
        <form className="scenario-form compact" aria-label="Add heuristic example" onSubmit={props.onAddExample}>
          <label>Example type<select value={props.polarity} onChange={(event) => props.onPolarity(event.target.value as HeuristicExamplePolarity)}>
            <option value="positive">Positive · follows the heuristic</option>
            <option value="negative">Negative · violates the heuristic</option>
          </select></label>
          <label>Example<textarea required maxLength={100_000} value={props.exampleBody} onChange={(event) => props.onExampleBody(event.target.value)} /></label>
          <button className="btn sm" type="submit">Add shared example</button>
        </form>
        {props.examples.length === 0 && <p className="scenario-state">No examples yet.</p>}
        <ol className="heuristic-examples" aria-label="Active heuristic examples">
          {props.examples.map((example) => <li key={example.id}>
            <div><span className={`heuristic-example-polarity ${example.polarity}`}>{example.polarity}</span><span className="mono">{example.createdByDisplayName}</span></div>
            <p>{example.body}</p>
            <button className="btn ghost danger sm" type="button" onClick={() => props.onRemoveExample(example)}>Remove</button>
          </li>)}
        </ol>
      </>}
      <p className="scenario-identity-note">Attribution uses this installation’s researcher identity; identity is not authenticated.</p>
    </section>
  )
}

export function HeuristicWorkspace({ project, doc }: { project: ResearchProjectManifest; doc: Y.Doc }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [guidance, setGuidance] = useState('')
  const [priority, setPriority] = useState<HeuristicPriority>('recommended')
  const [polarity, setPolarity] = useState<HeuristicExamplePolarity>('positive')
  const [exampleBody, setExampleBody] = useState('')
  const [error, setError] = useState('')
  const { discussions, heuristics: heuristicMap } = getProjectSharedTypes(doc)
  const heuristics = listHeuristics(heuristicMap)
  const selected = heuristics.find(({ id }) => id === selectedId) ?? heuristics[0] ?? null
  const examples = selected ? listActiveHeuristicExamples(discussions, selected.id) : []
  const identity = () => {
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before editing shared heuristics')
    return { participantId: researcherId, displayName: researcherName.trim() }
  }
  const mutate = (operation: () => void) => {
    setError('')
    try { operation() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Heuristic update failed') }
  }
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      const author = identity()
      const id = `heuristic-${uid()}`
      createHeuristic(heuristicMap, {
        id, title: title.trim(), guidance, priority, authorId: author.participantId,
        timestamp: now(), editId: `heuristic-edit-${uid()}`,
      })
      setSelectedId(id); setTitle(''); setGuidance('')
    })
  }
  const addExample = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    mutate(() => {
      if (!selected) throw new Error('Select a heuristic first')
      const author = identity()
      createHeuristicExample(discussions, heuristicMap, {
        eventId: `example-event-${uid()}`, exampleId: `example-${uid()}`, heuristicId: selected.id,
        polarity, body: exampleBody, participantId: author.participantId,
        displayName: author.displayName, timestamp: now(),
      })
      setExampleBody('')
    })
  }
  const remove = (example: HeuristicExampleHistory) => mutate(() => {
    const author = identity()
    removeHeuristicExample(discussions, heuristicMap, {
      eventId: `example-remove-${uid()}`, exampleId: example.id, heuristicId: example.heuristicId,
      expectedCurrentEventId: example.currentEventId, participantId: author.participantId,
      displayName: author.displayName, timestamp: now(),
    })
  })
  return <>
    <HeuristicWorkspaceContent
      ready heuristics={heuristics} selectedId={selected?.id ?? null} examples={examples}
      title={title} guidance={guidance} priority={priority} polarity={polarity} exampleBody={exampleBody}
      error={error} onSelect={setSelectedId} onTitle={setTitle} onGuidance={setGuidance}
      onPriority={setPriority} onCreateHeuristic={create} onPolarity={setPolarity}
      onExampleBody={setExampleBody} onAddExample={addExample} onRemoveExample={remove}
    />
    {selected && <HeuristicChecker key={selected.id} project={project} doc={doc} heuristic={selected} />}
  </>
}
