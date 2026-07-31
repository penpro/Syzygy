import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { desktopRuntimeAvailable, providerCredentialStatus, type RemoteProviderId } from '../tauri'
import { useStore } from '../store'
import { now, uid } from '../util'
import {
  cancelAdversarialAutomationJob,
  getPersistableAdversarialAutomationJob,
  inspectAdversarialAutomationJob,
  startAdversarialAutomationJob,
  type AdversarialAutomationJobView,
} from '../extensions/adversarialAutomation'
import {
  decideAdversarialReview,
  inspectAdversarialReviewHistory,
  readAdversarialReviewArchive,
  readAdversarialReviewDecision,
  saveAdversarialReviewArchive,
  type AdversarialReviewArchive,
  type AdversarialReviewDecision,
  type AdversarialReviewDecisionSummary,
  type AdversarialReviewSummary,
} from '../extensions/adversarialHistory'
import type { AdversarialParticipant } from '../extensions/adversarialProtocol'
import {
  automationEditorReady,
  getAutomationEditorController,
  type AutomationEditorSnapshot,
} from './editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'
import { AdversarialEvidenceView } from './AdversarialEvidenceView'
import type { ResearchProjectManifest } from './schema'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

const DEFAULT_QUESTION = 'Which conclusions in this draft survive adversarial review, which claims remain unsupported or conflicted, and what evidence would most change the answer?'
const MAX_SELECTED_SOURCES = 200
export const MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS = 8

export interface ProductAdversarialRoute extends AdversarialParticipant {
  providerId: RemoteProviderId
}

export interface ProductAdversarialDraft {
  question: string
  seed: string
  participants: ProductAdversarialRoute[]
  judge: ProductAdversarialRoute
  baseline: ProductAdversarialRoute
}

type HistoryInspection = Awaited<ReturnType<typeof inspectAdversarialReviewHistory>>

const EMPTY_HISTORY: HistoryInspection = {
  healthy: true,
  archiveCount: 0,
  decisionCount: 0,
  invalidRecords: 0,
  conflictedRunIds: [],
  items: [],
  issues: [],
}

function providerOption(id: RemoteProviderId) {
  return REMOTE_REVIEW_PROVIDERS.find((provider) => provider.id === id) ?? REMOTE_REVIEW_PROVIDERS[0]
}

function route(slotId: string, providerId: RemoteProviderId): ProductAdversarialRoute {
  return { slotId, providerId, modelId: providerOption(providerId).defaultModel }
}

export function defaultProductAdversarialDraft(): ProductAdversarialDraft {
  return {
    question: DEFAULT_QUESTION,
    seed: `seed-${uid()}`,
    participants: [
      route('perspective-1', 'openai'),
      route('perspective-2', 'anthropic'),
    ],
    judge: route('judge', 'gemini'),
    baseline: route('baseline', 'openai'),
  }
}

export function adversarialRemoteCallCount(participantCount: number): number {
  if (!Number.isSafeInteger(participantCount) || participantCount < 2) {
    throw new Error('At least two adversarial perspectives are required')
  }
  return 4 * participantCount + 6
}

export function eligibleAdversarialSourceIndexes(snapshot: AutomationEditorSnapshot): number[] {
  return snapshot.blocks.flatMap((block, index) => block.text.trim() ? [index] : [])
}

export function buildProductAdversarialJobParameters(
  draft: ProductAdversarialDraft,
  sourceBlockIndexes: number[],
  snapshot: AutomationEditorSnapshot,
  runId: string,
) {
  const question = draft.question.trim()
  const seed = draft.seed.trim()
  if (!question || question.length > 20_000) throw new Error('Enter a review question of at most 20,000 characters')
  if (!seed || seed.length > 200) throw new Error('Enter a bounded reproducibility seed')
  if (draft.participants.length < 2 || draft.participants.length > MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS) {
    throw new Error(`Choose between 2 and ${MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS} adversarial perspectives`)
  }
  const selected = [...new Set(sourceBlockIndexes)].sort((left, right) => left - right)
  if (selected.length === 0 || selected.length > MAX_SELECTED_SOURCES) {
    throw new Error(`Select between 1 and ${MAX_SELECTED_SOURCES} non-empty draft blocks`)
  }
  const eligible = new Set(eligibleAdversarialSourceIndexes(snapshot))
  if (selected.some((index) => !eligible.has(index))) throw new Error('A selected source block is empty or no longer available')
  return {
    projectId: snapshot.projectId,
    expectedDocumentRevision: snapshot.revision,
    runId,
    question,
    seed,
    sourceBlockIndexes: selected,
    participants: draft.participants.map(({ slotId, providerId, modelId }) => ({
      slotId,
      providerId,
      modelId: modelId.trim(),
    })),
    judge: { ...draft.judge, modelId: draft.judge.modelId.trim() },
    baseline: { ...draft.baseline, modelId: draft.baseline.modelId.trim() },
  }
}

function providerName(providerId: string): string {
  return REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === providerId)?.name ?? providerId
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value
}

function RouteEditor({
  label,
  value,
  disabled,
  onChange,
  onRemove,
}: {
  label: string
  value: ProductAdversarialRoute
  disabled: boolean
  onChange: (value: ProductAdversarialRoute) => void
  onRemove?: () => void
}) {
  const chooseProvider = (providerId: RemoteProviderId) => {
    onChange({ ...value, providerId, modelId: providerOption(providerId).defaultModel })
  }
  return (
    <div className="adversarial-route">
      <div className="adversarial-route-heading">
        <strong>{label}</strong>
        {onRemove && <button className="btn ghost danger sm" type="button" disabled={disabled} onClick={onRemove}>Remove</button>}
      </div>
      <label>
        Provider
        <select value={value.providerId} disabled={disabled} onChange={(event) => chooseProvider(event.target.value as RemoteProviderId)}>
          {REMOTE_REVIEW_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <label>
        Model ID
        <input
          value={value.modelId}
          maxLength={200}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ ...value, modelId: event.target.value })}
        />
      </label>
    </div>
  )
}

function DecisionBadge({ decision }: { decision: AdversarialReviewSummary['decision'] }) {
  return <span className={`adversarial-decision-badge ${decision}`}>{decision}</span>
}

export { AdversarialEvidenceView }

export function AdversarialReviewWorkspace({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [researchTick, setResearchTick] = useState(0)
  const [sourceSnapshot, setSourceSnapshot] = useState<AutomationEditorSnapshot | null>(null)
  const [latestEditorRevision, setLatestEditorRevision] = useState<string | null>(null)
  const [sourceIndexes, setSourceIndexes] = useState<number[]>([])
  const [sourceFilter, setSourceFilter] = useState('')
  const [draft, setDraft] = useState<ProductAdversarialDraft>(defaultProductAdversarialDraft)
  const [job, setJob] = useState<AdversarialAutomationJobView | null>(null)
  const [savedRunId, setSavedRunId] = useState<string | null>(null)
  const [status, setStatus] = useState('Choose exact draft blocks and model routes. Nothing is sent until one native batch approval.')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<HistoryInspection>(EMPTY_HISTORY)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedArchive, setSelectedArchive] = useState<AdversarialReviewArchive | null>(null)
  const [selectedDecision, setSelectedDecision] = useState<AdversarialReviewDecisionSummary | null>(null)
  const [decisionNotes, setDecisionNotes] = useState('')
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    let activeDiscussions: Y.Map<unknown> | null = null
    const onHistoryUpdate = () => setResearchTick((value) => value + 1)
    const unsubscribe = subscribeAutomationProjectDocument(project.id, (next) => {
      activeDiscussions?.unobserve(onHistoryUpdate)
      activeDiscussions = next ? getProjectSharedTypes(next).discussions : null
      setDoc(next)
      activeDiscussions?.observe(onHistoryUpdate)
      setResearchTick((value) => value + 1)
    })
    return () => {
      activeDiscussions?.unobserve(onHistoryUpdate)
      unsubscribe()
    }
  }, [project.id])

  const refreshSources = () => {
    setError('')
    try {
      const snapshot = getAutomationEditorController(project.id).read()
      const eligible = eligibleAdversarialSourceIndexes(snapshot)
      setSourceSnapshot(snapshot)
      setLatestEditorRevision(snapshot.revision)
      setSourceIndexes(eligible.slice(0, MAX_SELECTED_SOURCES))
      setStatus(
        eligible.length > MAX_SELECTED_SOURCES
          ? `Draft refreshed. The first ${MAX_SELECTED_SOURCES} non-empty blocks are selected; filter and adjust the selection if needed.`
          : `Draft refreshed. ${eligible.length} non-empty block${eligible.length === 1 ? ' is' : 's are'} selected.`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the live draft')
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (automationEditorReady(project.id)) refreshSources()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [project.id])

  useEffect(() => {
    let cancelled = false
    if (!doc) {
      setHistory(EMPTY_HISTORY)
      setSelectedArchive(null)
      setSelectedDecision(null)
      return
    }
    setHistoryLoading(true)
    void (async () => {
      const discussions = getProjectSharedTypes(doc).discussions
      const inspection = await inspectAdversarialReviewHistory(discussions)
      const availableIds = new Set(inspection.items.map(({ runId }) => runId))
      const nextRunId = selectedRunId && availableIds.has(selectedRunId)
        ? selectedRunId
        : inspection.items[inspection.items.length - 1]?.runId ?? null
      const archive = nextRunId ? await readAdversarialReviewArchive(discussions, nextRunId) : null
      const decision = nextRunId ? readAdversarialReviewDecision(discussions, nextRunId) : null
      if (cancelled) return
      setHistory(inspection)
      setSelectedRunId(nextRunId)
      setSelectedArchive(archive)
      setSelectedDecision(decision)
      setHistoryLoading(false)
    })().catch((caught) => {
      if (cancelled) return
      setHistoryLoading(false)
      setError(caught instanceof Error ? caught.message : 'Could not inspect shared adversarial history')
    })
    return () => { cancelled = true }
  }, [doc, researchTick, selectedRunId])

  useEffect(() => {
    if (!job) return
    let timer: number | null = null
    const refresh = () => {
      try {
        const next = inspectAdversarialAutomationJob(job.jobId)
        setJob(next)
        if (automationEditorReady(project.id)) {
          setLatestEditorRevision(getAutomationEditorController(project.id).read().revision)
        }
        if (next.status === 'running') {
          setStatus(`Adversarial review is running ${next.totalRemoteCalls} bounded provider calls. The job heartbeats every 30 seconds and stops at its deadline.`)
          return
        }
        if (timer !== null) window.clearInterval(timer)
        if (next.status === 'completed') {
          setStatus('Review complete. Inspect it below, then explicitly share the full archive or discard the transient result.')
        } else if (next.status === 'cancelled') {
          setStatus('Adversarial review cancelled. Nothing was added to shared research history.')
        } else {
          setError(`Adversarial review failed (${next.errorCode ?? 'review-failed'}). Nothing was added to shared research history.`)
        }
      } catch (caught) {
        if (timer !== null) window.clearInterval(timer)
        setError(caught instanceof Error ? caught.message : 'Could not inspect the adversarial review job')
      }
    }
    timer = window.setInterval(refresh, 1_000)
    refresh()
    return () => {
      if (timer !== null) window.clearInterval(timer)
    }
  }, [job?.jobId, project.id])

  const eligibleBlocks = useMemo(() => {
    if (!sourceSnapshot) return []
    return eligibleAdversarialSourceIndexes(sourceSnapshot).map((index) => ({
      index,
      block: sourceSnapshot.blocks[index],
    }))
  }, [sourceSnapshot])

  const visibleBlocks = useMemo(() => {
    const query = sourceFilter.trim().toLowerCase()
    return eligibleBlocks.filter(({ index, block }) =>
      !query || `block ${index + 1} ${block.kind} ${block.text}`.toLowerCase().includes(query),
    ).slice(0, 100)
  }, [eligibleBlocks, sourceFilter])

  const updateParticipant = (index: number, value: ProductAdversarialRoute) => {
    setDraft((current) => ({
      ...current,
      participants: current.participants.map((participant, candidate) => candidate === index ? value : participant),
    }))
  }

  const addParticipant = () => {
    setDraft((current) => {
      if (current.participants.length >= MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS) return current
      const index = current.participants.length + 1
      const provider = REMOTE_REVIEW_PROVIDERS[(index - 1) % REMOTE_REVIEW_PROVIDERS.length].id
      return { ...current, participants: [...current.participants, route(`perspective-${uid()}`, provider)] }
    })
  }

  const removeParticipant = (index: number) => {
    setDraft((current) => ({
      ...current,
      participants: current.participants.filter((_participant, candidate) => candidate !== index),
    }))
  }

  const toggleSource = (index: number) => {
    setSourceIndexes((current) => current.includes(index)
      ? current.filter((candidate) => candidate !== index)
      : current.length >= MAX_SELECTED_SOURCES ? current : [...current, index].sort((left, right) => left - right))
  }

  const selectVisibleSources = () => {
    setSourceIndexes((current) => [...new Set([...current, ...visibleBlocks.map(({ index }) => index)])]
      .sort((left, right) => left - right)
      .slice(0, MAX_SELECTED_SOURCES))
  }

  const identity = () => {
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before sharing or deciding adversarial research')
    }
    return { participantId: researcherId, displayName: researcherName.trim() }
  }

  const startReview = async () => {
    setError('')
    try {
      if (!desktopRuntimeAvailable()) throw new Error('Adversarial review is available in the installed app')
      if (!doc) throw new Error('Shared project research data is not ready')
      if (!sourceSnapshot) throw new Error('Refresh the live draft sources first')
      const current = getAutomationEditorController(project.id).read()
      if (current.revision !== sourceSnapshot.revision) {
        throw new Error('The draft changed after these source blocks were shown. Refresh the draft sources before starting.')
      }
      const runId = `adversarial-${uid()}`
      const params = buildProductAdversarialJobParameters(draft, sourceIndexes, current, runId)
      const providerIds = [...new Set([
        ...draft.participants.map(({ providerId }) => providerId),
        draft.judge.providerId,
        draft.baseline.providerId,
      ])]
      const statuses = await Promise.all(providerIds.map(async (providerId) => ({
        providerId,
        available: await providerCredentialStatus(providerId),
      })))
      const missing = statuses.filter(({ available }) => !available).map(({ providerId }) => providerName(providerId))
      if (missing.length) throw new Error(`Add provider keys in Settings before this batch: ${missing.join(', ')}`)
      const started = startAdversarialAutomationJob(params, current)
      setJob(started)
      setSavedRunId(null)
      setStatus(`Native approval is pending for ${started.totalRemoteCalls} exact provider calls. Nothing runs if you decline.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start adversarial review')
    }
  }

  const cancelReview = () => {
    if (!job) return
    setError('')
    try {
      setJob(cancelAdversarialAutomationJob(job.jobId))
      setStatus('Cancellation requested. Completed provider calls remain consumed; no shared archive is created.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel the adversarial review')
    }
  }

  const clearJob = () => {
    if (job?.status === 'running') return
    setJob(null)
    setSavedRunId(null)
    setDraft((current) => ({ ...current, seed: `seed-${uid()}` }))
    setStatus('Transient result cleared. Shared archives and decisions remain in project history.')
    setError('')
  }

  const saveReview = async () => {
    if (!doc || !job) return
    setError('')
    try {
      if (!history.healthy) throw new Error('Shared adversarial history needs attention before another archive can be saved')
      const author = identity()
      const completed = getPersistableAdversarialAutomationJob(job.jobId)
      const saved = await saveAdversarialReviewArchive(doc, {
        expectedResearchRevision: projectStateFingerprint(doc),
        projectId: project.id,
        sourceDocumentRevision: completed.documentRevision,
        request: completed.request,
        outcome: completed.outcome,
        participantId: author.participantId,
        displayName: author.displayName,
        createdAt: job.completedAt ?? job.startedAt,
      })
      setSavedRunId(saved.archive.runId)
      setSelectedRunId(saved.archive.runId)
      setStatus('Full question, selected excerpts, outputs, baselines, and provenance were added to shared project history. The draft was not changed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the adversarial review')
    }
  }

  const recordDecision = async (decision: AdversarialReviewDecision) => {
    if (!doc || !selectedArchive) return
    setDecisionBusy(true)
    setError('')
    try {
      if (!history.healthy) throw new Error('Shared adversarial history needs attention before recording a decision')
      const author = identity()
      const result = await decideAdversarialReview(doc, {
        expectedResearchRevision: projectStateFingerprint(doc),
        projectId: project.id,
        runId: selectedArchive.runId,
        recordSha256: selectedArchive.recordSha256,
        expectedCurrentDecisionId: selectedDecision?.current.eventId ?? null,
        decision,
        eventId: `adversarial-decision-${uid()}`,
        participantId: author.participantId,
        displayName: author.displayName,
        notes: decisionNotes,
        timestamp: now(),
      })
      setSelectedDecision(result.decision)
      setDecisionNotes('')
      setStatus(`${decision === 'accepted' ? 'Accepted' : 'Rejected'} was recorded as an immutable human decision. The policy draft was not changed.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record the adversarial review decision')
    } finally {
      setDecisionBusy(false)
    }
  }

  const busy = job?.status === 'running'
  const completedOutcome = job?.status === 'completed' ? job.outcome : null
  const sourceChanged = Boolean(job && latestEditorRevision && job.documentRevision !== latestEditorRevision)
  const selectedSummary = history.items.find(({ runId }) => runId === selectedRunId) ?? null

  return (
    <section className="adversarial-workspace" aria-label="Adversarial multi-model review">
      <div className="workspace-panel-label mono">Adversarial review</div>
      <h2>Independent perspectives, one inspectable record</h2>
      <p className="adversarial-intro">
        Run a blinded multi-model panel plus an equal-call baseline. Agreement is not truth, and every result waits for human review.
      </p>

      <details className="adversarial-setup" open={!job}>
        <summary>Configure a review</summary>
        <label>
          Research question
          <textarea
            rows={5}
            maxLength={20_000}
            disabled={busy}
            value={draft.question}
            onChange={(event) => setDraft((current) => ({ ...current, question: event.target.value }))}
          />
        </label>
        <label>
          Reproducibility seed
          <input
            maxLength={200}
            disabled={busy}
            value={draft.seed}
            spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, seed: event.target.value }))}
          />
        </label>

        <div className="adversarial-section-heading">
          <strong>Exact draft evidence</strong>
          <button className="btn sm" type="button" disabled={busy} onClick={refreshSources}>Refresh draft</button>
        </div>
        {!sourceSnapshot && <p className="scenario-state">Open the live editor, then refresh the draft sources.</p>}
        {sourceSnapshot && <>
          <div className="adversarial-source-meta mono">
            Revision {shortId(sourceSnapshot.revision)} · {sourceIndexes.length}/{MAX_SELECTED_SOURCES} selected · {eligibleBlocks.length} eligible
          </div>
          <label>
            Filter blocks
            <input value={sourceFilter} disabled={busy} onChange={(event) => setSourceFilter(event.target.value)} />
          </label>
          <div className="adversarial-source-actions">
            <button className="btn sm" type="button" disabled={busy || visibleBlocks.length === 0} onClick={selectVisibleSources}>Select visible</button>
            <button className="btn sm" type="button" disabled={busy || sourceIndexes.length === 0} onClick={() => setSourceIndexes([])}>Clear selection</button>
          </div>
          <div className="adversarial-source-list" role="group" aria-label="Draft blocks supplied to every model call">
            {visibleBlocks.map(({ index, block }) => <label key={index}>
              <input
                type="checkbox"
                checked={sourceIndexes.includes(index)}
                disabled={busy || (!sourceIndexes.includes(index) && sourceIndexes.length >= MAX_SELECTED_SOURCES)}
                onChange={() => toggleSource(index)}
              />
              <span>
                <strong>Block {index + 1} · {block.kind}</strong>
                <small>{block.text.slice(0, 180)}{block.text.length > 180 ? '…' : ''}</small>
              </span>
            </label>)}
          </div>
          {eligibleBlocks.length > visibleBlocks.length && (
            <p className="scenario-state">Showing the first {visibleBlocks.length} matches. Refine the filter to reach other blocks.</p>
          )}
        </>}

        <div className="adversarial-section-heading">
          <strong>Independent perspectives · {draft.participants.length}/{MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS}</strong>
          <button className="btn sm" type="button" disabled={busy || draft.participants.length >= MAX_PRODUCT_ADVERSARIAL_PARTICIPANTS} onClick={addParticipant}>Add perspective</button>
        </div>
        <div className="adversarial-routes">
          {draft.participants.map((participant, index) => <RouteEditor
            key={participant.slotId}
            label={`Perspective ${index + 1}`}
            value={participant}
            disabled={busy}
            onChange={(value) => updateParticipant(index, value)}
            onRemove={draft.participants.length > 2 ? () => removeParticipant(index) : undefined}
          />)}
          <RouteEditor
            label="Blinded judge"
            value={draft.judge}
            disabled={busy}
            onChange={(judge) => setDraft((current) => ({ ...current, judge }))}
          />
          <RouteEditor
            label="Compute-matched baseline"
            value={draft.baseline}
            disabled={busy}
            onChange={(baseline) => setDraft((current) => ({ ...current, baseline }))}
          />
        </div>
        <div className="adversarial-batch-disclosure">
          <strong>{adversarialRemoteCallCount(draft.participants.length)} remote provider calls</strong>
          <p>
            One native approval freezes the question, selected excerpts, routes, call order, output limits, and total budget.
            Each configured provider receives the selected research content. Completed calls may incur API charges even if you cancel.
          </p>
        </div>
        <div className="remote-review-actions">
          <button className="btn primary" type="button" disabled={Boolean(job) || !sourceSnapshot || sourceIndexes.length === 0} onClick={() => void startReview()}>
            Review batch before sending
          </button>
        </div>
      </details>

      {job && <section className="adversarial-job" aria-label="Current adversarial review job">
        <div className="adversarial-job-heading">
          <strong>{job.status === 'completed' ? 'Transient result' : `Job ${job.status}`}</strong>
          <span className="mono">{shortId(job.runId)} · {job.totalRemoteCalls} calls</span>
        </div>
        {job.status === 'running' && <div className="adversarial-job-progress" role="progressbar" aria-label="Adversarial review running" />}
        <div className="remote-review-actions">
          {job.status === 'running' && <button className="btn ghost danger" type="button" onClick={cancelReview}>Cancel batch</button>}
          {job.status === 'completed' && savedRunId !== job.runId && (
            <button className="btn primary" type="button" disabled={!history.healthy} onClick={() => void saveReview()}>Share full review with project</button>
          )}
          {job.status !== 'running' && <button className="btn" type="button" onClick={clearJob}>
            {savedRunId === job.runId ? 'Start another review' : 'Discard transient result'}
          </button>}
        </div>
        {job.status === 'completed' && savedRunId !== job.runId && <div className="adversarial-share-disclosure">
          Sharing writes the complete question, selected excerpts, panel outputs, baselines, and provenance to project history.
          In a Drive project, collaborators may receive that archive. Nothing is added to the policy draft.
        </div>}
        {sourceChanged && <div className="scenario-state error" role="status">
          The live draft changed after this run started. This result remains bound to its earlier source revision.
        </div>}
        {completedOutcome && <AdversarialEvidenceView
          request={getPersistableAdversarialAutomationJob(job.jobId).request}
          outcome={completedOutcome}
          decision={null}
          sourceDocumentRevision={job.documentRevision}
        />}
      </section>}

      <div className={`remote-review-status ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
        {error || status}
      </div>

      <section className="adversarial-history" aria-label="Shared adversarial review history">
        <div className="adversarial-section-heading">
          <strong>Shared review history</strong>
          <span className="mono">{history.archiveCount} archive{history.archiveCount === 1 ? '' : 's'}</span>
        </div>
        {historyLoading && <p className="scenario-state" role="status">Checking shared review history…</p>}
        {!doc && <p className="scenario-state">Preparing shared project research data…</p>}
        {history.issues.length > 0 && <div className="scenario-state error" role="alert">
          Decisions are disabled until history integrity is repaired: {history.issues.join('; ')}
        </div>}
        {!historyLoading && doc && history.items.length === 0 && history.conflictedRunIds.length === 0 && (
          <p className="scenario-state">No adversarial reviews have been shared with this project.</p>
        )}
        {history.conflictedRunIds.map((runId) => <div className="adversarial-conflict" key={runId}>
          <strong>Conflicted review</strong>
          <span className="mono">{runId}</span>
          <p>Collaborators supplied different archives or decision branches for this run. No winner was selected.</p>
        </div>)}
        {history.items.length > 0 && <nav className="adversarial-history-list" aria-label="Saved adversarial reviews">
          {[...history.items].reverse().map((item) => <button
            key={item.runId}
            type="button"
            className={item.runId === selectedRunId ? 'adversarial-history-item active' : 'adversarial-history-item'}
            aria-current={item.runId === selectedRunId ? 'true' : undefined}
            onClick={() => setSelectedRunId(item.runId)}
          >
            <span>
              <strong>{formatTimestamp(item.createdAt)}</strong>
              <small className="mono">{shortId(item.runId)} · {item.participantCount} perspectives · {item.totalRemoteCalls} calls</small>
            </span>
            <DecisionBadge decision={item.decision} />
          </button>)}
        </nav>}

        {selectedArchive && selectedSummary && <>
          {latestEditorRevision && selectedArchive.sourceDocumentRevision !== latestEditorRevision && (
            <p className="scenario-state">This archive reviewed an earlier draft revision. Its evidence remains frozen.</p>
          )}
          <AdversarialEvidenceView
            request={selectedArchive.request}
            outcome={selectedArchive.outcome}
            decision={selectedDecision}
            sourceDocumentRevision={selectedArchive.sourceDocumentRevision}
            recordSha256={selectedArchive.recordSha256}
          />
          <div className="adversarial-decision">
            <h3>Record human judgment</h3>
            <p>
              Accept or reject this research record. The action appends history only; it does not change, replace, or apply text to the policy draft.
            </p>
            <label>
              Decision notes <span>(optional)</span>
              <textarea
                rows={4}
                maxLength={20_000}
                disabled={decisionBusy || !history.healthy}
                value={decisionNotes}
                onChange={(event) => setDecisionNotes(event.target.value)}
              />
            </label>
            <div className="remote-review-actions">
              <button className="btn primary" type="button" disabled={decisionBusy || !history.healthy} onClick={() => void recordDecision('accepted')}>Record accepted</button>
              <button className="btn danger" type="button" disabled={decisionBusy || !history.healthy} onClick={() => void recordDecision('rejected')}>Record rejected</button>
            </div>
            <p className="scenario-identity-note">
              Attribution uses this installation’s researcher identity; identity and timestamps are not authenticated.
            </p>
          </div>
        </>}
      </section>
    </section>
  )
}
