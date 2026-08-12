import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import {
  desktopRuntimeAvailable,
  providerCancel,
  providerContinueSourceLocator,
  providerCredentialStatus,
  providerGenerate,
  providerGenerateStream,
  type ProviderTaskOutcome,
  type ProviderResearchTaskRequest,
  type ProviderToolDefinition,
  type ProviderToolProposalValidation,
  type RemoteProviderId,
} from '../tauri'
import { useStore } from '../store'
import {
  applyProviderStreamEvent,
  initialProviderStreamState,
  type ProviderStreamState,
} from '../providerStream'
import { validateProviderToolProposal } from '../providerToolValidation'
import { getAutomationEditorController } from './editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import {
  inspectProviderReviewHistory,
  readProviderReviewArchive,
  saveProviderReview,
  type ProviderReviewArchive,
  type ProviderReviewHistoryInspection,
} from './providerReviewHistory'
import {
  attestProviderReviewArchiveEvent,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'
import type { ResearchProjectManifest } from './schema'
import { buildRemoteReviewRequest, parseProviderToolDefinitions, REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

const DEFAULT_QUESTION = 'Identify the three most consequential unsupported assumptions or failure modes in this draft. Cite the relevant supplied passage and distinguish evidence from inference.'

type ReviewPhase = 'idle' | 'preparing' | 'running' | 'cancelling' | 'complete' | 'error'

const EMPTY_PROVIDER_HISTORY: ProviderReviewHistoryInspection = {
  healthy: true,
  archiveCount: 0,
  items: [],
  conflictedRunIds: [],
  issues: [],
  totalBytes: 0,
}

export function reconcileSourceLocatorContinuation(
  previous: ProviderTaskOutcome | null,
  result: ProviderTaskOutcome,
): {
  displayedOutcome: ProviderTaskOutcome | null
  continuationAvailable: boolean
  disclosureCancelled: boolean
} {
  const disclosureCancelled = result.response === null && result.errorCode === 'disclosure-required'
  return {
    displayedOutcome: disclosureCancelled ? previous : result,
    continuationAvailable: disclosureCancelled
      ? previous?.toolContinuationAvailable === true
      : result.toolContinuationAvailable,
    disclosureCancelled,
  }
}

export type RemoteResearchReviewResultProps = {
  provider: RemoteProviderId
  model: string
  outcome: ProviderTaskOutcome | null
  streamState: ProviderStreamState | null
  toolDefinitions?: ProviderToolDefinition[]
  onContinueTools?: () => void
  continuingTools?: boolean
  shared?: boolean
}

export function providerUsesNativeStreaming(provider: RemoteProviderId): boolean {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini' || provider === 'xai'
}

function validationLabel(validation: ProviderToolProposalValidation): string {
  if (validation.domainStatus === 'source-snapshot-approved' && validation.executable) {
    return 'Schema matches · frozen snapshot approved · native read only'
  }
  if (validation.domainStatus === 'source-snapshot-rejected') {
    return 'Source scope rejected · not executable'
  }
  switch (validation.schemaStatus) {
    case 'pending': return 'Schema check pending · domain unreviewed · not executable'
    case 'valid': return 'Schema matches · domain unreviewed · not executable'
    case 'invalid': return 'Schema mismatch · domain unreviewed · not executable'
    case 'missing-definition': return 'Definition missing · domain unreviewed · not executable'
  }
}

export function RemoteResearchReviewResult({
  provider,
  model,
  outcome,
  streamState,
  toolDefinitions = [],
  onContinueTools,
  continuingTools = false,
  shared = false,
}: RemoteResearchReviewResultProps) {
  const response = outcome?.response
  const text = response?.text ?? streamState?.text ?? ''
  const toolProposals = response?.toolProposals ?? streamState?.toolCalls ?? []
  if (!text && !toolProposals.length) return null
  const tokens = response?.usage?.totalTokens ?? streamState?.usage?.totalTokens
  const hasExecutableNativeTool = toolProposals.some((proposal) => (
    'validation' in proposal && proposal.validation.executable
  ))
  return (
    <div className="remote-review-result" aria-live="polite">
      <div className="remote-review-result-meta mono">
        {response?.provider ?? provider} · {response?.model ?? model} · {tokens ?? (response ? 'usage unknown' : 'streaming')}{typeof tokens === 'number' ? ' tokens' : ''}
      </div>
      {text ? <div className="remote-review-result-text">{text}</div> : null}
      {toolProposals.length ? (
        <div className="remote-review-tool-proposals">
          <div className="remote-review-tool-heading">
            {hasExecutableNativeTool
              ? 'Tool proposals · native source scope reviewed · execution requires confirmation'
              : 'Tool proposals · inspect only · not executed'}
          </div>
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
      {outcome?.toolContinuationAvailable && onContinueTools ? (
        <button className="btn" type="button" disabled={continuingTools} onClick={onContinueTools}>
          {continuingTools ? 'Continuing…' : `Run native source locator and continue${outcome.toolContinuationTurn ? ` · turn ${outcome.toolContinuationTurn}` : ''}`}
        </button>
      ) : null}
      {streamState?.warnings.length ? <div className="remote-review-retention mono">Provider notices: {streamState.warnings.join(', ')}</div> : null}
      {outcome?.zeroDataRetention !== null && outcome?.zeroDataRetention !== undefined && <div className="remote-review-retention mono">Provider reported zero data retention: {outcome.zeroDataRetention ? 'yes' : 'no'}</div>}
      <div className="remote-review-retention mono">
        {shared ? 'Shared immutable review archive' : 'Transient review'} · never applied to the shared draft automatically
      </div>
    </div>
  )
}

export function ProviderReviewHistoryView({
  inspection,
  loading,
  selectedRunId,
  selectedArchive,
  onSelect,
}: {
  inspection: ProviderReviewHistoryInspection
  loading: boolean
  selectedRunId: string | null
  selectedArchive: ProviderReviewArchive | null
  onSelect: (runId: string) => void
}) {
  return <section className="adversarial-history" aria-label="Shared provider review history">
    <div className="adversarial-section-heading">
      <strong>Shared provider review history</strong>
      <span className="mono">{inspection.archiveCount} archive{inspection.archiveCount === 1 ? '' : 's'}</span>
    </div>
    {loading && <p className="scenario-state" role="status">Checking shared provider review history…</p>}
    {inspection.issues.length > 0 && <div className="scenario-state error" role="alert">
      New archives are disabled until history integrity is repaired: {inspection.issues.join('; ')}
    </div>}
    {!loading && inspection.archiveCount === 0 && <p className="scenario-state">
      No single-provider reviews have been shared with this project.
    </p>}
    {inspection.conflictedRunIds.map((runId) => <div className="adversarial-conflict" key={runId}>
      <strong>Provider review conflict · {runId}</strong>
      <p>Collaborators retained different immutable archives for this run. No archive was selected.</p>
    </div>)}
    {inspection.items.length > 0 && <nav className="adversarial-history-list" aria-label="Saved provider reviews">
      {inspection.items.map((item) => <button
        className={item.runId === selectedRunId ? 'adversarial-history-item active' : 'adversarial-history-item'}
        key={item.runId}
        type="button"
        onClick={() => onSelect(item.runId)}
      >
        <span>{item.providerId} · {item.model}</span>
        <span className="mono">{new Date(item.createdAt).toISOString()} · {item.totalTokens ?? 'usage unknown'}{item.totalTokens === null ? '' : ' tokens'}</span>
        <span className="mono">{item.createdBy.displayName} · {item.sourceCount} frozen source{item.sourceCount === 1 ? '' : 's'}</span>
      </button>)}
    </nav>}
    {selectedRunId && !selectedArchive && !loading && !inspection.conflictedRunIds.includes(selectedRunId) && (
      <p className="scenario-state error" role="alert">The selected provider review could not be verified.</p>
    )}
    {selectedArchive && <article className="remote-review-result" aria-label="Selected shared provider review">
      <div className="remote-review-result-meta mono">
        {selectedArchive.runRecord.provider.id} · {selectedArchive.runRecord.provider.model} · {selectedArchive.runRecord.usage.totalTokens ?? 'usage unknown'}{selectedArchive.runRecord.usage.totalTokens === null ? '' : ' tokens'}
      </div>
      <h4>Research question</h4>
      <p>{selectedArchive.request.question}</p>
      <details>
        <summary>Frozen sources · {selectedArchive.request.sources.length}</summary>
        {selectedArchive.request.sources.map((source) => <div key={source.snapshotId}>
          <div className="mono">{source.label} · {source.snapshotId}</div>
          <pre className="remote-review-result-text">{source.excerpt}</pre>
        </div>)}
      </details>
      <h4>Provider response</h4>
      <div className="remote-review-result-text">{selectedArchive.response.text}</div>
      {selectedArchive.response.toolProposals.length > 0 && <details>
        <summary>Retained tool proposals · {selectedArchive.response.toolProposals.length}</summary>
        {selectedArchive.response.toolProposals.map((proposal) => <pre key={proposal.callId}>
          {JSON.stringify(proposal, null, 2)}
        </pre>)}
      </details>}
      <div className="remote-review-retention mono">
        Immutable archive {selectedArchive.recordSha256.slice(0, 12)}… · source revision {selectedArchive.sourceDocumentRevision}
      </div>
      <div className="remote-review-retention mono">
        Installation-provided author {selectedArchive.createdBy.displayName} · not authenticated human identity
      </div>
    </article>}
  </section>
}

export function RemoteResearchReview({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [provider, setProvider] = useState<RemoteProviderId>('openai')
  const [model, setModel] = useState(REMOTE_REVIEW_PROVIDERS[0].defaultModel)
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [toolDefinitionsJson, setToolDefinitionsJson] = useState('')
  const [sourceLocatorEnabled, setSourceLocatorEnabled] = useState(false)
  const [submittedToolDefinitions, setSubmittedToolDefinitions] = useState<ProviderToolDefinition[]>([])
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [message, setMessage] = useState('Nothing is sent until the native Send once confirmation.')
  const [outcome, setOutcome] = useState<ProviderTaskOutcome | null>(null)
  const [streamState, setStreamState] = useState<ProviderStreamState | null>(null)
  const [activeCallId, setActiveCallId] = useState<string | null>(null)
  const [toolThreadCallId, setToolThreadCallId] = useState<string | null>(null)
  const [submittedRequest, setSubmittedRequest] = useState<ProviderResearchTaskRequest | null>(null)
  const [sourceDocumentRevision, setSourceDocumentRevision] = useState<string | null>(null)
  const [document, setDocument] = useState<Y.Doc | null>(null)
  const [researchTick, setResearchTick] = useState(0)
  const [history, setHistory] = useState<ProviderReviewHistoryInspection>(EMPTY_PROVIDER_HISTORY)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedArchive, setSelectedArchive] = useState<ProviderReviewArchive | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [savedRunId, setSavedRunId] = useState<string | null>(null)
  const [archiveAttribution, setArchiveAttribution] = useState<ResearchEventAttributionResult | null>(null)
  const archiveOperation = useRef(0)

  useEffect(() => {
    archiveOperation.current += 1
    setSubmittedRequest(null)
    setSourceDocumentRevision(null)
    setSelectedRunId(null)
    setSelectedArchive(null)
    setSavedRunId(null)
    setArchiveAttribution(null)
  }, [project.id])

  useEffect(() => {
    let activeDiscussions: Y.Map<unknown> | null = null
    const onHistoryUpdate = () => setResearchTick((value) => value + 1)
    const unsubscribe = subscribeAutomationProjectDocument(project.id, (next) => {
      activeDiscussions?.unobserve(onHistoryUpdate)
      activeDiscussions = next ? getProjectSharedTypes(next).discussions : null
      setDocument(next)
      activeDiscussions?.observe(onHistoryUpdate)
      setResearchTick((value) => value + 1)
    })
    return () => {
      activeDiscussions?.unobserve(onHistoryUpdate)
      unsubscribe()
    }
  }, [project.id])

  useEffect(() => {
    let cancelled = false
    if (!document) {
      setHistory(EMPTY_PROVIDER_HISTORY)
      setHistoryLoading(false)
      setSelectedArchive(null)
      return
    }
    setHistoryLoading(true)
    void inspectProviderReviewHistory(getProjectSharedTypes(document).discussions).then((inspection) => {
      if (cancelled) return
      setHistory(inspection)
      if (selectedRunId && !inspection.items.some(({ runId }) => runId === selectedRunId)) {
        setSelectedRunId(null)
        setSelectedArchive(null)
      }
      setHistoryLoading(false)
    }).catch((error) => {
      if (cancelled) return
      setHistoryLoading(false)
      setMessage(error instanceof Error ? error.message : 'Could not inspect shared provider review history')
    })
    return () => { cancelled = true }
  }, [document, researchTick, selectedRunId])

  const selectSharedArchive = async (runId: string) => {
    setSelectedRunId(runId)
    setSelectedArchive(null)
    if (!document) return
    setHistoryLoading(true)
    try {
      const archive = await readProviderReviewArchive(getProjectSharedTypes(document).discussions, runId)
      setSelectedArchive(archive)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read the selected provider review')
    } finally {
      setHistoryLoading(false)
    }
  }

  const chooseProvider = (next: RemoteProviderId) => {
    archiveOperation.current += 1
    setProvider(next)
    setModel(REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
    setOutcome(null)
    setStreamState(null)
    setSubmittedToolDefinitions([])
    setSubmittedRequest(null)
    setSourceDocumentRevision(null)
    setToolThreadCallId(null)
    setSavedRunId(null)
    setArchiveAttribution(null)
    setPhase('idle')
    setMessage('Nothing is sent until the native Send once confirmation.')
  }

  const runReview = async () => {
    archiveOperation.current += 1
    if (!desktopRuntimeAvailable()) {
      setPhase('error')
      setMessage('Remote review is available in the installed app.')
      return
    }
    const callId = `remote-review-${crypto.randomUUID()}`
    setActiveCallId(callId)
    setOutcome(null)
    setStreamState(null)
    setToolThreadCallId(null)
    setSubmittedRequest(null)
    setSourceDocumentRevision(null)
    setSavedRunId(null)
    setArchiveAttribution(null)
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
        enableSourceLocator: sourceLocatorEnabled,
        draft: {
          projectId: project.id, documentId: project.documentId, projectTitle: project.title,
          revision: snapshot.revision, text: snapshot.text,
        },
      })
      setSubmittedRequest(request)
      setSourceDocumentRevision(snapshot.revision)
      setPhase('running')
      setMessage('Native approval or the provider response is pending. Research leaves only after Send once.')
      let observedStream = initialProviderStreamState()
      let streamProtocolError: Error | null = null
      const providerLabel = REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === provider)?.name ?? provider
      const result = providerUsesNativeStreaming(provider) && !sourceLocatorEnabled
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
      setToolThreadCallId(result.toolContinuationAvailable ? callId : null)
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

  const continueSourceLocator = async () => {
    if (!toolThreadCallId) return
    const callId = `remote-review-tool-${crypto.randomUUID()}`
    setActiveCallId(callId)
    setPhase('preparing')
    setMessage('Preparing bounded native source-locator results for a fresh disclosure…')
    try {
      const result = await providerContinueSourceLocator({
        threadCallId: toolThreadCallId,
        callId,
      })
      const reconciled = reconcileSourceLocatorContinuation(outcome, result)
      if (submittedRequest && result.runRecord.callId !== submittedRequest.callId) {
        setSubmittedRequest({ ...submittedRequest, callId: result.runRecord.callId })
      }
      setOutcome(reconciled.displayedOutcome)
      setStreamState(null)
      if (result.response) {
        setPhase('complete')
        setMessage(result.toolContinuationAvailable
          ? 'The provider requested another approved source lookup. Review it before continuing.'
          : 'The provider used the native source result and returned a final transient review.')
        if (!reconciled.continuationAvailable) setToolThreadCallId(null)
      } else {
        setPhase(reconciled.disclosureCancelled ? 'idle' : 'error')
        setMessage(reconciled.disclosureCancelled
          ? 'Tool continuation was not sent. The reviewed proposal remains available until it expires.'
          : `Tool continuation failed (${result.errorCode ?? 'unknown'}).`)
        if (!reconciled.continuationAvailable) setToolThreadCallId(null)
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

  const shareReview = async () => {
    if (!document || !submittedRequest || !sourceDocumentRevision || !outcome?.response ||
      outcome.toolContinuationAvailable || archiveBusy || !history.healthy) return
    const operation = ++archiveOperation.current
    setArchiveBusy(true)
    setArchiveAttribution(null)
    setMessage('Saving the full review to shared project history…')
    try {
      const archive = await saveProviderReview(document, {
        expectedResearchRevision: projectStateFingerprint(document),
        projectId: project.id,
        documentId: project.documentId,
        sourceDocumentRevision,
        request: submittedRequest,
        response: outcome.response,
        runRecord: outcome.runRecord,
        participantId: researcherId,
        displayName: researcherName,
        createdAt: Date.now(),
      })
      if (operation !== archiveOperation.current) return
      setSavedRunId(archive.runId)
      setSelectedRunId(archive.runId)
      setSelectedArchive(archive)
      setMessage('Full question, frozen sources, response, tool proposals, and content-free provenance were added to shared project history. The draft was not changed. Saving device attribution…')
      const attribution = await attestProviderReviewArchiveEvent(document, project.id, archive)
      if (operation !== archiveOperation.current) return
      setArchiveAttribution(attribution)
      setMessage(attribution.status === 'signed-device'
        ? 'Shared provider review saved with an exact registered-device signature. The signature identifies an installation key, not a person or organization.'
        : `Shared provider review saved without a device signature (${attribution.reason}). The archive remains committed and the draft was not changed.`)
    } catch (error) {
      if (operation === archiveOperation.current) {
        setMessage(error instanceof Error ? error.message : 'Could not share the provider review')
      }
    } finally {
      if (operation === archiveOperation.current) setArchiveBusy(false)
    }
  }

  const busy = ['preparing', 'waiting-approval', 'running', 'cancelling'].includes(phase) || archiveBusy
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
        <p>Optionally provide a JSON array of custom function schemas from Syzygy's bounded safe subset. Returned arguments are checked against the matching schema, but custom functions remain inspect-only and are never executed or continued.</p>
        <label className="remote-review-source-locator">
          <input
            type="checkbox"
            checked={sourceLocatorEnabled}
            disabled={busy}
            onChange={(event) => setSourceLocatorEnabled(event.target.checked)}
          />
          Allow Syzygy's native exact-text locator over the frozen source snapshots in this request
        </label>
        <p>The native locator is read-only and bounded. It cannot reach Drive, files, MCP, plugins, the editor, or the network. Tool-enabled requests use a one-shot response so opaque continuation state stays in native memory; every result turn requires a fresh native disclosure. Custom functions remain inspect-only.</p>
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
        onContinueTools={toolThreadCallId ? () => void continueSourceLocator() : undefined}
        continuingTools={phase === 'preparing' || phase === 'running'}
        shared={Boolean(submittedRequest && savedRunId === submittedRequest.runId)}
      />
      {outcome?.response && submittedRequest && !outcome.toolContinuationAvailable && (
        <div className="remote-review-tools">
          <div className="remote-review-actions">
            <button
              className="btn primary"
              type="button"
              disabled={archiveBusy || !document || !history.healthy || savedRunId === submittedRequest.runId}
              onClick={() => void shareReview()}
            >
              {archiveBusy ? 'Sharing and checking signature…' : savedRunId === submittedRequest.runId ? 'Shared with project' : 'Share full review with project'}
            </button>
          </div>
          <p>
            Sharing writes the full question, frozen excerpts, normalized response, retained tool proposals,
            and content-free provider provenance to collaborative project history. It never changes the policy draft.
          </p>
          {archiveAttribution?.status === 'signed-device' && <div className="remote-review-retention mono">
            Exact archive signed by registered device key · {archiveAttribution.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…
          </div>}
          {archiveAttribution?.status === 'unsigned' && <div className="remote-review-retention mono">
            Archive retained without device signature · {archiveAttribution.reason}
          </div>}
        </div>
      )}
      <ProviderReviewHistoryView
        inspection={history}
        loading={historyLoading}
        selectedRunId={selectedRunId}
        selectedArchive={selectedArchive}
        onSelect={(runId) => void selectSharedArchive(runId)}
      />
    </div>
  )
}
