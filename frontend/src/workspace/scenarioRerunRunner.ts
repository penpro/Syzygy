import type * as Y from 'yjs'
import {
  buildScenarioEvaluationRequest,
  runScenarioEvaluation,
  type ScenarioEvaluationAdapter,
} from './scenarioEvaluation'
import { readPolicyVersion } from './policyVersionModel'
import { getProjectSharedTypes } from './projectModel'
import {
  beginScenarioRerunItem,
  completeScenarioRerunItem,
  failScenarioRerunItem,
  readScenarioRerunJob,
  type ScenarioRerunResearchEvent,
  type ScenarioRerunJobStatus,
} from './scenarioRerunQueue'
import { scenarioGenerationRevision } from './scenarioGeneration'
import { readScenario } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'
import {
  attestScenarioRerunResearchEvent,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'

export const SCENARIO_RERUN_ITEM_TIMEOUT_MS = 120_000
export const SCENARIO_RERUN_HEARTBEAT_MS = 30_000

export type ScenarioRerunRunnerPhase =
  'starting' | 'heartbeat' | 'completed-item' | 'failed-item' | 'stopped'

export interface ScenarioRerunRunnerProgress {
  phase: ScenarioRerunRunnerPhase
  jobId: string
  itemId: string | null
  attempt: number | null
  completedItems: number
  failedItems: number
  totalItems: number
  elapsedMs: number
}

export interface ScenarioRerunRunnerResult {
  jobId: string
  status: ScenarioRerunJobStatus
  stopReason: 'complete' | 'paused' | 'cancelled' | 'no-runnable-items' | 'aborted'
  completedItems: number
  failedItems: number
  interruptedItems: number
  totalItems: number
}

export interface ScenarioRerunRunnerOptions {
  doc: Y.Doc
  project: ResearchProjectManifest
  jobId: string
  authorId: string
  authorDisplayName: string
  adapter: ScenarioEvaluationAdapter
  signal: AbortSignal
  now?: () => number
  id?: () => string
  itemTimeoutMs?: number
  heartbeatMs?: number
  onProgress?: (progress: ScenarioRerunRunnerProgress) => void
  attribution?: (record: ScenarioRerunResearchEvent) => Promise<ResearchEventAttributionResult>
  onAttribution?: (record: ScenarioRerunResearchEvent, result: ResearchEventAttributionResult) => void
}

const active = new WeakMap<Y.Doc, Set<string>>()

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function safeError(error: unknown, timedOut: boolean): { code: string; message: string } {
  if (timedOut) return { code: 'provider-timeout', message: 'Provider exceeded the two-minute item deadline.' }
  const raw = error instanceof Error ? error.message : 'Provider evaluation failed.'
  const message = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || 'Provider evaluation failed.'
  const code = /invalid|schema|envelope|route|response/i.test(message) ? 'invalid-output' : 'provider-error'
  return { code, message }
}

function snapshotResult(
  jobId: string,
  status: ScenarioRerunJobStatus,
  stopReason: ScenarioRerunRunnerResult['stopReason'],
  items: Array<{ status: string }>,
): ScenarioRerunRunnerResult {
  return {
    jobId, status, stopReason, totalItems: items.length,
    completedItems: items.filter(({ status: value }) => value === 'complete').length,
    failedItems: items.filter(({ status: value }) => value === 'failed').length,
    interruptedItems: items.filter(({ status: value }) => value === 'interrupted').length,
  }
}

export async function runScenarioRerunQueue(options: ScenarioRerunRunnerOptions): Promise<ScenarioRerunRunnerResult> {
  const running = active.get(options.doc) ?? new Set<string>()
  if (running.has(options.jobId)) throw new Error('This scenario rerun queue is already executing in this app')
  running.add(options.jobId)
  active.set(options.doc, running)

  const now = options.now ?? Date.now
  const id = options.id ?? (() => crypto.randomUUID())
  const timeoutMs = Math.max(1, Math.min(options.itemTimeoutMs ?? SCENARIO_RERUN_ITEM_TIMEOUT_MS, SCENARIO_RERUN_ITEM_TIMEOUT_MS))
  const heartbeatMs = Math.max(1, Math.min(options.heartbeatMs ?? SCENARIO_RERUN_HEARTBEAT_MS, SCENARIO_RERUN_HEARTBEAT_MS))
  const startedAt = now()
  const shared = getProjectSharedTypes(options.doc)

  const attribute = async (record: ScenarioRerunResearchEvent) => {
    try {
      const result = await (options.attribution
        ? options.attribution(record)
        : attestScenarioRerunResearchEvent(options.doc, options.project.id, record))
      options.onAttribution?.(record, result)
    } catch {
      // The queue mutation is authoritative. Device attribution is explicit and best-effort.
    }
  }

  const progress = (phase: ScenarioRerunRunnerPhase, itemId: string | null, attempt: number | null) => {
    const current = readScenarioRerunJob(shared.settings, shared.discussions, options.jobId)
    if (!current) return
    options.onProgress?.({
      phase, jobId: options.jobId, itemId, attempt, totalItems: current.items.length,
      completedItems: current.items.filter(({ status }) => status === 'complete').length,
      failedItems: current.items.filter(({ status }) => status === 'failed').length,
      elapsedMs: Math.max(0, now() - startedAt),
    })
  }

  try {
    while (true) {
      const job = readScenarioRerunJob(shared.settings, shared.discussions, options.jobId)
      if (!job) throw new Error('Scenario rerun queue failed integrity checks')
      if (job.definition.projectId !== options.project.id || job.definition.documentId !== options.project.documentId ||
        options.doc.guid !== options.project.documentId) throw new Error('Scenario rerun project identity mismatch')
      if (job.definition.createdBy !== options.authorId) throw new Error('Only the queue creator can execute this rerun')
      if (job.definition.providerId !== options.adapter.providerId) throw new Error('Scenario rerun provider route mismatch')
      if (job.status === 'complete') return snapshotResult(options.jobId, job.status, 'complete', job.items)
      if (job.status === 'paused') return snapshotResult(options.jobId, job.status, 'paused', job.items)
      if (job.status === 'cancelled') return snapshotResult(options.jobId, job.status, 'cancelled', job.items)
      if (options.signal.aborted) return snapshotResult(options.jobId, job.status, 'aborted', job.items)

      const item = job.items.find(({ status }) => status === 'pending' || status === 'interrupted')
      if (!item) return snapshotResult(options.jobId, job.status, 'no-runnable-items', job.items)
      const version = await readPolicyVersion(shared.versions, job.definition.policyVersionId)
      if (!version || version.projectId !== options.project.id) throw new Error('Scenario rerun policy version failed verification')
      const scenario = readScenario(shared.scenarios, item.definition.scenarioId)
      if (!scenario || scenarioGenerationRevision(scenario) !== item.definition.scenarioRevision) {
        throw new Error('Scenario changed after this rerun queue was created; create a new queue')
      }
      const request = buildScenarioEvaluationRequest({
        jobId: job.definition.jobId,
        itemId: item.definition.itemId,
        attempt: item.attempt,
        runId: `${item.definition.runIdBase}-a${item.attempt}`,
        providerId: job.definition.providerId,
        requestedModelId: job.definition.requestedModelId,
        project: options.project,
        policyVersion: version,
        scenario,
      })
      if (item.status === 'pending') {
        const eventId = id()
        const begun = beginScenarioRerunItem(shared.settings, shared.discussions, {
          eventId, jobId: job.definition.jobId, itemId: item.definition.itemId,
          expectedCurrentEventId: item.currentEventId, attempt: item.attempt,
          authorId: options.authorId, timestamp: now(),
        })
        const event = begun.itemEvents.find((value) => value.eventId === eventId)
        if (!event) throw new Error('Scenario rerun begin event failed post-write verification')
        await attribute({ recordType: 'item', event })
      }
      progress('starting', item.definition.itemId, item.attempt)

      const controller = new AbortController()
      let timedOut = false
      const abort = () => controller.abort(options.signal.reason)
      options.signal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      const heartbeat = setInterval(() => progress('heartbeat', item.definition.itemId, item.attempt), heartbeatMs)
      const cancelProvider = () => { void options.adapter.cancel?.(request.runId).catch(() => undefined) }
      controller.signal.addEventListener('abort', cancelProvider, { once: true })
      try {
        const output = await runScenarioEvaluation(options.adapter, request, controller.signal)
        const eventId = id()
        const completed = await completeScenarioRerunItem(options.doc, request, output, {
          eventId, resultId: item.definition.resultId,
          authorId: options.authorId, authorDisplayName: options.authorDisplayName, timestamp: now(),
        })
        const event = completed.itemEvents.find((value) => value.eventId === eventId)
        const result = completed.items.find((value) => value.definition.itemId === item.definition.itemId)?.result
        if (!event || !result) throw new Error('Scenario rerun completion failed post-write verification')
        await attribute({ recordType: 'item', event })
        await attribute({ recordType: 'result', result })
        progress('completed-item', item.definition.itemId, item.attempt)
      } catch (error) {
        if (options.signal.aborted || (isAbort(error) && !timedOut)) {
          const current = readScenarioRerunJob(shared.settings, shared.discussions, options.jobId)
          if (!current) throw new Error('Scenario rerun queue failed integrity checks after cancellation')
          progress('stopped', item.definition.itemId, item.attempt)
          return snapshotResult(options.jobId, current.status, 'aborted', current.items)
        }
        const current = readScenarioRerunJob(shared.settings, shared.discussions, options.jobId)
        const currentItem = current?.items.find(({ definition }) => definition.itemId === item.definition.itemId)
        if (current?.status === 'running' && currentItem?.status === 'interrupted') {
          const safe = safeError(error, timedOut)
          const eventId = id()
          const failed = failScenarioRerunItem(shared.settings, shared.discussions, {
            eventId, jobId: current.definition.jobId, itemId: currentItem.definition.itemId,
            expectedCurrentEventId: currentItem.currentEventId!, attempt: currentItem.attempt,
            errorCode: safe.code, errorMessage: safe.message,
            authorId: options.authorId, timestamp: now(),
          })
          const event = failed.itemEvents.find((value) => value.eventId === eventId)
          if (!event) throw new Error('Scenario rerun failure event failed post-write verification')
          await attribute({ recordType: 'item', event })
          progress('failed-item', item.definition.itemId, item.attempt)
        }
      } finally {
        clearTimeout(timeout)
        clearInterval(heartbeat)
        options.signal.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelProvider)
      }
    }
  } finally {
    running.delete(options.jobId)
    if (!running.size) active.delete(options.doc)
  }
}
