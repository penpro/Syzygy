import { describe, expect, it, vi } from 'vitest'
import { commitPolicyVersion } from './policyVersionModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import {
  SCENARIO_EVALUATION_CONTRACT_VERSION,
  SCENARIO_EVALUATION_PROMPT_VERSION,
  type ScenarioEvaluationAdapter,
} from './scenarioEvaluation'
import {
  controlScenarioRerunJob,
  createScenarioRerunJob,
  readScenarioRerunJob,
} from './scenarioRerunQueue'
import { runScenarioRerunQueue } from './scenarioRerunRunner'
import { createScenario } from './scenarioModel'
import { createProjectManifest } from './schema'

const project = createProjectManifest({ id: 'runner-project', documentId: 'runner-document', timestamp: 1 })

async function fixture(count = 2) {
  const doc = createProjectDocument(project)
  const shared = getProjectSharedTypes(doc)
  const scenarios = Array.from({ length: count }, (_, index) => createScenario(shared.scenarios, {
    id: `scenario-${index + 1}`, title: `Scenario ${index + 1}`, background: `Background ${index + 1}`,
    status: 'ready', authorId: 'alice', timestamp: index + 1, editId: `create-${index + 1}`,
    turns: [{ id: `turn-${index + 1}`, role: 'user', content: `Question ${index + 1}`, editId: `turn-edit-${index + 1}` }],
  }))
  const version = await commitPolicyVersion(shared.versions, shared.metadata, {
    projectId: project.id, expectedHeadVersionId: null,
    blocks: [{ kind: 'policy', policyId: 'rule', status: 'approved', text: 'Give a written answer.' }],
    scenarioIds: scenarios.map(({ id }) => id), participantId: 'alice', displayName: 'Alice', createdAt: 4,
  })
  const job = createScenarioRerunJob(shared.settings, {
    jobId: 'runner-job', project, policyVersion: version, providerId: 'local', requestedModelId: 'local-model',
    items: scenarios.map((scenario, index) => ({
      itemId: `item-${index + 1}`, scenario, runIdBase: `run-${index + 1}`, resultId: `result-${index + 1}`,
    })),
    authorId: 'alice', authorDisplayName: 'Alice', timestamp: 5,
  })
  controlScenarioRerunJob(shared.settings, shared.discussions, {
    eventId: 'start-job', jobId: job.definition.jobId, action: 'start', parentEventId: null,
    authorId: 'alice', timestamp: 6,
  })
  return { doc, shared, job }
}

function output(request: Parameters<ScenarioEvaluationAdapter['evaluate']>[0]) {
  return {
    contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
    promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
    jobId: request.jobId, itemId: request.itemId, attempt: request.attempt, runId: request.runId,
    providerId: request.providerId, requestedModelId: request.requestedModelId, executedModelId: request.requestedModelId,
    outcome: 'handled', response: 'Give a written answer.', rationale: 'The policy requires it.',
    uncertainty: 'No material uncertainty identified.',
  }
}

const options = (value: Awaited<ReturnType<typeof fixture>>, adapter: ScenarioEvaluationAdapter, signal = new AbortController().signal) => ({
  doc: value.doc, project, jobId: 'runner-job', authorId: 'alice', authorDisplayName: 'Alice',
  adapter, signal, now: (() => { let value = 10; return () => value++ })(),
  id: (() => { let value = 0; return () => `runner-event-${++value}` })(),
  itemTimeoutMs: 100, heartbeatMs: 10,
})

describe('supervised scenario rerun runner', () => {
  it('executes items sequentially and persists begin before provider work', async () => {
    const value = await fixture()
    let active = 0
    let maxActive = 0
    const adapter: ScenarioEvaluationAdapter = {
      providerId: 'local',
      async evaluate(request) {
        const item = readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')!
          .items.find(({ definition }) => definition.itemId === request.itemId)!
        expect(item.status).toBe('interrupted')
        active += 1; maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return output(request)
      },
    }
    const result = await runScenarioRerunQueue(options(value, adapter))
    expect(result).toMatchObject({ status: 'complete', stopReason: 'complete', completedItems: 2, totalItems: 2 })
    expect(maxActive).toBe(1)
    expect(readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')?.itemEvents)
      .toHaveLength(4)
  })

  it('records a sanitized failure and continues independent items', async () => {
    const value = await fixture()
    const adapter: ScenarioEvaluationAdapter = {
      providerId: 'local',
      async evaluate(request) {
        if (request.itemId === 'item-1') throw new Error('provider\u0000 exploded')
        return output(request)
      },
    }
    const result = await runScenarioRerunQueue(options(value, adapter))
    expect(result).toMatchObject({ status: 'running', stopReason: 'no-runnable-items', completedItems: 1, failedItems: 1 })
    const failed = readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')!.items[0]
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'provider-error' })
    expect(failed.errorMessage).not.toContain('\u0000')
  })

  it('aborts an active provider on pause and leaves the attempt resumable', async () => {
    const value = await fixture(1)
    const controller = new AbortController()
    const cancel = vi.fn(async () => undefined)
    const adapter: ScenarioEvaluationAdapter = {
      providerId: 'local', cancel,
      evaluate: (_request, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })),
    }
    const run = runScenarioRerunQueue({
      ...options(value, adapter, controller.signal),
      onProgress(progress) {
        if (progress.phase !== 'starting') return
        const current = readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')!
        controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
          eventId: 'pause-job', jobId: 'runner-job', action: 'pause',
          parentEventId: current.currentControlEventId, authorId: 'alice', timestamp: 20,
        })
        controller.abort()
      },
    })
    await expect(run).resolves.toMatchObject({ status: 'paused', stopReason: 'aborted', interruptedItems: 1 })
    expect(cancel).toHaveBeenCalledWith('run-1-a1')
  })

  it('resumes an interrupted attempt without writing another begin event', async () => {
    const value = await fixture(1)
    const controller = new AbortController()
    const interrupted: ScenarioEvaluationAdapter = {
      providerId: 'local',
      evaluate: (_request, signal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })),
    }
    const first = runScenarioRerunQueue({
      ...options(value, interrupted, controller.signal),
      onProgress(progress) { if (progress.phase === 'starting') controller.abort() },
    })
    await first
    const before = readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')!
    expect(before.itemEvents).toHaveLength(1)
    const resumed: ScenarioEvaluationAdapter = { providerId: 'local', async evaluate(request) { return output(request) } }
    let resumedEvent = 0
    await runScenarioRerunQueue({
      ...options(value, resumed), id: () => `resumed-event-${++resumedEvent}`,
    })
    const after = readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')!
    expect(after.status).toBe('complete')
    expect(after.itemEvents.filter(({ action }) => action === 'begin')).toHaveLength(1)
  })

  it('enforces the item deadline and rejects duplicate local runners', async () => {
    const value = await fixture(1)
    let release!: () => void
    const adapter: ScenarioEvaluationAdapter = {
      providerId: 'local',
      evaluate: (_request, signal) => new Promise((_resolve, reject) => {
        release = () => reject(new DOMException('cancelled', 'AbortError'))
        signal.addEventListener('abort', release, { once: true })
      }),
    }
    const first = runScenarioRerunQueue({ ...options(value, adapter), itemTimeoutMs: 5 })
    await expect(runScenarioRerunQueue(options(value, adapter))).rejects.toThrow('already executing')
    await expect(first).resolves.toMatchObject({ failedItems: 1, stopReason: 'no-runnable-items' })
    release()
    expect(readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'runner-job')?.items[0])
      .toMatchObject({ status: 'failed', errorCode: 'provider-timeout' })
  })
})
