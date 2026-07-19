import { useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { desktopRuntimeAvailable, providerCredentialStatus, type RemoteProviderId } from '../tauri'
import { now, uid } from '../util'
import { getAutomationEditorController } from './editorAutomationRegistry'
import {
  buildHeuristicCheckRequest,
  runHeuristicCheck,
  type HeuristicCheckAdapter,
  type HeuristicCheckProviderId,
} from './heuristicCheck'
import {
  commitHeuristicCheckResult,
  inspectHeuristicCheckResults,
  listHeuristicCheckResults,
  type HeuristicCheckResult,
} from './heuristicCheckResultModel'
import {
  createLocalHeuristicCheckAdapter,
  createRemoteHeuristicCheckAdapter,
  HEURISTIC_CHECK_REMOTE_PROVIDERS,
} from './heuristicCheckRuntime'
import { readHeuristicExampleHistories } from './heuristicExampleModel'
import { readHeuristic, type ResearchHeuristic } from './heuristicsModel'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchProjectManifest } from './schema'

type CheckPhase = 'idle' | 'checking' | 'running' | 'cancelling' | 'complete' | 'error'

export interface HeuristicCheckerContentProps {
  provider: HeuristicCheckProviderId
  model: string
  localAvailable: boolean
  phase: CheckPhase
  message: string
  results: HeuristicCheckResult[]
  onProvider: (provider: HeuristicCheckProviderId) => void
  onModel: (model: string) => void
  onRun: () => void
  onCancel: () => void
}

export function HeuristicCheckerContent(props: HeuristicCheckerContentProps) {
  const busy = ['checking', 'running', 'cancelling'].includes(props.phase)
  return (
    <section className="scenario-generator" aria-label="Check policy against selected heuristic">
      <div className="scenario-section-heading">
        <h3>Explainable policy check</h3>
        <span className="mono">{props.results.length} result{props.results.length === 1 ? '' : 's'}</span>
      </div>
      <p className="scenario-generation-intro">
        Check the current policy snapshot against this rule. Results retain rationale, uncertainty,
        exact cited spans, researcher attribution, and model provenance in the shared project.
      </p>
      <label>
        Model provider
        <select value={props.provider} disabled={busy} onChange={(event) => props.onProvider(event.target.value as HeuristicCheckProviderId)}>
          <option value="local">Local model · this computer</option>
          {HEURISTIC_CHECK_REMOTE_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} API · Send once approval</option>)}
        </select>
      </label>
      <label>
        Model ID
        <input value={props.model} disabled={busy} spellCheck={false} maxLength={200} onChange={(event) => props.onModel(event.target.value)} />
      </label>
      {props.provider === 'local' && !props.localAvailable && (
        <p className="scenario-generation-note" role="status">
          Local AI is off or no text model is loaded. Shared heuristics and examples still work; turn local AI on or choose an API provider when you want a check.
        </p>
      )}
      {props.provider !== 'local' && (
        <p className="scenario-generation-note">
          Only the selected heuristic, its active examples, and the current policy snapshot are prepared. The native dialog must approve each API send.
        </p>
      )}
      <div className="scenario-actions">
        <button className="btn sm" type="button" disabled={busy || !props.model.trim() || (props.provider === 'local' && !props.localAvailable)} onClick={props.onRun}>
          {props.results.length ? 'Run again' : 'Run check'}
        </button>
        {busy && <button className="btn ghost danger sm" type="button" onClick={props.onCancel}>Cancel</button>}
      </div>
      <div className={`scenario-generation-status ${props.phase}`} role="status">{props.message}</div>
      {props.results.length > 0 && (
        <ol className="scenario-responses" aria-label="Shared heuristic check results">
          {[...props.results].reverse().map((result) => (
            <li key={result.resultId}>
              <div className="scenario-turn-meta mono">
                {result.verdict.toUpperCase()} · {result.providerId} · {result.executedModelId} · {result.authorDisplayName}
              </div>
              <p><strong>Rationale:</strong> {result.rationale}</p>
              <p><strong>Uncertainty:</strong> {result.uncertainty}</p>
              <details className="scenario-response-lineage">
                <summary>Verified citations · {result.citations.length}</summary>
                <ol>
                  {result.citations.map((citation, index) => (
                    <li key={`${result.resultId}-${citation.start}-${citation.end}-${index}`}>
                      <div className="scenario-turn-meta mono">Policy offsets {citation.start}–{citation.end}</div>
                      <blockquote>{citation.quote}</blockquote>
                    </li>
                  ))}
                </ol>
              </details>
              <div className="scenario-turn-meta mono">run {result.runId} · source {result.sourceRevision}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function HeuristicChecker({
  project,
  doc,
  heuristic,
}: {
  project: ResearchProjectManifest
  doc: Y.Doc
  heuristic: ResearchHeuristic
}) {
  const settings = useStore((state) => state.settings)
  const loadedModel = useStore((state) => state.loadedModel)
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [provider, setProvider] = useState<HeuristicCheckProviderId>('local')
  const [model, setModel] = useState(settings.model)
  const [phase, setPhase] = useState<CheckPhase>('idle')
  const [message, setMessage] = useState('Run a check when you want an evidence-linked assessment of the current policy.')
  const active = useRef<{ runId: string; controller: AbortController; adapter: HeuristicCheckAdapter } | null>(null)
  const results = listHeuristicCheckResults(getProjectSharedTypes(doc).discussions, heuristic.id)
  const localAvailable = settings.localAiEnabled && Boolean(loadedModel)

  const chooseProvider = (next: HeuristicCheckProviderId) => {
    setProvider(next)
    setModel(next === 'local' ? settings.model : HEURISTIC_CHECK_REMOTE_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
    setPhase('idle')
    setMessage(next === 'local'
      ? 'The check runs on this computer.'
      : 'The native Send once dialog appears before the bounded snapshots leave this computer.')
  }

  const run = async () => {
    const runId = `heuristic-check-${uid()}`
    const controller = new AbortController()
    const adapter = provider === 'local'
      ? createLocalHeuristicCheckAdapter(settings)
      : createRemoteHeuristicCheckAdapter(provider as RemoteProviderId)
    active.current = { runId, controller, adapter }
    setPhase(provider === 'local' ? 'running' : 'checking')
    setMessage(provider === 'local' ? 'Checking locally…' : 'Checking the provider key…')
    try {
      if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before saving a shared check result')
      const shared = getProjectSharedTypes(doc)
      const resultInspection = inspectHeuristicCheckResults(shared.discussions, shared.heuristics)
      if (!resultInspection.healthy) throw new Error(`Heuristic check history failed integrity checks: ${resultInspection.issues.join('; ')}`)
      const currentHeuristic = readHeuristic(shared.heuristics, heuristic.id)
      if (!currentHeuristic) throw new Error('Selected heuristic changed or failed validation')
      const histories = readHeuristicExampleHistories(shared.discussions, heuristic.id)
      if (histories === null) throw new Error('Heuristic example history failed integrity checks')
      const editor = getAutomationEditorController(project.id)
      const request = buildHeuristicCheckRequest({
        runId,
        providerId: provider,
        requestedModelId: model.trim(),
        project,
        heuristic: currentHeuristic,
        examples: histories.filter(({ status }) => status === 'active'),
        blocks: editor.read().blocks,
      })
      if (provider !== 'local') {
        if (!desktopRuntimeAvailable()) throw new Error('API checks are available in the installed app')
        if (!await providerCredentialStatus(provider as RemoteProviderId)) {
          const name = HEURISTIC_CHECK_REMOTE_PROVIDERS.find(({ id }) => id === provider)?.name ?? provider
          throw new Error(`Add a ${name} key in Settings first`)
        }
        setPhase('running')
        setMessage('Native approval or the provider response is pending. Content leaves only after Send once.')
      }
      const output = await runHeuristicCheck(adapter, request, controller.signal)
      commitHeuristicCheckResult(doc, request, output, {
        resultId: `heuristic-result-${uid()}`,
        authorId: researcherId,
        authorDisplayName: researcherName.trim(),
        timestamp: now(),
        currentBlocks: editor.read().blocks,
      })
      setPhase('complete')
      setMessage('Shared result saved with verified policy spans, uncertainty, and provider provenance.')
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setPhase('idle')
        setMessage('Heuristic check cancelled; no result was added.')
      } else {
        setPhase('error')
        setMessage(error instanceof Error ? error.message : 'Heuristic check failed')
      }
    } finally {
      active.current = null
    }
  }

  const cancel = async () => {
    const current = active.current
    if (!current) return
    setPhase('cancelling')
    setMessage('Cancelling check…')
    current.controller.abort()
    try { await current.adapter.cancel?.(current.runId) } catch { /* cancellation remains best-effort */ }
  }

  return <HeuristicCheckerContent
    provider={provider} model={model} localAvailable={localAvailable} phase={phase} message={message}
    results={results} onProvider={chooseProvider} onModel={setModel} onRun={() => void run()}
    onCancel={() => void cancel()}
  />
}
