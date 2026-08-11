import { useState } from 'react'
import {
  desktopRuntimeAvailable,
  providerCancel,
  providerCredentialStatus,
  providerGenerate,
  providerGenerateStream,
  type ProviderTaskOutcome,
  type ProviderToolDefinition,
  type ProviderToolProposalValidation,
  type RemoteProviderId,
} from '../tauri'
import {
  applyProviderStreamEvent,
  initialProviderStreamState,
  type ProviderStreamState,
} from '../providerStream'
import { validateProviderToolProposal } from '../providerToolValidation'
import { getAutomationEditorController } from './editorAutomationRegistry'
import type { ResearchProjectManifest } from './schema'
import { buildRemoteReviewRequest, parseProviderToolDefinitions, REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'

const DEFAULT_QUESTION = 'Identify the three most consequential unsupported assumptions or failure modes in this draft. Cite the relevant supplied passage and distinguish evidence from inference.'

type ReviewPhase = 'idle' | 'preparing' | 'running' | 'cancelling' | 'complete' | 'error'

export type RemoteResearchReviewResultProps = {
  provider: RemoteProviderId
  model: string
  outcome: ProviderTaskOutcome | null
  streamState: ProviderStreamState | null
  toolDefinitions?: ProviderToolDefinition[]
}

export function providerUsesNativeStreaming(provider: RemoteProviderId): boolean {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini' || provider === 'xai'
}

function validationLabel(validation: ProviderToolProposalValidation): string {
  switch (validation.schemaStatus) {
    case 'pending': return 'Schema check pending · domain unreviewed · not executable'
    case 'valid': return 'Schema matches · domain unreviewed · not executable'
    case 'invalid': return 'Schema mismatch · domain unreviewed · not executable'
    case 'missing-definition': return 'Definition missing · domain unreviewed · not executable'
  }
}

export function RemoteResearchReviewResult({ provider, model, outcome, streamState, toolDefinitions = [] }: RemoteResearchReviewResultProps) {
  const response = outcome?.response
  const text = response?.text ?? streamState?.text ?? ''
  const toolProposals = response?.toolProposals ?? streamState?.toolCalls ?? []
  if (!text && !toolProposals.length) return null
  const tokens = response?.usage?.totalTokens ?? streamState?.usage?.totalTokens
  return (
    <div className="remote-review-result" aria-live="polite">
      <div className="remote-review-result-meta mono">
        {response?.provider ?? provider} · {response?.model ?? model} · {tokens ?? (response ? 'usage unknown' : 'streaming')}{typeof tokens === 'number' ? ' tokens' : ''}
      </div>
      {text ? <div className="remote-review-result-text">{text}</div> : null}
      {toolProposals.length ? (
        <div className="remote-review-tool-proposals">
          <div className="remote-review-tool-heading">Tool proposals · inspect only · not executed</div>
          {toolProposals.map((proposal) => {
            const validation = 'validation' in proposal
              ? proposal.validation
              : validateProviderToolProposal(toolDefinitions, proposal)
            return (
              <div className="remote-review-tool-proposal" key={proposal.callId}>
                <div className="mono">{proposal.name} · {proposal.callId}</div>
                <div className={`remote-review-tool-validation ${validation.schemaStatus}`}>
                  {validationLabel(validation)}
                </div>
                {validation.errors.length ? (
                  <div className="remote-review-tool-errors mono">Schema issues: {validation.errors.join(', ')}</div>
                ) : null}
                <pre>{proposal.arguments ? JSON.stringify(proposal.arguments, null, 2) : ('argumentsText' in proposal ? proposal.argumentsText : '')}</pre>
              </div>
            )
          })}
        </div>
      ) : null}
      {streamState?.warnings.length ? <div className="remote-review-retention mono">Provider notices: {streamState.warnings.join(', ')}</div> : null}
      {outcome?.zeroDataRetention !== null && outcome?.zeroDataRetention !== undefined && <div className="remote-review-retention mono">Provider reported zero data retention: {outcome.zeroDataRetention ? 'yes' : 'no'}</div>}
      <div className="remote-review-retention mono">Transient review · never applied to the shared draft automatically</div>
    </div>
  )
}

export function RemoteResearchReview({ project }: { project: ResearchProjectManifest }) {
  const [provider, setProvider] = useState<RemoteProviderId>('openai')
  const [model, setModel] = useState(REMOTE_REVIEW_PROVIDERS[0].defaultModel)
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [toolDefinitionsJson, setToolDefinitionsJson] = useState('')
  const [submittedToolDefinitions, setSubmittedToolDefinitions] = useState<ProviderToolDefinition[]>([])
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [message, setMessage] = useState('Nothing is sent until the native Send once confirmation.')
  const [outcome, setOutcome] = useState<ProviderTaskOutcome | null>(null)
  const [streamState, setStreamState] = useState<ProviderStreamState | null>(null)
  const [activeCallId, setActiveCallId] = useState<string | null>(null)

  const chooseProvider = (next: RemoteProviderId) => {
    setProvider(next)
    setModel(REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
    setOutcome(null)
    setStreamState(null)
    setSubmittedToolDefinitions([])
    setPhase('idle')
    setMessage('Nothing is sent until the native Send once confirmation.')
  }

  const runReview = async () => {
    if (!desktopRuntimeAvailable()) {
      setPhase('error')
      setMessage('Remote review is available in the installed app.')
      return
    }
    const callId = `remote-review-${crypto.randomUUID()}`
    setActiveCallId(callId)
    setOutcome(null)
    setStreamState(null)
    setPhase('preparing')
    setMessage('Checking the OS credential vault…')
    try {
      if (!await providerCredentialStatus(provider)) throw new Error(`Add a ${REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === provider)?.name} key in Settings first.`)
      const snapshot = getAutomationEditorController(project.id).read()
      const toolDefinitions = parseProviderToolDefinitions(toolDefinitionsJson)
      setSubmittedToolDefinitions(toolDefinitions)
      const request = await buildRemoteReviewRequest({
        provider, model, question, runId: `remote-review-${crypto.randomUUID()}`, callId,
        toolDefinitions,
        draft: {
          projectId: project.id, documentId: project.documentId, projectTitle: project.title,
          revision: snapshot.revision, text: snapshot.text,
        },
      })
      setPhase('running')
      setMessage('Native approval or the provider response is pending. Research leaves only after Send once.')
      let observedStream = initialProviderStreamState()
      let streamProtocolError: Error | null = null
      const providerLabel = REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === provider)?.name ?? provider
      const result = providerUsesNativeStreaming(provider)
        ? await providerGenerateStream(request, (event) => {
            if (streamProtocolError) return
            try {
              observedStream = applyProviderStreamEvent(observedStream, event)
              setStreamState(observedStream)
              if (event.type === 'message-start') setMessage(`${providerLabel} approved and connected. The response is streaming into this transient review.`)
            } catch (error) {
              streamProtocolError = error instanceof Error ? error : new Error(String(error))
              void providerCancel(callId)
            }
          })
        : await providerGenerate(request)
      if (streamProtocolError) throw streamProtocolError
      setOutcome(result)
      if (result.response) {
        setPhase('complete')
        setMessage('Remote review returned. It remains a local review artifact and was not added to the shared draft.')
      } else {
        setPhase(result.errorCode === 'cancelled' ? 'idle' : 'error')
        setMessage(result.errorCode === 'cancelled' ? 'Remote review cancelled.' : `Remote review failed (${result.errorCode ?? 'unknown'}).`)
      }
    } catch (error) {
      setPhase('error')
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setActiveCallId(null)
    }
  }

  const cancelReview = async () => {
    if (!activeCallId) return
    setPhase('cancelling')
    setMessage('Cancelling the active provider call…')
    try {
      const found = await providerCancel(activeCallId)
      if (!found) setMessage('The provider call had already finished.')
    } catch {
      setPhase('error')
      setMessage('Could not cancel the provider call.')
    }
  }

  const busy = ['preparing', 'waiting-approval', 'running', 'cancelling'].includes(phase)
  return (
    <div className="remote-review">
      <div className="workspace-panel-label mono">Remote perspective</div>
      <p className="remote-review-intro">Optionally ask one paid API to challenge the current draft. Local models remain the default.</p>
      <label>
        Provider
        <select value={provider} disabled={busy} onChange={(event) => chooseProvider(event.target.value as RemoteProviderId)}>
          {REMOTE_REVIEW_PROVIDERS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </label>
      <label>
        Model ID
        <input value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
      </label>
      <label>
        Review question
        <textarea value={question} disabled={busy} rows={5} onChange={(event) => setQuestion(event.target.value)} />
      </label>
      <details className="remote-review-tools">
        <summary>Tool proposals (advanced)</summary>
        <p>Optionally provide a JSON array of custom function schemas from Syzygy's bounded safe subset. Returned arguments are checked against the matching schema, but domain review remains separate. Syzygy never executes the calls or sends results back.</p>
        <label>
          Function schemas (JSON)
          <textarea
            value={toolDefinitionsJson}
            disabled={busy}
            rows={8}
            spellCheck={false}
            placeholder={'[{"name":"lookup_source","description":"Propose a source lookup","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]'}
            onChange={(event) => setToolDefinitionsJson(event.target.value)}
          />
        </label>
      </details>
      <div className="remote-review-actions">
        <button className="btn" type="button" disabled={busy || !question.trim() || !model.trim()} onClick={() => void runReview()}>
          Send one review
        </button>
        {busy && <button className="btn ghost danger" type="button" onClick={() => void cancelReview()}>Cancel</button>}
      </div>
      <div className={`remote-review-status ${phase}`} role="status">{message}</div>
      <RemoteResearchReviewResult
        provider={provider}
        model={model}
        outcome={outcome}
        streamState={streamState}
        toolDefinitions={submittedToolDefinitions}
      />
    </div>
  )
}
