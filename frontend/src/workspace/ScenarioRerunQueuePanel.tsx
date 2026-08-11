import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { desktopRuntimeAvailable, providerCredentialStatus, type RemoteProviderId } from '../tauri'
import { now, uid } from '../util'
import { readPolicyVersion, readPolicyVersionHead, type PolicyVersion } from './policyVersionModel'
import { getProjectSharedTypes } from './projectModel'
import {
  controlScenarioRerunJob,
  createScenarioRerunJob,
  inspectScenarioRerunQueues,
  listScenarioRerunJobs,
  readScenarioRerunJob,
  retryScenarioRerunItem,
  type ScenarioRerunJob,
  type ScenarioRerunResearchEvent,
} from './scenarioRerunQueue'
import { runScenarioRerunQueue, type ScenarioRerunRunnerProgress } from './scenarioRerunRunner'
import {
  createLocalScenarioEvaluationAdapter,
  createRemoteScenarioEvaluationAdapter,
  SCENARIO_EVALUATION_REMOTE_PROVIDERS,
} from './scenarioEvaluationRuntime'
import { listScenarios } from './scenarioModel'
import { ScenarioComparisonPanel } from './ScenarioComparisonPanel'
import type { ResearchProjectManifest } from './schema'
import type { ScenarioEvaluationProviderId } from './scenarioEvaluation'
import {
  attestScenarioRerunResearchEvent,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'

type QueuePhase = 'idle' | 'checking' | 'running' | 'cancelling' | 'complete' | 'error'

export function scenarioRerunAttributionMessage(result: ResearchEventAttributionResult): string {
  return result.status === 'signed-device'
    ? `Queue history saved with this installation’s signature · ${result.keyId.replace('ed25519-sha256:', '').slice(0, 12)}…`
    : `Queue history saved without a device signature · ${result.reason}`
}

export function ScenarioRerunAttributionStatus({ message }: { message: string }) {
  return message ? <p className="scenario-generation-note" role="status">{message}</p> : null
}

export function ScenarioRerunQueuePanel({ project, doc }: { project: ResearchProjectManifest; doc: Y.Doc }) {
  const settings = useStore((state) => state.settings)
  const loadedModel = useStore((state) => state.loadedModel)
  const researcherId = settings.researcherId
  const researcherName = settings.researcherName.trim()
  const [revision, setRevision] = useState(0)
  const [version, setVersion] = useState<PolicyVersion | null>(null)
  const [versionMessage, setVersionMessage] = useState('Checking the immutable policy head…')
  const [provider, setProvider] = useState<ScenarioEvaluationProviderId>('local')
  const [model, setModel] = useState(settings.model)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<QueuePhase>('idle')
  const [message, setMessage] = useState('Create a queue to rerun exact scenario revisions against one immutable policy version.')
  const [attributionMessage, setAttributionMessage] = useState('')
  const active = useRef<{ jobId: string; controller: AbortController } | null>(null)
  const attributionOperation = useRef(0)

  useEffect(() => {
    const update = () => setRevision((value) => value + 1)
    doc.on('update', update)
    return () => doc.off('update', update)
  }, [doc])

  useEffect(() => {
    attributionOperation.current += 1
    setAttributionMessage('')
    return () => { attributionOperation.current += 1 }
  }, [project.id, doc])

  const shared = getProjectSharedTypes(doc)
  const scenarios = listScenarios(shared.scenarios).filter(({ status }) => status !== 'archived')
  const jobs = listScenarioRerunJobs(shared.settings, shared.discussions).filter(({ definition }) =>
    definition.projectId === project.id)
  const inspection = inspectScenarioRerunQueues(shared.settings, shared.discussions, shared.scenarios)
  const localAvailable = settings.localAiEnabled && Boolean(loadedModel)

  useEffect(() => {
    let current = true
    const load = async () => {
      try {
        const head = readPolicyVersionHead(shared.metadata)
        if (!head) {
          if (current) { setVersion(null); setVersionMessage('Commit a policy version before creating a rerun queue.') }
          return
        }
        const next = await readPolicyVersion(shared.versions, head)
        if (!next || next.projectId !== project.id) throw new Error('The immutable policy head failed verification.')
        if (current) { setVersion(next); setVersionMessage(`Policy version ${next.versionId.slice(0, 12)}… is ready.`) }
      } catch (error) {
        if (current) { setVersion(null); setVersionMessage(error instanceof Error ? error.message : 'Policy version check failed.') }
      }
    }
    void load()
    return () => { current = false }
  }, [doc, project.id, revision])

  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size) return new Set([...current].filter((id) => scenarios.some((scenario) => scenario.id === id)))
      return new Set(scenarios.filter(({ status }) => status === 'ready').map(({ id }) => id))
    })
  }, [scenarios.map(({ id, status }) => `${id}:${status}`).join('|')])

  const chooseProvider = (next: ScenarioEvaluationProviderId) => {
    setProvider(next)
    setModel(next === 'local' ? settings.model :
      SCENARIO_EVALUATION_REMOTE_PROVIDERS.find(({ id }) => id === next)?.defaultModel ?? '')
  }

  const identity = () => {
    if (!researcherId || !researcherName) throw new Error('Set a researcher name in Settings before creating a shared rerun queue.')
    return { authorId: researcherId, authorDisplayName: researcherName }
  }

  const showAttribution = (operation: number, result: ResearchEventAttributionResult) => {
    if (attributionOperation.current === operation) {
      setAttributionMessage(scenarioRerunAttributionMessage(result))
    }
  }

  const publishAttribution = (record: ScenarioRerunResearchEvent) => {
    const operation = attributionOperation.current + 1
    attributionOperation.current = operation
    setAttributionMessage('Queue history saved. Saving device signature…')
    void attestScenarioRerunResearchEvent(doc, project.id, record).then(
      (result) => showAttribution(operation, result),
      () => {
        if (attributionOperation.current === operation) {
          setAttributionMessage('Queue history saved without a device signature · signing unavailable')
        }
      },
    )
  }

  const create = () => {
    setPhase('idle')
    try {
      const author = identity()
      if (!version) throw new Error(versionMessage)
      if (!inspection.healthy) throw new Error(`Rerun queue history failed integrity checks: ${inspection.issues.join('; ')}`)
      if (!model.trim()) throw new Error('Choose a model ID first.')
      const selected = scenarios.filter(({ id }) => selectedIds.has(id))
      if (!selected.length) throw new Error('Select at least one scenario.')
      const jobId = `scenario-rerun-${uid()}`
      const created = createScenarioRerunJob(shared.settings, {
        jobId, project, policyVersion: version, providerId: provider, requestedModelId: model.trim(),
        items: selected.map((scenario) => ({
          itemId: `scenario-item-${uid()}`, scenario,
          runIdBase: `scenario-evaluation-${uid()}`, resultId: `scenario-result-${uid()}`,
        })),
        ...author, timestamp: now(),
      })
      publishAttribution({ recordType: 'definition', definition: created.definition })
      setMessage(`Paused queue created for ${selected.length} exact scenario revision${selected.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setPhase('error')
      setMessage(error instanceof Error ? error.message : 'Could not create the rerun queue.')
    }
  }

  const execute = async (jobId: string) => {
    if (active.current) return
    const job = readScenarioRerunJob(shared.settings, shared.discussions, jobId)
    if (!job) { setPhase('error'); setMessage('The rerun queue failed integrity checks.'); return }
    const controller = new AbortController()
    active.current = { jobId, controller }
    const runAttributionOperation = attributionOperation.current + 1
    attributionOperation.current = runAttributionOperation
    setPhase(job.definition.providerId === 'local' ? 'running' : 'checking')
    setMessage(job.definition.providerId === 'local' ? 'Running the queue locally…' : 'Checking the provider key…')
    try {
      const author = identity()
      if (job.definition.providerId === 'local' && !localAvailable) {
        throw new Error('Local AI is off or no text model is loaded. The paused queue is preserved.')
      }
      if (job.definition.providerId !== 'local') {
        if (!desktopRuntimeAvailable()) throw new Error('API reruns are available in the installed app.')
        if (!await providerCredentialStatus(job.definition.providerId as RemoteProviderId)) {
          const name = SCENARIO_EVALUATION_REMOTE_PROVIDERS.find(({ id }) => id === job.definition.providerId)?.name ?? job.definition.providerId
          throw new Error(`Add a ${name} key in Settings first. The queue is preserved.`)
        }
        setPhase('running')
        setMessage('Each exact policy/scenario pair requires its native Send once approval.')
      }
      const adapter = job.definition.providerId === 'local'
        ? createLocalScenarioEvaluationAdapter(settings)
        : createRemoteScenarioEvaluationAdapter(job.definition.providerId as RemoteProviderId)
      const result = await runScenarioRerunQueue({
        doc, project, jobId, ...author, adapter, signal: controller.signal,
        attribution: (record) => {
          if (attributionOperation.current === runAttributionOperation) {
            setAttributionMessage('Queue history saved. Saving device signature…')
          }
          return attestScenarioRerunResearchEvent(doc, project.id, record)
        },
        onAttribution: (_record, attribution) => showAttribution(runAttributionOperation, attribution),
        onProgress: (progress: ScenarioRerunRunnerProgress) => {
          setPhase('running')
          setMessage(`${progress.completedItems}/${progress.totalItems} complete · ${progress.failedItems} failed · ${progress.phase === 'heartbeat' ? 'provider still working' : progress.phase.replace(/-/g, ' ')}`)
        },
      })
      if (result.stopReason === 'complete') {
        setPhase('complete'); setMessage(`Queue complete: ${result.completedItems}/${result.totalItems} results saved.`)
      } else if (result.stopReason === 'no-runnable-items') {
        setPhase(result.failedItems ? 'error' : 'idle')
        setMessage(`${result.completedItems}/${result.totalItems} complete; ${result.failedItems} failed item${result.failedItems === 1 ? '' : 's'} await retry or cancellation.`)
      } else {
        setPhase('idle'); setMessage(`Queue ${result.stopReason}; exact progress is preserved.`)
      }
    } catch (error) {
      setPhase(controller.signal.aborted ? 'idle' : 'error')
      setMessage(controller.signal.aborted ? 'Queue stopped; the active attempt remains resumable.' :
        error instanceof Error ? error.message : 'Scenario rerun failed.')
    } finally {
      if (active.current?.jobId === jobId) active.current = null
    }
  }

  const start = async (job: ScenarioRerunJob) => {
    try {
      const author = identity()
      if (job.definition.providerId === 'local' && !localAvailable) {
        throw new Error('Local AI is off or no text model is loaded. The paused queue is preserved.')
      }
      if (job.definition.providerId !== 'local') {
        if (!desktopRuntimeAvailable()) throw new Error('API reruns are available in the installed app.')
        if (!await providerCredentialStatus(job.definition.providerId as RemoteProviderId)) {
          const name = SCENARIO_EVALUATION_REMOTE_PROVIDERS.find(({ id }) => id === job.definition.providerId)?.name ?? job.definition.providerId
          throw new Error(`Add a ${name} key in Settings first. The paused queue is preserved.`)
        }
      }
      const eventId = `scenario-control-${uid()}`
      const started = controlScenarioRerunJob(shared.settings, shared.discussions, {
        eventId, jobId: job.definition.jobId, action: 'start',
        parentEventId: job.currentControlEventId, authorId: author.authorId, timestamp: now(),
      })
      const event = started.controls.find((value) => value.eventId === eventId)
      if (!event) throw new Error('Scenario rerun start event failed post-write verification')
      publishAttribution({ recordType: 'control', event })
      void execute(job.definition.jobId)
    } catch (error) {
      setPhase('error'); setMessage(error instanceof Error ? error.message : 'Could not start the queue.')
    }
  }

  const stop = (job: ScenarioRerunJob, action: 'pause' | 'cancel') => {
    try {
      const author = identity()
      setPhase('cancelling')
      const eventId = `scenario-control-${uid()}`
      const controlled = controlScenarioRerunJob(shared.settings, shared.discussions, {
        eventId, jobId: job.definition.jobId, action,
        parentEventId: job.currentControlEventId, authorId: author.authorId, timestamp: now(),
      })
      const event = controlled.controls.find((value) => value.eventId === eventId)
      if (!event) throw new Error(`Scenario rerun ${action} event failed post-write verification`)
      publishAttribution({ recordType: 'control', event })
      if (active.current?.jobId === job.definition.jobId) active.current.controller.abort()
      setMessage(`${action === 'pause' ? 'Paused' : 'Cancelled'} queue; completed results remain shared.`)
    } catch (error) {
      setPhase('error'); setMessage(error instanceof Error ? error.message : `Could not ${action} the queue.`)
    }
  }

  const retry = (job: ScenarioRerunJob, itemId: string) => {
    try {
      const author = identity()
      const item = job.items.find(({ definition }) => definition.itemId === itemId)
      if (!item) throw new Error('Queue item changed; reload and retry.')
      const eventId = `scenario-item-${uid()}`
      const retried = retryScenarioRerunItem(shared.settings, shared.discussions, {
        eventId, jobId: job.definition.jobId, itemId,
        expectedCurrentEventId: item.currentEventId!, attempt: item.attempt,
        authorId: author.authorId, timestamp: now(),
      })
      const event = retried.itemEvents.find((value) => value.eventId === eventId)
      if (!event) throw new Error('Scenario rerun retry event failed post-write verification')
      publishAttribution({ recordType: 'item', event })
      setPhase('idle'); setMessage('Failed item is ready for its next bounded attempt.')
    } catch (error) {
      setPhase('error'); setMessage(error instanceof Error ? error.message : 'Could not retry the item.')
    }
  }

  const runningFingerprint = useMemo(() => jobs.map((job) =>
    `${job.definition.jobId}:${job.status}:${job.items.map(({ status, attempt }) => `${status}:${attempt}`).join(',')}`).join('|'), [jobs])
  useEffect(() => {
    const resumable = jobs.find((job) => job.status === 'running' && job.definition.createdBy === researcherId &&
      job.definition.providerId === 'local' && localAvailable && job.items.some(({ status }) => status === 'pending' || status === 'interrupted'))
    if (resumable && !active.current) void execute(resumable.definition.jobId)
  }, [runningFingerprint, researcherId, localAvailable])

  useEffect(() => () => active.current?.controller.abort(), [])

  return (
    <section className="scenario-generator" aria-label="Versioned scenario rerun queues">
      <div className="scenario-section-heading">
        <h3>Versioned scenario reruns</h3>
        <span className="mono">{jobs.length} queue{jobs.length === 1 ? '' : 's'}</span>
      </div>
      <p className="scenario-generation-intro">
        Evaluate exact shared scenario revisions against one immutable policy version. Queues survive restart,
        execute one item at a time, and retain uncertainty plus provider provenance.
      </p>
      <p className="scenario-generation-note" role="status">{versionMessage}</p>
      <label>Model provider<select value={provider} disabled={Boolean(active.current)} onChange={(event) => chooseProvider(event.target.value as ScenarioEvaluationProviderId)}>
        <option value="local">Local model · this computer</option>
        {SCENARIO_EVALUATION_REMOTE_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} API · Send once per item</option>)}
      </select></label>
      <label>Model ID<input value={model} maxLength={200} disabled={Boolean(active.current)} spellCheck={false} onChange={(event) => setModel(event.target.value)} /></label>
      <fieldset className="scenario-form compact">
        <legend>Scenario revisions</legend>
        {scenarios.length === 0 && <p className="scenario-state">Add a non-archived scenario first.</p>}
        {scenarios.map((scenario) => <label key={scenario.id}>
          <input type="checkbox" checked={selectedIds.has(scenario.id)} onChange={(event) => setSelectedIds((current) => {
            const next = new Set(current); if (event.target.checked) next.add(scenario.id); else next.delete(scenario.id); return next
          })} /> {scenario.title} <span className="mono">{scenario.status}</span>
        </label>)}
      </fieldset>
      <div className="scenario-actions">
        <button className="btn sm" type="button" disabled={!version || !model.trim() || !selectedIds.size || (provider === 'local' && !localAvailable)} onClick={create}>Create paused queue</button>
      </div>
      {provider === 'local' && !localAvailable && <p className="scenario-generation-note">Local AI is off or no text model is loaded. Existing shared queues and results remain available.</p>}
      {provider !== 'local' && <p className="scenario-generation-note">Only the exact policy version and one exact scenario revision are prepared for each native Send once approval.</p>}
      <div className={`scenario-generation-status ${phase}`} role="status">{message}</div>
      <ScenarioRerunAttributionStatus message={attributionMessage} />
      {!inspection.healthy && <div className="scenario-state error" role="alert">Queue integrity: {inspection.issues.join('; ')}</div>}
      {jobs.length > 0 && <ol className="scenario-responses" aria-label="Shared scenario rerun queues">
        {[...jobs].reverse().map((job) => {
          const mine = job.definition.createdBy === researcherId
          const completed = job.items.filter(({ status }) => status === 'complete').length
          return <li key={job.definition.jobId}>
            <div className="scenario-turn-meta mono">{job.status.toUpperCase()} · {completed}/{job.items.length} · {job.definition.providerId} · {job.definition.requestedModelId}</div>
            <p>Policy {job.definition.policyVersionId.slice(0, 12)}… · created by {job.definition.createdByDisplayName}</p>
            {mine && <div className="scenario-actions">
              {job.status === 'paused' && <button className="btn sm" type="button" onClick={() => void start(job)}>Start / resume</button>}
              {job.status === 'running' && !active.current && <button className="btn sm" type="button" onClick={() => void execute(job.definition.jobId)}>Continue queue</button>}
              {job.status === 'running' && <button className="btn ghost sm" type="button" onClick={() => stop(job, 'pause')}>Pause</button>}
              {(job.status === 'running' || job.status === 'paused') && <button className="btn ghost danger sm" type="button" onClick={() => stop(job, 'cancel')}>Cancel</button>}
            </div>}
            <ol className="scenario-response-lineage">
              {job.items.map((item) => <li key={item.definition.itemId}>
                <div className="scenario-turn-meta mono">{item.status.toUpperCase()} · attempt {item.attempt}/{job.definition.maxAttempts} · scenario {item.definition.scenarioId}</div>
                {item.errorMessage && <p>{item.errorCode}: {item.errorMessage}</p>}
                {mine && item.status === 'failed' && item.attempt < job.definition.maxAttempts && <button className="btn sm" type="button" onClick={() => retry(job, item.definition.itemId)}>Retry item</button>}
                {item.result && <>
                  <p><strong>{item.result.outcome.toUpperCase()}:</strong> {item.result.response}</p>
                  <p><strong>Rationale:</strong> {item.result.rationale}</p>
                  <p><strong>Uncertainty:</strong> {item.result.uncertainty}</p>
                  <div className="scenario-turn-meta mono">{item.result.executedModelId} · {item.result.authorDisplayName} · run {item.result.runId}</div>
                </>}
              </li>)}
            </ol>
          </li>
        })}
      </ol>}
      <ScenarioComparisonPanel project={project} doc={doc} jobs={jobs} />
      <p className="scenario-identity-note">Queue control uses this installation’s researcher identity; identity is not authenticated. Collaborators can inspect every shared result.</p>
    </section>
  )
}
