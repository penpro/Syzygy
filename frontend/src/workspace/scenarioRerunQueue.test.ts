import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { commitPolicyVersion, readPolicyVersion } from './policyVersionModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import {
  buildScenarioEvaluationRequest,
  SCENARIO_EVALUATION_CONTRACT_VERSION,
  SCENARIO_EVALUATION_PROMPT_VERSION,
  type ScenarioEvaluationOutput,
} from './scenarioEvaluation'
import {
  beginScenarioRerunItem,
  completeScenarioRerunItem,
  controlScenarioRerunJob,
  createScenarioRerunJob,
  failScenarioRerunItem,
  inspectScenarioRerunQueues,
  readScenarioEvaluationResult,
  readScenarioRerunControlEvent,
  readScenarioRerunDefinition,
  readScenarioRerunItemEvent,
  readScenarioRerunJob,
  retryScenarioRerunItem,
  scenarioRerunResearchEventSha256,
} from './scenarioRerunQueue'
import { createScenario, readScenario, updateScenario } from './scenarioModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'queue-project', documentId: 'queue-document', timestamp: 1 })

async function fixture(maxAttempts = 3) {
  const doc = createProjectDocument(manifest)
  const shared = getProjectSharedTypes(doc)
  const scenario = createScenario(shared.scenarios, {
    id: 'denial-case', title: 'Denial case', background: 'A resident is denied service.', status: 'ready',
    authorId: 'alice', timestamp: 1, editId: 'scenario-create',
    turns: [{ id: 'question', role: 'user', content: 'How do I appeal?', editId: 'turn-create' }],
  })
  const version = await commitPolicyVersion(shared.versions, shared.metadata, {
    projectId: manifest.id, expectedHeadVersionId: null,
    blocks: [{ kind: 'policy', policyId: 'appeal-rule', status: 'approved', text: 'Every denial receives a written appeal path.' }],
    scenarioIds: [scenario.id], participantId: 'alice', displayName: 'Alice', createdAt: 2,
  })
  const job = createScenarioRerunJob(shared.settings, {
    jobId: 'queue-job', project: manifest, policyVersion: version, providerId: 'local',
    requestedModelId: 'local-model', maxAttempts,
    items: [{ itemId: 'queue-item', scenario, runIdBase: 'queue-run', resultId: 'queue-result' }],
    authorId: 'alice', authorDisplayName: 'Alice', timestamp: 3,
  })
  return { doc, shared, scenario, version, job }
}

const start = (value: Awaited<ReturnType<typeof fixture>>, eventId = 'control-start', parentEventId: string | null = null) =>
  controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
    eventId, jobId: 'queue-job', action: 'start', parentEventId, authorId: 'alice', timestamp: 4,
  })
const begin = (value: Awaited<ReturnType<typeof fixture>>, attempt = 1, expectedCurrentEventId: string | null = null) =>
  beginScenarioRerunItem(value.shared.settings, value.shared.discussions, {
    eventId: `item-begin-${attempt}`, jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId,
    attempt, authorId: 'alice', timestamp: 5 + attempt,
  })
const request = (value: Awaited<ReturnType<typeof fixture>>, attempt = 1) => buildScenarioEvaluationRequest({
  jobId: 'queue-job', itemId: 'queue-item', attempt, runId: `queue-run-a${attempt}`,
  providerId: 'local', requestedModelId: 'local-model', project: manifest,
  policyVersion: value.version, scenario: readScenario(value.shared.scenarios, 'denial-case')!,
})
const output = (attempt = 1): ScenarioEvaluationOutput => ({
  contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
  promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
  jobId: 'queue-job', itemId: 'queue-item', attempt, runId: `queue-run-a${attempt}`,
  providerId: 'local', requestedModelId: 'local-model', executedModelId: 'local-model',
  outcome: 'handled', response: 'Provide written appeal instructions.',
  rationale: 'The policy requires an appeal path.', uncertainty: 'No deadline is specified.',
})

describe('persistent scenario rerun queue', () => {
  it('creates a bounded paused version/scenario snapshot and uses exact-parent creator-only controls', async () => {
    const value = await fixture()
    expect(value.job).toMatchObject({ status: 'paused', definition: { policyVersionId: value.version.versionId, maxAttempts: 3 } })
    expect(value.job.items[0]).toMatchObject({ status: 'pending', attempt: 1 })
    const running = start(value)
    expect(running.status).toBe('running')
    expect(() => controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'bad-pause', jobId: 'queue-job', action: 'pause', parentEventId: 'wrong', authorId: 'alice', timestamp: 5,
    })).toThrow('control changed')
    expect(() => controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'bob-pause', jobId: 'queue-job', action: 'pause', parentEventId: 'control-start', authorId: 'bob', timestamp: 5,
    })).toThrow('creator')
    expect(start(value)).toEqual(running)
  })

  it('projects begin/failure/retry attempts and enforces the configured ceiling', async () => {
    const value = await fixture(2); start(value); begin(value)
    let job = failScenarioRerunItem(value.shared.settings, value.shared.discussions, {
      eventId: 'item-fail-1', jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId: 'item-begin-1',
      attempt: 1, errorCode: 'provider-timeout', errorMessage: 'Provider timed out.', authorId: 'alice', timestamp: 7,
    })
    expect(job.items[0]).toMatchObject({ status: 'failed', attempt: 1, errorCode: 'provider-timeout' })
    job = retryScenarioRerunItem(value.shared.settings, value.shared.discussions, {
      eventId: 'item-retry-1', jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId: 'item-fail-1',
      attempt: 1, authorId: 'alice', timestamp: 8,
    })
    expect(job.items[0]).toMatchObject({ status: 'pending', attempt: 2 })
    begin(value, 2, 'item-retry-1')
    failScenarioRerunItem(value.shared.settings, value.shared.discussions, {
      eventId: 'item-fail-2', jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId: 'item-begin-2',
      attempt: 2, errorCode: 'invalid-output', errorMessage: 'Invalid result.', authorId: 'alice', timestamp: 10,
    })
    expect(() => retryScenarioRerunItem(value.shared.settings, value.shared.discussions, {
      eventId: 'item-retry-2', jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId: 'item-fail-2',
      attempt: 2, authorId: 'alice', timestamp: 11,
    })).toThrow('Cannot retry')
  })

  it('writes the immutable result and completion together and refuses stale scenario state', async () => {
    const value = await fixture(); start(value); begin(value)
    const updates: Uint8Array[] = []
    value.doc.on('update', (update) => updates.push(update))
    const completed = await completeScenarioRerunItem(value.doc, request(value), output(), {
      eventId: 'item-complete-1', resultId: 'queue-result', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 9,
    })
    expect(completed.status).toBe('complete')
    expect(completed.items[0]).toMatchObject({ status: 'complete', result: { outcome: 'handled', resultId: 'queue-result' } })
    const replayed = await completeScenarioRerunItem(value.doc, request(value), output(), {
      eventId: 'item-complete-1', resultId: 'queue-result', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 9,
    })
    expect(replayed).toEqual(completed)
    expect(updates).toHaveLength(1)
    expect(inspectScenarioRerunQueues(value.shared.settings, value.shared.discussions, value.shared.scenarios))
      .toMatchObject({ healthy: true, jobCount: 1, completeCount: 1, completedItemCount: 1 })

    const stale = await fixture(); start(stale); begin(stale)
    const staleRequest = request(stale)
    updateScenario(stale.shared.scenarios, {
      id: 'denial-case', authorId: 'bob', timestamp: 8, editId: 'scenario-change', changes: { background: 'Changed.' },
    })
    await expect(completeScenarioRerunItem(stale.doc, staleRequest, output(), {
      eventId: 'item-complete-stale', resultId: 'queue-result', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 9,
    })).rejects.toThrow('Scenario changed')
    expect(readScenarioRerunJob(stale.shared.settings, stale.shared.discussions, 'queue-job')?.items[0].status).toBe('interrupted')
  })

  it('reads and hashes exact detached records only through a valid complete queue', async () => {
    const value = await fixture(); start(value); begin(value)
    const completed = await completeScenarioRerunItem(value.doc, request(value), output(), {
      eventId: 'item-complete-hash', resultId: 'queue-result', authorId: 'alice',
      authorDisplayName: 'Alice', timestamp: 9,
    })
    const definition = readScenarioRerunDefinition(value.shared.settings, value.shared.discussions, 'queue-job')!
    const control = readScenarioRerunControlEvent(
      value.shared.settings, value.shared.discussions, 'queue-job', 'control-start',
    )!
    const item = readScenarioRerunItemEvent(
      value.shared.settings, value.shared.discussions, 'queue-job', 'queue-item', 'item-complete-hash',
    )!
    const result = readScenarioEvaluationResult(
      value.shared.settings, value.shared.discussions, 'queue-job', 'queue-result',
    )!
    const records = [
      { recordType: 'definition' as const, definition },
      { recordType: 'control' as const, event: control },
      { recordType: 'item' as const, event: item },
      { recordType: 'result' as const, result },
    ]
    const hashes = await Promise.all(records.map(scenarioRerunResearchEventSha256))
    expect(hashes.every((hash) => /^[A-Za-z0-9_-]{43}$/.test(hash))).toBe(true)
    expect(new Set(hashes).size).toBe(4)
    expect(await scenarioRerunResearchEventSha256({
      recordType: 'result', result: { ...result, rationale: `${result.rationale} changed` },
    })).not.toBe(hashes[3])

    definition.createdByDisplayName = 'Detached mutation'
    result.response = 'Detached mutation'
    expect(readScenarioRerunDefinition(value.shared.settings, value.shared.discussions, 'queue-job')?.createdByDisplayName)
      .toBe('Alice')
    expect(readScenarioEvaluationResult(value.shared.settings, value.shared.discussions, 'queue-job', 'queue-result')?.response)
      .toBe(completed.items[0].result?.response)
  })

  it('reopens an interrupted begin and completes once with the same attempt identity', async () => {
    const value = await fixture(); start(value); begin(value)
    const reopened = new Y.Doc({ guid: manifest.documentId })
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(value.doc))
    const shared = getProjectSharedTypes(reopened)
    const restored = readScenarioRerunJob(shared.settings, shared.discussions, 'queue-job')!
    expect(restored).toMatchObject({ status: 'running', items: [{ status: 'interrupted', attempt: 1 }] })
    beginScenarioRerunItem(shared.settings, shared.discussions, {
      eventId: 'item-begin-1', jobId: 'queue-job', itemId: 'queue-item', expectedCurrentEventId: null,
      attempt: 1, authorId: 'alice', timestamp: 6,
    })
    const version = await readPolicyVersion(shared.versions, value.version.versionId)
    const scenario = readScenario(shared.scenarios, 'denial-case')
    const restoredRequest = buildScenarioEvaluationRequest({
      jobId: 'queue-job', itemId: 'queue-item', attempt: 1, runId: 'queue-run-a1', providerId: 'local',
      requestedModelId: 'local-model', project: manifest, policyVersion: version!, scenario: scenario!,
    })
    const done = await completeScenarioRerunItem(reopened, restoredRequest, output(), {
      eventId: 'item-complete-1', resultId: 'queue-result', authorId: 'alice', authorDisplayName: 'Alice', timestamp: 9,
    })
    expect(done.items).toHaveLength(1)
    expect(done.items[0]).toMatchObject({ status: 'complete', attempt: 1 })
  })

  it('pauses and resumes without erasing an interrupted item, then supports terminal cancellation', async () => {
    const value = await fixture(); start(value); begin(value)
    let job = controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'control-pause', jobId: 'queue-job', action: 'pause', parentEventId: 'control-start', authorId: 'alice', timestamp: 7,
    })
    expect(job).toMatchObject({ status: 'paused', items: [{ status: 'interrupted' }] })
    expect(() => failScenarioRerunItem(value.shared.settings, value.shared.discussions, {
      eventId: 'item-fail-paused', jobId: 'queue-job', itemId: 'queue-item',
      expectedCurrentEventId: 'item-begin-1', attempt: 1, errorCode: 'provider-error',
      errorMessage: 'Provider failed after pause.', authorId: 'alice', timestamp: 8,
    })).toThrow('Cannot fail')
    job = controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'control-resume', jobId: 'queue-job', action: 'start', parentEventId: 'control-pause', authorId: 'alice', timestamp: 8,
    })
    expect(job.status).toBe('running')
    job = controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'control-cancel', jobId: 'queue-job', action: 'cancel', parentEventId: 'control-resume', authorId: 'alice', timestamp: 9,
    })
    expect(job.status).toBe('cancelled')
    expect(() => controlScenarioRerunJob(value.shared.settings, value.shared.discussions, {
      eventId: 'control-restart', jobId: 'queue-job', action: 'start', parentEventId: 'control-cancel', authorId: 'alice', timestamp: 10,
    })).toThrow('Cannot start')
  })

  it('rejects duplicate execution identities and foreign collaborative events', async () => {
    const value = await fixture()
    const second = createScenario(value.shared.scenarios, {
      id: 'second-case', title: 'Second case', background: '', status: 'ready',
      authorId: 'alice', timestamp: 4, editId: 'second-create',
    })
    expect(() => createScenarioRerunJob(value.shared.settings, {
      jobId: 'duplicate-job', project: manifest, policyVersion: value.version, providerId: 'local',
      requestedModelId: 'local-model',
      items: [
        { itemId: 'one', scenario: value.scenario, runIdBase: 'same-run', resultId: 'result-one' },
        { itemId: 'two', scenario: second, runIdBase: 'same-run', resultId: 'result-two' },
      ],
      authorId: 'alice', authorDisplayName: 'Alice', timestamp: 5,
    })).toThrow('Invalid scenario rerun job')

    const bucket = Array.from(value.shared.settings.values()).find((entry) =>
      entry instanceof Y.Map && entry.get('jobId') === 'queue-job') as Y.Map<unknown>
    ;(bucket.get('itemEvents') as Y.Map<unknown>).set('hostile:foreign', {
      schemaVersion: 1, eventId: 'foreign-event', jobId: 'queue-job', itemId: 'foreign-item',
      action: 'begin', parentEventId: null, attempt: 1, resultId: null, errorCode: null,
      errorMessage: null, authorId: 'alice', timestamp: 6,
    })
    expect(readScenarioRerunJob(value.shared.settings, value.shared.discussions, 'queue-job')).toBeNull()
    expect(inspectScenarioRerunQueues(value.shared.settings, value.shared.discussions, value.shared.scenarios).healthy).toBe(false)
  })
})
