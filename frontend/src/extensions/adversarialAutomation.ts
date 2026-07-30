import type { AutomationEditorSnapshot } from '../workspace/editorAutomationRegistry'
import type { AdversarialParticipant } from './adversarialProtocol'
import { AdversarialRunnerError, type AdversarialRunnerRequest } from './adversarialRunner'
import {
  NativeAdversarialExecutorError,
  runNativeAdversarialPanel,
  type NativeAdversarialPanelOutcome,
} from './adversarialNativeExecutor'

const MAX_ACTIVE_JOBS = 8
const JOB_DEADLINE_MS = 15 * 60_000
const JOB_HEARTBEAT_MS = 30_000
const TERMINAL_RETENTION_MS = 60 * 60_000
const PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'xai'])

export type AdversarialAutomationJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

interface AdversarialAutomationJob {
  jobId: string
  runId: string
  projectId: string
  documentRevision: string
  request: AdversarialRunnerRequest
  sourceSnapshotIds: string[]
  totalRemoteCalls: number
  status: AdversarialAutomationJobStatus
  startedAt: number
  heartbeatAt: number
  deadlineAt: number
  completedAt: number | null
  errorCode: string | null
  outcome: NativeAdversarialPanelOutcome | null
  controller: AbortController
  heartbeat: ReturnType<typeof setInterval>
}

export interface PersistableAdversarialAutomationJob {
  jobId: string
  projectId: string
  documentRevision: string
  request: AdversarialRunnerRequest
  outcome: NativeAdversarialPanelOutcome
}

export interface AdversarialAutomationJobView {
  jobId: string
  runId: string
  projectId: string
  documentRevision: string
  sourceSnapshotIds: string[]
  totalRemoteCalls: number
  status: AdversarialAutomationJobStatus
  startedAt: number
  heartbeatAt: number
  deadlineAt: number
  completedAt: number | null
  errorCode: string | null
  outcome: NativeAdversarialPanelOutcome | null
}

type NativeRunner = (
  request: AdversarialRunnerRequest,
  signal?: AbortSignal,
) => Promise<NativeAdversarialPanelOutcome>

const jobs = new Map<string, AdversarialAutomationJob>()

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, max = 10_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be bounded non-empty text without control characters`)
  }
  return value
}

function participant(value: unknown, label: string): AdversarialParticipant {
  const input = object(value, label)
  const providerId = string(input.providerId, `${label}.providerId`, 200)
  if (!PROVIDERS.has(providerId)) throw new Error(`${label}.providerId must name a built-in remote provider`)
  return {
    slotId: string(input.slotId, `${label}.slotId`, 200),
    providerId,
    modelId: string(input.modelId, `${label}.modelId`, 200),
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function buildAdversarialAutomationRequest(
  paramsValue: unknown,
  document: AutomationEditorSnapshot,
): AdversarialRunnerRequest {
  const params = object(paramsValue, 'parameters')
  const expectedRevision = string(params.expectedDocumentRevision, 'expectedDocumentRevision', 500)
  if (expectedRevision !== document.revision) {
    throw new Error(`Revision conflict: expected ${expectedRevision}, but the live draft is ${document.revision}`)
  }
  if (!Array.isArray(params.sourceBlockIndexes) || params.sourceBlockIndexes.length === 0 || params.sourceBlockIndexes.length > 200) {
    throw new Error('sourceBlockIndexes must select between 1 and 200 live document blocks')
  }
  const indexes = params.sourceBlockIndexes.map((value) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= document.blocks.length) {
      throw new Error('sourceBlockIndexes contains an invalid live document block index')
    }
    return value as number
  })
  if (new Set(indexes).size !== indexes.length) throw new Error('sourceBlockIndexes must be unique')
  const sources = indexes.map((index) => {
    const block = document.blocks[index]
    if (!block.text.trim()) throw new Error(`Document block ${index} has no text to disclose as research evidence`)
    return {
      snapshotId: `block-${index + 1}-${fnv1a(`${document.revision}\u0000${JSON.stringify(block)}`)}`,
      label: `Document block ${index + 1} (${block.kind})`,
      excerpt: block.text,
    }
  })
  if (!Array.isArray(params.participants) || params.participants.length < 2 || params.participants.length > 200) {
    throw new Error('participants must contain between 2 and 200 remote model routes')
  }
  return {
    runId: string(params.runId, 'runId', 200),
    input: {
      question: string(params.question, 'question', 4 * 1024 * 1024),
      participants: params.participants.map((value, index) => participant(value, `participants[${index}]`)),
      judge: participant(params.judge, 'judge'),
      baseline: participant(params.baseline, 'baseline'),
      seed: string(params.seed, 'seed', 10_000),
    },
    sources,
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof NativeAdversarialExecutorError || error instanceof AdversarialRunnerError) return error.code
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : 'review-failed'
}

function terminal(status: AdversarialAutomationJobStatus): boolean {
  return status !== 'running'
}

function cleanExpiredJobs(now = Date.now()): void {
  for (const [jobId, job] of jobs) {
    if (terminal(job.status) && job.completedAt !== null && now - job.completedAt > TERMINAL_RETENTION_MS) {
      clearInterval(job.heartbeat)
      jobs.delete(jobId)
    }
  }
}

function view(job: AdversarialAutomationJob): AdversarialAutomationJobView {
  return {
    jobId: job.jobId,
    runId: job.runId,
    projectId: job.projectId,
    documentRevision: job.documentRevision,
    sourceSnapshotIds: [...job.sourceSnapshotIds],
    totalRemoteCalls: job.totalRemoteCalls,
    status: job.status,
    startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt,
    deadlineAt: job.deadlineAt,
    completedAt: job.completedAt,
    errorCode: job.errorCode,
    outcome: job.outcome ? structuredClone(job.outcome) : null,
  }
}

export function startAdversarialAutomationJob(
  params: unknown,
  document: AutomationEditorSnapshot,
  run: NativeRunner = runNativeAdversarialPanel,
  now = Date.now(),
): AdversarialAutomationJobView {
  cleanExpiredJobs(now)
  if ([...jobs.values()].filter((job) => job.status === 'running').length >= MAX_ACTIVE_JOBS) {
    throw new Error('Too many adversarial review jobs are active')
  }
  const request = buildAdversarialAutomationRequest(params, document)
  if ([...jobs.values()].some((job) => job.runId === request.runId && job.status === 'running')) {
    throw new Error('An adversarial review with this runId is already active')
  }
  const controller = new AbortController()
  const jobId = crypto.randomUUID()
  const totalRemoteCalls = 4 * request.input.participants.length + 6
  const job: AdversarialAutomationJob = {
    jobId,
    runId: request.runId,
    projectId: document.projectId,
    documentRevision: document.revision,
    request: structuredClone(request),
    sourceSnapshotIds: request.sources.map(({ snapshotId }) => snapshotId),
    totalRemoteCalls,
    status: 'running' as const,
    startedAt: now,
    heartbeatAt: now,
    deadlineAt: now + JOB_DEADLINE_MS,
    completedAt: null,
    errorCode: null,
    outcome: null,
    controller,
    heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
  }
  job.heartbeat = setInterval(() => {
    if (terminal(job.status)) {
      clearInterval(job.heartbeat)
      return
    }
    job.heartbeatAt = Date.now()
    if (job.heartbeatAt >= job.deadlineAt) controller.abort()
  }, JOB_HEARTBEAT_MS)
  jobs.set(jobId, job)
  void Promise.resolve()
    .then(() => run(request, controller.signal))
    .then((outcome) => {
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        job.errorCode = 'cancelled'
      } else {
        job.status = 'completed'
        job.outcome = structuredClone(outcome)
      }
    })
    .catch((error) => {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      job.errorCode = controller.signal.aborted ? 'cancelled' : safeErrorCode(error)
    })
    .finally(() => {
      job.completedAt = Date.now()
      job.heartbeatAt = job.completedAt
      clearInterval(job.heartbeat)
    })
  return view(job)
}

export function getPersistableAdversarialAutomationJob(
  jobIdValue: unknown,
): PersistableAdversarialAutomationJob {
  cleanExpiredJobs()
  const jobId = string(jobIdValue, 'jobId', 200)
  const job = jobs.get(jobId)
  if (!job) throw new Error('No adversarial review job has this ID')
  if (job.status !== 'completed' || !job.outcome) {
    throw new Error('Adversarial review job is not complete and cannot be saved')
  }
  return {
    jobId: job.jobId,
    projectId: job.projectId,
    documentRevision: job.documentRevision,
    request: structuredClone(job.request),
    outcome: structuredClone(job.outcome),
  }
}

export function inspectAdversarialAutomationJob(jobIdValue: unknown): AdversarialAutomationJobView {
  cleanExpiredJobs()
  const jobId = string(jobIdValue, 'jobId', 200)
  const job = jobs.get(jobId)
  if (!job) throw new Error('No adversarial review job has this ID')
  return view(job)
}

export function cancelAdversarialAutomationJob(jobIdValue: unknown): AdversarialAutomationJobView {
  const jobId = string(jobIdValue, 'jobId', 200)
  const job = jobs.get(jobId)
  if (!job) throw new Error('No adversarial review job has this ID')
  if (job.status === 'running') job.controller.abort()
  return view(job)
}

export function resetAdversarialAutomationJobsForTests(): void {
  for (const job of jobs.values()) {
    job.controller.abort()
    clearInterval(job.heartbeat)
  }
  jobs.clear()
}
