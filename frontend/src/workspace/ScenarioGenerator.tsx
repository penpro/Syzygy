import { useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { desktopRuntimeAvailable, providerCredentialStatus, type RemoteProviderId } from '../tauri'
import { now, uid } from '../util'
import { getProjectSharedTypes } from './projectModel'
import type { ResearchScenario } from './scenarioModel'
import { readScenarioResponses, type ScenarioResponse } from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'
import {
  buildScenarioGenerationRequest,
  commitScenarioGeneration,
  runScenarioGeneration,
  type ScenarioGenerationProviderId,
} from './scenarioGeneration'
import {
  createLocalScenarioGenerationAdapter,
  createRemoteScenarioGenerationAdapter,
  SCENARIO_REMOTE_PROVIDERS,
} from './scenarioGenerationRuntime'

type GenerationPhase = 'idle' | 'checking' | 'running' | 'cancelling' | 'complete' | 'error'

export interface ScenarioGeneratorContentProps {
  provider: ScenarioGenerationProviderId
  model: string
  instructions: string
  localAvailable: boolean
  phase: GenerationPhase
  message: string
  responses: ScenarioResponse[]
  onProvider: (provider: ScenarioGenerationProviderId) => void
  onModel: (model: string) => void
  onInstructions: (instructions: string) => void
  onGenerate: () => void
  onCancel: () => void
}

export function ScenarioGeneratorContent(props: ScenarioGeneratorContentProps) {
  const busy = ['checking', 'running', 'cancelling'].includes(props.phase)
  return (
    <section className="scenario-generator" aria-label="Generate scenario response">
      <div className="scenario-section-heading">
        <h3>Response variants</h3>
        <span className="mono">{props.responses.length}</span>
      </div>
      <p className="scenario-generation-intro">
        Generate an attributed variant from this scenario only. Nothing is applied to the policy draft.
      </p>
      <label>
        Model provider
        <select value={props.provider} disabled={busy} onChange={(event) => props.onProvider(event.target.value as ScenarioGenerationProviderId)}>
          <option value="local">Local model · this computer</option>
          {SCENARIO_REMOTE_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} API · Send once approval</option>)}
        </select>
      </label>
      <label>
        Model ID
        <input value={props.model} disabled={busy} spellCheck={false} maxLength={200} onChange={(event) => props.onModel(event.target.value)} />
      </label>
      <label>
        Direction
        <textarea value={props.instructions} disabled={busy} maxLength={20_000} rows={4} onChange={(event) => props.onInstructions(event.target.value)} />
      </label>
      {props.provider === 'local' && !props.localAvailable && (
        <p className="scenario-generation-note" role="status">
          Local AI is off or no text model is loaded. Manual scenario work still functions; turn local AI on or choose an API provider.
        </p>
      )}
      <div className="scenario-actions">
        <button className="btn sm" type="button" disabled={busy || !props.model.trim() || (props.provider === 'local' && !props.localAvailable)} onClick={props.onGenerate}>
          Generate variant
        </button>
        {busy && <button className="btn ghost danger sm" type="button" onClick={props.onCancel}>Cancel</button>}
      </div>
      <div className={`scenario-generation-status ${props.phase}`} role="status">{props.message}</div>
      {props.responses.length > 0 && (
        <ol className="scenario-responses" aria-label="Scenario response variants">
          {props.responses.map((response) => {
            const current = response.revisions.find(({ revisionId }) => revisionId === response.currentRevisionId)
            return (
              <li key={response.id}>
                <div className="scenario-turn-meta mono">
                  {current?.sourceKind === 'model' ? `${current.providerId} · ${current.modelId}` : current?.authorDisplayName}
                  {' · '}{response.revisions.length} revision{response.revisions.length === 1 ? '' : 's'}
                </div>
                <div className="scenario-turn-content">{response.content}</div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export function ScenarioGenerator({
  project,
  doc,
  scenario,
}: {
  project: ResearchProjectManifest
  doc: Y.Doc
  scenario: ResearchScenario
}) {
  const settings = useStore((state) => state.settings)
  const loadedModel = useStore((state) => state.loadedModel)
  const [provider, setProvider] = useState<ScenarioGenerationProviderId>('local')
  const [model, setModel] = useState(settings.model)
  const [instructions, setInstructions] = useState('Continue with the most realistic next participant response and surface any important uncertainty.')
  const [phase, setPhase] = useState<GenerationPhase>('idle')
  const [message, setMessage] = useState('Choose a provider when you want a generated variant.')
  const active = useRef<{ runId: string; controller: AbortController; adapter: ReturnType<typeof createLocalScenarioGenerationAdapter> } | null>(null)
  const responses = useMemo(() => readScenarioResponses(
    getProjectSharedTypes(doc).discussions, scenario.id,
  ) ?? [], [doc, scenario])
  const localAvailable = settings.localAiEnabled && Boolean(loadedModel)

  const chooseProvider = (next: ScenarioGenerationProviderId) => {
    setProvider(next)
    setModel(next === 'local' ? settings.model : SCENARIO_REMOTE_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
    setPhase('idle')
    setMessage(next === 'local'
      ? 'Local generation stays on this computer.'
      : 'The native Send once dialog appears before any scenario content leaves this computer.')
  }

  const generate = async () => {
    const runId = `scenario-run-${uid()}`
    const controller = new AbortController()
    const adapter = provider === 'local'
      ? createLocalScenarioGenerationAdapter(settings)
      : createRemoteScenarioGenerationAdapter(provider as RemoteProviderId)
    active.current = { runId, controller, adapter }
    setPhase(provider === 'local' ? 'running' : 'checking')
    setMessage(provider === 'local' ? 'Generating locally…' : 'Checking the provider key…')
    try {
      if (provider !== 'local') {
        if (!desktopRuntimeAvailable()) throw new Error('API generation is available in the installed app')
        if (!await providerCredentialStatus(provider as RemoteProviderId)) {
          const name = SCENARIO_REMOTE_PROVIDERS.find(({ id }) => id === provider)?.name ?? provider
          throw new Error(`Add a ${name} key in Settings first`)
        }
        setPhase('running')
        setMessage('Native approval or the provider response is pending. Content leaves only after Send once.')
      }
      const request = buildScenarioGenerationRequest({ runId, providerId: provider, requestedModelId: model.trim(), project, scenario, instructions })
      const output = await runScenarioGeneration(adapter, request, controller.signal)
      commitScenarioGeneration(doc, request, output, {
        responseId: `scenario-response-${uid()}`,
        revisionId: `scenario-revision-${uid()}`,
        authorId: `model-${provider}`,
        authorDisplayName: provider === 'local' ? 'Local model' : `${SCENARIO_REMOTE_PROVIDERS.find(({ id }) => id === provider)?.name} model`,
        timestamp: now(),
      })
      setPhase('complete')
      setMessage('Variant added to the shared scenario with provider, model, and run provenance.')
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setPhase('idle')
        setMessage('Scenario generation cancelled; nothing was added.')
      } else {
        setPhase('error')
        setMessage(error instanceof Error ? error.message : 'Scenario generation failed')
      }
    } finally {
      active.current = null
    }
  }

  const cancel = async () => {
    const current = active.current
    if (!current) return
    setPhase('cancelling')
    setMessage('Cancelling generation…')
    current.controller.abort()
    try { await current.adapter.cancel?.(current.runId) } catch { /* cancellation stays best-effort */ }
  }

  return <ScenarioGeneratorContent
    provider={provider} model={model} instructions={instructions} localAvailable={localAvailable}
    phase={phase} message={message} responses={responses} onProvider={chooseProvider}
    onModel={setModel} onInstructions={setInstructions} onGenerate={() => void generate()} onCancel={() => void cancel()}
  />
}
