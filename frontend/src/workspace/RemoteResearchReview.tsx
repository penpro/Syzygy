import { useState } from 'react'
import {
  desktopRuntimeAvailable,
  providerCancel,
  providerCredentialStatus,
  providerGenerate,
  type ProviderTaskOutcome,
  type RemoteProviderId,
} from '../tauri'
import { getAutomationEditorController } from './editorAutomationRegistry'
import type { ResearchProjectManifest } from './schema'
import { buildRemoteReviewRequest, REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'

const DEFAULT_QUESTION = 'Identify the three most consequential unsupported assumptions or failure modes in this draft. Cite the relevant supplied passage and distinguish evidence from inference.'

type ReviewPhase = 'idle' | 'preparing' | 'running' | 'cancelling' | 'complete' | 'error'

export function RemoteResearchReview({ project }: { project: ResearchProjectManifest }) {
  const [provider, setProvider] = useState<RemoteProviderId>('openai')
  const [model, setModel] = useState(REMOTE_REVIEW_PROVIDERS[0].defaultModel)
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [message, setMessage] = useState('Nothing is sent until the native Send once confirmation.')
  const [outcome, setOutcome] = useState<ProviderTaskOutcome | null>(null)
  const [activeCallId, setActiveCallId] = useState<string | null>(null)

  const chooseProvider = (next: RemoteProviderId) => {
    setProvider(next)
    setModel(REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
    setOutcome(null)
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
    setPhase('preparing')
    setMessage('Checking the OS credential vault…')
    try {
      if (!await providerCredentialStatus(provider)) throw new Error(`Add a ${REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === provider)?.name} key in Settings first.`)
      const snapshot = getAutomationEditorController(project.id).read()
      const request = await buildRemoteReviewRequest({
        provider, model, question, runId: `remote-review-${crypto.randomUUID()}`, callId,
        draft: {
          projectId: project.id, documentId: project.documentId, projectTitle: project.title,
          revision: snapshot.revision, text: snapshot.text,
        },
      })
      setPhase('running')
      setMessage('Native approval or the provider response is pending. Research leaves only after Send once.')
      const result = await providerGenerate(request)
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
      <div className="remote-review-actions">
        <button className="btn" type="button" disabled={busy || !question.trim() || !model.trim()} onClick={() => void runReview()}>
          Send one review
        </button>
        {busy && <button className="btn ghost danger" type="button" onClick={() => void cancelReview()}>Cancel</button>}
      </div>
      <div className={`remote-review-status ${phase}`} role="status">{message}</div>
      {outcome?.response && (
        <div className="remote-review-result">
          <div className="remote-review-result-meta mono">
            {outcome.response.provider} · {outcome.response.model ?? model} · {outcome.response.usage?.totalTokens ?? 'usage unknown'} tokens
          </div>
          <div className="remote-review-result-text">{outcome.response.text}</div>
          {outcome.zeroDataRetention !== null && <div className="remote-review-retention mono">Provider reported zero data retention: {outcome.zeroDataRetention ? 'yes' : 'no'}</div>}
        </div>
      )}
    </div>
  )
}
