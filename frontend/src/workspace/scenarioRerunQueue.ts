import * as Y from 'yjs'
import type { PolicyVersion } from './policyVersionModel'
import { readPolicyVersion } from './policyVersionModel'
import { getProjectSharedTypes } from './projectModel'
import {
  SCENARIO_EVALUATION_PROMPT_VERSION,
  validateScenarioEvaluationOutput,
  type ScenarioEvaluationOutput,
  type ScenarioEvaluationProviderId,
  type ScenarioEvaluationRequest,
} from './scenarioEvaluation'
import { scenarioGenerationRevision } from './scenarioGeneration'
import { readScenario, type ResearchScenario } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'

export const SCENARIO_RERUN_QUEUE_SCHEMA_VERSION = 1 as const
export const MAX_SCENARIO_RERUN_JOBS = 1_000
export const MAX_SCENARIO_RERUN_ITEMS = 200
export const MAX_SCENARIO_RERUN_ATTEMPTS = 3
export const MAX_SCENARIO_RERUN_DEFINITION_CONTEXT = 2_000_000
const JOB_PREFIX = 'scenario-rerun-jobs:v1:'
const RESULT_PREFIX = 'scenario-evaluation-results:v1:'

export type ScenarioRerunControlAction = 'start' | 'pause' | 'cancel'
export type ScenarioRerunItemAction = 'begin' | 'fail' | 'retry' | 'complete'
export type ScenarioRerunJobStatus = 'paused' | 'running' | 'cancelled' | 'complete'
export type ScenarioRerunItemStatus = 'pending' | 'interrupted' | 'failed' | 'complete'

export interface ScenarioRerunJobItemDefinition {
  itemId: string
  scenarioId: string
  scenarioRevision: string
  runIdBase: string
  resultId: string
}

export interface ScenarioRerunJobDefinition {
  schemaVersion: typeof SCENARIO_RERUN_QUEUE_SCHEMA_VERSION
  jobId: string
  projectId: string
  documentId: string
  policyVersionId: string
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  promptVersion: typeof SCENARIO_EVALUATION_PROMPT_VERSION
  maxAttempts: number
  items: ScenarioRerunJobItemDefinition[]
  createdBy: string
  createdByDisplayName: string
  createdAt: number
}

export interface ScenarioRerunControlEvent {
  schemaVersion: typeof SCENARIO_RERUN_QUEUE_SCHEMA_VERSION
  eventId: string
  jobId: string
  action: ScenarioRerunControlAction
  parentEventId: string | null
  authorId: string
  timestamp: number
}

export interface ScenarioRerunItemEvent {
  schemaVersion: typeof SCENARIO_RERUN_QUEUE_SCHEMA_VERSION
  eventId: string
  jobId: string
  itemId: string
  action: ScenarioRerunItemAction
  parentEventId: string | null
  attempt: number
  resultId: string | null
  errorCode: string | null
  errorMessage: string | null
  authorId: string
  timestamp: number
}

export interface ScenarioEvaluationResult {
  schemaVersion: typeof SCENARIO_RERUN_QUEUE_SCHEMA_VERSION
  resultId: string
  jobId: string
  itemId: string
  attempt: number
  runId: string
  projectId: string
  documentId: string
  policyVersionId: string
  scenarioId: string
  scenarioRevision: string
  promptVersion: typeof SCENARIO_EVALUATION_PROMPT_VERSION
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  executedModelId: string
  outcome: ScenarioEvaluationOutput['outcome']
  response: string
  rationale: string
  uncertainty: string
  authorId: string
  authorDisplayName: string
  timestamp: number
}

export interface ScenarioRerunItemState {
  definition: ScenarioRerunJobItemDefinition
  status: ScenarioRerunItemStatus
  attempt: number
  currentEventId: string | null
  errorCode: string | null
  errorMessage: string | null
  result: ScenarioEvaluationResult | null
}

export interface ScenarioRerunJob {
  definition: ScenarioRerunJobDefinition
  status: ScenarioRerunJobStatus
  currentControlEventId: string | null
  controls: ScenarioRerunControlEvent[]
  itemEvents: ScenarioRerunItemEvent[]
  items: ScenarioRerunItemState[]
}

const providers = new Set<ScenarioEvaluationProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const routeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
  !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`

function validDefinition(value: unknown): value is ScenarioRerunJobDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'jobId', 'projectId', 'documentId', 'policyVersionId', 'providerId',
    'requestedModelId', 'promptVersion', 'maxAttempts', 'items', 'createdBy',
    'createdByDisplayName', 'createdAt',
  ])) return false
  const job = value as Partial<ScenarioRerunJobDefinition>
  if (job.schemaVersion !== SCENARIO_RERUN_QUEUE_SCHEMA_VERSION || !stableId(job.jobId) ||
    !stableId(job.projectId) || !stableId(job.documentId) || !/^[a-f0-9]{64}$/.test(job.policyVersionId ?? '') ||
    !providers.has(job.providerId as ScenarioEvaluationProviderId) || !routeId(job.requestedModelId) ||
    job.promptVersion !== SCENARIO_EVALUATION_PROMPT_VERSION || !Number.isSafeInteger(job.maxAttempts) ||
    job.maxAttempts! < 1 || job.maxAttempts! > MAX_SCENARIO_RERUN_ATTEMPTS ||
    !Array.isArray(job.items) || job.items.length === 0 || job.items.length > MAX_SCENARIO_RERUN_ITEMS ||
    !stableId(job.createdBy) || !validText(job.createdByDisplayName, 200) || !validTimestamp(job.createdAt)) return false
  const ids = new Set<string>()
  const scenarios = new Set<string>()
  const runs = new Set<string>()
  const results = new Set<string>()
  let contextLength = 0
  for (const item of job.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !exactKeys(item, [
      'itemId', 'scenarioId', 'scenarioRevision', 'runIdBase', 'resultId',
    ]) || !stableId(item.itemId) || !stableId(item.scenarioId) || !validText(item.scenarioRevision, 200_000) ||
      !stableId(item.runIdBase) || !stableId(item.resultId) || ids.has(item.itemId) ||
      scenarios.has(item.scenarioId) || runs.has(item.runIdBase) || results.has(item.resultId)) return false
    contextLength += item.scenarioRevision.length
    if (contextLength > MAX_SCENARIO_RERUN_DEFINITION_CONTEXT) return false
    ids.add(item.itemId); scenarios.add(item.scenarioId); runs.add(item.runIdBase); results.add(item.resultId)
  }
  return true
}

function validControl(value: unknown): value is ScenarioRerunControlEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'jobId', 'action', 'parentEventId', 'authorId', 'timestamp',
  ])) return false
  const event = value as Partial<ScenarioRerunControlEvent>
  return event.schemaVersion === SCENARIO_RERUN_QUEUE_SCHEMA_VERSION && stableId(event.eventId) &&
    stableId(event.jobId) && ['start', 'pause', 'cancel'].includes(event.action ?? '') &&
    (event.parentEventId === null || stableId(event.parentEventId)) && stableId(event.authorId) &&
    validTimestamp(event.timestamp)
}

function validItemEvent(value: unknown): value is ScenarioRerunItemEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'jobId', 'itemId', 'action', 'parentEventId', 'attempt',
    'resultId', 'errorCode', 'errorMessage', 'authorId', 'timestamp',
  ])) return false
  const event = value as Partial<ScenarioRerunItemEvent>
  if (event.schemaVersion !== SCENARIO_RERUN_QUEUE_SCHEMA_VERSION || !stableId(event.eventId) ||
    !stableId(event.jobId) || !stableId(event.itemId) ||
    !['begin', 'fail', 'retry', 'complete'].includes(event.action ?? '') ||
    (event.parentEventId !== null && !stableId(event.parentEventId)) || !Number.isSafeInteger(event.attempt) ||
    event.attempt! < 1 || event.attempt! > MAX_SCENARIO_RERUN_ATTEMPTS || !stableId(event.authorId) ||
    !validTimestamp(event.timestamp)) return false
  if (event.action === 'fail') return event.resultId === null && stableId(event.errorCode) && validText(event.errorMessage, 500)
  if (event.action === 'complete') return stableId(event.resultId) && event.errorCode === null && event.errorMessage === null
  return event.resultId === null && event.errorCode === null && event.errorMessage === null
}

function validResult(value: unknown): value is ScenarioEvaluationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'resultId', 'jobId', 'itemId', 'attempt', 'runId', 'projectId', 'documentId',
    'policyVersionId', 'scenarioId', 'scenarioRevision', 'promptVersion', 'providerId',
    'requestedModelId', 'executedModelId', 'outcome', 'response', 'rationale', 'uncertainty',
    'authorId', 'authorDisplayName', 'timestamp',
  ])) return false
  const result = value as Partial<ScenarioEvaluationResult>
  return result.schemaVersion === SCENARIO_RERUN_QUEUE_SCHEMA_VERSION && stableId(result.resultId) &&
    stableId(result.jobId) && stableId(result.itemId) && Number.isSafeInteger(result.attempt) &&
    result.attempt! >= 1 && result.attempt! <= MAX_SCENARIO_RERUN_ATTEMPTS && stableId(result.runId) &&
    stableId(result.projectId) && stableId(result.documentId) && /^[a-f0-9]{64}$/.test(result.policyVersionId ?? '') &&
    stableId(result.scenarioId) && validText(result.scenarioRevision, 200_000) &&
    result.promptVersion === SCENARIO_EVALUATION_PROMPT_VERSION &&
    providers.has(result.providerId as ScenarioEvaluationProviderId) && routeId(result.requestedModelId) &&
    routeId(result.executedModelId) && ['handled', 'unhandled', 'uncertain'].includes(result.outcome ?? '') &&
    validText(result.response, 500_000) && validText(result.rationale, 100_000) &&
    validText(result.uncertainty, 50_000) && stableId(result.authorId) &&
    validText(result.authorDisplayName, 200) && validTimestamp(result.timestamp)
}

const jobEntries = (settings: Y.Map<unknown>) =>
  Array.from(settings.entries()).filter(([key]) => key.startsWith(JOB_PREFIX))
const resultEntries = (discussions: Y.Map<unknown>) =>
  Array.from(discussions.entries()).filter(([key]) => key.startsWith(RESULT_PREFIX))

function dedupe<T extends { eventId: string }>(values: T[]): T[] | null {
  const byId = new Map<string, T>()
  for (const value of values) {
    const prior = byId.get(value.eventId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) return null
    byId.set(value.eventId, value)
  }
  return Array.from(byId.values())
}

function chain<T extends { eventId: string; parentEventId: string | null }>(events: T[]): T[] | null {
  if (!events.length) return []
  const roots = events.filter(({ parentEventId }) => parentEventId === null)
  if (roots.length !== 1) return null
  const byParent = new Map<string, T[]>()
  for (const event of events) {
    if (event.parentEventId === null) continue
    const children = byParent.get(event.parentEventId) ?? []
    children.push(event); byParent.set(event.parentEventId, children)
  }
  if (Array.from(byParent.values()).some((children) => children.length !== 1)) return null
  const ordered: T[] = []
  let cursor: T | undefined = roots[0]
  const seen = new Set<string>()
  while (cursor) {
    if (seen.has(cursor.eventId)) return null
    seen.add(cursor.eventId); ordered.push(cursor)
    cursor = byParent.get(cursor.eventId)?.[0]
  }
  return ordered.length === events.length ? ordered : null
}

interface RawJob {
  definition: ScenarioRerunJobDefinition
  controls: ScenarioRerunControlEvent[]
  itemEvents: ScenarioRerunItemEvent[]
  results: ScenarioEvaluationResult[]
}

function rawJob(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, jobId: string): RawJob | null {
  const definitions: ScenarioRerunJobDefinition[] = []
  const controls: ScenarioRerunControlEvent[] = []
  const itemEvents: ScenarioRerunItemEvent[] = []
  for (const [key, bucket] of jobEntries(settings)) {
    const keyTargetsJob = key.endsWith(`:${jobId}`)
    if (!(bucket instanceof Y.Map)) {
      if (keyTargetsJob) return null
      continue
    }
    if (bucket.get('jobId') !== jobId) {
      if (keyTargetsJob) return null
      continue
    }
    if (!exactYKeys(bucket, ['jobId', 'definition', 'controls', 'itemEvents']) ||
      !validDefinition(bucket.get('definition')) || !(bucket.get('controls') instanceof Y.Map) ||
      !(bucket.get('itemEvents') instanceof Y.Map)) return null
    definitions.push(bucket.get('definition') as ScenarioRerunJobDefinition)
    for (const event of (bucket.get('controls') as Y.Map<unknown>).values()) {
      if (!validControl(event) || event.jobId !== jobId) return null
      controls.push(event)
    }
    for (const event of (bucket.get('itemEvents') as Y.Map<unknown>).values()) {
      if (!validItemEvent(event) || event.jobId !== jobId) return null
      itemEvents.push(event)
    }
  }
  if (!definitions.length || definitions.some((value) => JSON.stringify(value) !== JSON.stringify(definitions[0]))) return null
  const results: ScenarioEvaluationResult[] = []
  for (const [key, bucket] of resultEntries(discussions)) {
    const keyTargetsJob = key.endsWith(`:${jobId}`)
    if (!(bucket instanceof Y.Map)) {
      if (keyTargetsJob) return null
      continue
    }
    if (bucket.get('jobId') !== jobId) {
      if (keyTargetsJob) return null
      continue
    }
    if (!exactYKeys(bucket, ['jobId', 'results']) || !(bucket.get('results') instanceof Y.Map)) return null
    for (const result of (bucket.get('results') as Y.Map<unknown>).values()) {
      if (!validResult(result) || result.jobId !== jobId) return null
      results.push(result)
    }
  }
  const uniqueControls = dedupe(controls)
  const uniqueItems = dedupe(itemEvents)
  const byResult = new Map<string, ScenarioEvaluationResult>()
  for (const result of results) {
    const prior = byResult.get(result.resultId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(result)) return null
    byResult.set(result.resultId, result)
  }
  return uniqueControls && uniqueItems ? {
    definition: structuredClone(definitions[0]), controls: uniqueControls, itemEvents: uniqueItems,
    results: Array.from(byResult.values()).map((value) => structuredClone(value)),
  } : null
}

function project(raw: RawJob): ScenarioRerunJob | null {
  const controls = chain(raw.controls)
  if (!controls || controls.some((event) => event.authorId !== raw.definition.createdBy)) return null
  let controlStatus: Exclude<ScenarioRerunJobStatus, 'complete'> = 'paused'
  for (const event of controls) {
    if (event.action === 'start') {
      if (controlStatus !== 'paused') return null
      controlStatus = 'running'
    } else if (event.action === 'pause') {
      if (controlStatus !== 'running') return null
      controlStatus = 'paused'
    } else {
      if (controlStatus === 'cancelled') return null
      controlStatus = 'cancelled'
    }
  }
  if (raw.itemEvents.some((event) =>
    !raw.definition.items.some(({ itemId }) => itemId === event.itemId))) return null
  const items: ScenarioRerunItemState[] = []
  for (const definition of raw.definition.items) {
    const events = chain(raw.itemEvents.filter(({ itemId }) => itemId === definition.itemId))
    if (!events || events.some(({ authorId }) => authorId !== raw.definition.createdBy)) return null
    let status: ScenarioRerunItemStatus = 'pending'
    let attempt = 1
    let errorCode: string | null = null
    let errorMessage: string | null = null
    for (const event of events) {
      if (event.attempt !== attempt) return null
      if (event.action === 'begin') {
        if (status !== 'pending' && status !== 'interrupted') return null
        status = 'interrupted'
      } else if (event.action === 'fail') {
        if (status !== 'interrupted') return null
        status = 'failed'; errorCode = event.errorCode; errorMessage = event.errorMessage
      } else if (event.action === 'retry') {
        if (status !== 'failed' || attempt >= raw.definition.maxAttempts) return null
        attempt += 1; status = 'pending'; errorCode = null; errorMessage = null
      } else {
        if (status !== 'interrupted' || event.resultId !== definition.resultId) return null
        status = 'complete'
      }
    }
    const result = raw.results.find(({ resultId }) => resultId === definition.resultId) ?? null
    if ((status === 'complete') !== Boolean(result) || (result && (
      result.jobId !== raw.definition.jobId || result.itemId !== definition.itemId ||
      result.scenarioId !== definition.scenarioId || result.scenarioRevision !== definition.scenarioRevision ||
      result.policyVersionId !== raw.definition.policyVersionId || result.projectId !== raw.definition.projectId ||
      result.documentId !== raw.definition.documentId || result.promptVersion !== raw.definition.promptVersion ||
      result.providerId !== raw.definition.providerId || result.requestedModelId !== raw.definition.requestedModelId ||
      result.runId !== `${definition.runIdBase}-a${attempt}` || result.attempt !== attempt ||
      result.authorId !== raw.definition.createdBy
    ))) return null
    items.push({ definition: { ...definition }, status, attempt, currentEventId: events.length ? events[events.length - 1].eventId : null,
      errorCode, errorMessage, result })
  }
  if (raw.results.some((result) => !raw.definition.items.some(({ resultId }) => resultId === result.resultId))) return null
  return {
    definition: structuredClone(raw.definition),
    status: items.every(({ status }) => status === 'complete') ? 'complete' : controlStatus,
    currentControlEventId: controls.length ? controls[controls.length - 1].eventId : null,
    controls: controls.map((event) => ({ ...event })),
    itemEvents: raw.itemEvents.map((event) => ({ ...event })),
    items,
  }
}

export function readScenarioRerunJob(
  settings: Y.Map<unknown>, discussions: Y.Map<unknown>, jobId: string,
): ScenarioRerunJob | null {
  if (!stableId(jobId)) return null
  const raw = rawJob(settings, discussions, jobId)
  return raw ? project(raw) : null
}

export function listScenarioRerunJobs(settings: Y.Map<unknown>, discussions: Y.Map<unknown>) {
  const ids = Array.from(new Set(jobEntries(settings).flatMap(([, bucket]) =>
    bucket instanceof Y.Map && stableId(bucket.get('jobId')) ? [bucket.get('jobId') as string] : []))).sort()
  return ids.flatMap((id) => {
    const job = readScenarioRerunJob(settings, discussions, id)
    return job ? [job] : []
  }).sort((left, right) => left.definition.createdAt - right.definition.createdAt ||
    left.definition.jobId.localeCompare(right.definition.jobId))
}

function detachedJobBucket(definition: ScenarioRerunJobDefinition) {
  const bucket = new Y.Map<unknown>()
  bucket.set('jobId', definition.jobId)
  bucket.set('definition', structuredClone(definition))
  bucket.set('controls', new Y.Map<ScenarioRerunControlEvent>())
  bucket.set('itemEvents', new Y.Map<ScenarioRerunItemEvent>())
  return bucket
}

function currentJobBucket(settings: Y.Map<unknown>, definition: ScenarioRerunJobDefinition) {
  const key = `${JOB_PREFIX}${peerKey(settings, definition.jobId)}`
  const current = settings.get(key)
  if (current !== undefined && (!(current instanceof Y.Map) || current.get('jobId') !== definition.jobId ||
    JSON.stringify(current.get('definition')) !== JSON.stringify(definition))) {
    throw new Error('Scenario rerun queue bucket identity conflict')
  }
  return { key, bucket: current instanceof Y.Map ? current : detachedJobBucket(definition), isNew: current === undefined }
}

export function createScenarioRerunJob(settings: Y.Map<unknown>, input: {
  jobId: string
  project: ResearchProjectManifest
  policyVersion: PolicyVersion
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  maxAttempts?: number
  items: Array<{ itemId: string; scenario: ResearchScenario; runIdBase: string; resultId: string }>
  authorId: string
  authorDisplayName: string
  timestamp: number
}): ScenarioRerunJob {
  if (input.policyVersion.projectId !== input.project.id) throw new Error('Scenario rerun version belongs to another project')
  const definition: ScenarioRerunJobDefinition = {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION,
    jobId: input.jobId, projectId: input.project.id, documentId: input.project.documentId,
    policyVersionId: input.policyVersion.versionId, providerId: input.providerId,
    requestedModelId: input.requestedModelId, promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
    maxAttempts: input.maxAttempts ?? MAX_SCENARIO_RERUN_ATTEMPTS,
    items: input.items.map(({ itemId, scenario, runIdBase, resultId }) => ({
      itemId, scenarioId: scenario.id, scenarioRevision: scenarioGenerationRevision(scenario), runIdBase, resultId,
    })).sort((left, right) => left.itemId.localeCompare(right.itemId)),
    createdBy: input.authorId, createdByDisplayName: input.authorDisplayName, createdAt: input.timestamp,
  }
  if (!validDefinition(definition)) throw new Error('Invalid scenario rerun job')
  const discussions = settings.doc ? getProjectSharedTypes(settings.doc).discussions : new Y.Map<unknown>()
  const existing = readScenarioRerunJob(settings, discussions, input.jobId)
  if (existing) {
    if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) throw new Error('Scenario rerun job already exists')
    return existing
  }
  if (jobEntries(settings).length >= MAX_SCENARIO_RERUN_JOBS) throw new Error('Scenario rerun job limit reached')
  const { key, bucket } = currentJobBucket(settings, definition)
  const operation = () => settings.set(key, bucket)
  if (settings.doc) settings.doc.transact(operation, 'syzygy-scenario-rerun-job')
  else operation()
  return readScenarioRerunJob(settings, discussions, definition.jobId)!
}

function appendControl(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, event: ScenarioRerunControlEvent) {
  if (!validControl(event)) throw new Error('Invalid scenario rerun control event')
  const job = readScenarioRerunJob(settings, discussions, event.jobId)
  if (!job) throw new Error('Scenario rerun job is missing or invalid')
  if (event.authorId !== job.definition.createdBy) throw new Error('Only the job creator can control this queue')
  const all = rawJob(settings, discussions, event.jobId)!.controls
  const replay = all.find(({ eventId }) => eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Scenario rerun control event ID was reused')
    return job
  }
  if (event.parentEventId !== job.currentControlEventId) throw new Error('Scenario rerun control changed; reload and retry')
  const allowed = event.action === 'start' ? job.status === 'paused' :
    event.action === 'pause' ? job.status === 'running' : job.status !== 'cancelled' && job.status !== 'complete'
  if (!allowed) throw new Error(`Cannot ${event.action} a ${job.status} scenario rerun job`)
  const target = currentJobBucket(settings, job.definition)
  const operation = () => {
    if (target.isNew) settings.set(target.key, target.bucket)
    ;(target.bucket.get('controls') as Y.Map<ScenarioRerunControlEvent>).set(peerKey(settings, event.eventId), event)
  }
  if (settings.doc) settings.doc.transact(operation, 'syzygy-scenario-rerun-control')
  else operation()
  return readScenarioRerunJob(settings, discussions, event.jobId)!
}

export function controlScenarioRerunJob(
  settings: Y.Map<unknown>, discussions: Y.Map<unknown>, input: Omit<ScenarioRerunControlEvent, 'schemaVersion'>,
) {
  return appendControl(settings, discussions, { schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION, ...input })
}

function appendItemEvent(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, event: ScenarioRerunItemEvent) {
  if (!validItemEvent(event)) throw new Error('Invalid scenario rerun item event')
  const job = readScenarioRerunJob(settings, discussions, event.jobId)
  if (!job) throw new Error('Scenario rerun job is missing or invalid')
  if (event.authorId !== job.definition.createdBy) throw new Error('Only the job creator can execute this queue')
  const item = job.items.find(({ definition }) => definition.itemId === event.itemId)
  if (!item) throw new Error('Scenario rerun item changed; reload and retry')
  const all = rawJob(settings, discussions, event.jobId)!.itemEvents
  const replay = all.find(({ eventId }) => eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Scenario rerun item event ID was reused')
    return job
  }
  if (event.parentEventId !== item.currentEventId || event.attempt !== item.attempt) {
    throw new Error('Scenario rerun item changed; reload and retry')
  }
  const allowed = event.action === 'begin' ? job.status === 'running' && (item.status === 'pending' || item.status === 'interrupted') :
    event.action === 'fail' ? job.status === 'running' && item.status === 'interrupted' :
      event.action === 'retry' ? item.status === 'failed' && item.attempt < job.definition.maxAttempts : false
  if (!allowed) throw new Error(`Cannot ${event.action} a ${item.status} scenario rerun item`)
  const target = currentJobBucket(settings, job.definition)
  const operation = () => {
    if (target.isNew) settings.set(target.key, target.bucket)
    ;(target.bucket.get('itemEvents') as Y.Map<ScenarioRerunItemEvent>).set(peerKey(settings, event.eventId), event)
  }
  if (settings.doc) settings.doc.transact(operation, 'syzygy-scenario-rerun-item')
  else operation()
  return readScenarioRerunJob(settings, discussions, event.jobId)!
}

export function beginScenarioRerunItem(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, input: {
  eventId: string; jobId: string; itemId: string; expectedCurrentEventId: string | null;
  attempt: number; authorId: string; timestamp: number
}) {
  return appendItemEvent(settings, discussions, {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION, eventId: input.eventId, jobId: input.jobId,
    itemId: input.itemId, action: 'begin', parentEventId: input.expectedCurrentEventId,
    attempt: input.attempt, resultId: null, errorCode: null, errorMessage: null,
    authorId: input.authorId, timestamp: input.timestamp,
  })
}

export function failScenarioRerunItem(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, input: {
  eventId: string; jobId: string; itemId: string; expectedCurrentEventId: string;
  attempt: number; errorCode: string; errorMessage: string; authorId: string; timestamp: number
}) {
  return appendItemEvent(settings, discussions, {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION, eventId: input.eventId, jobId: input.jobId,
    itemId: input.itemId, action: 'fail', parentEventId: input.expectedCurrentEventId,
    attempt: input.attempt, resultId: null, errorCode: input.errorCode, errorMessage: input.errorMessage,
    authorId: input.authorId, timestamp: input.timestamp,
  })
}

export function retryScenarioRerunItem(settings: Y.Map<unknown>, discussions: Y.Map<unknown>, input: {
  eventId: string; jobId: string; itemId: string; expectedCurrentEventId: string;
  attempt: number; authorId: string; timestamp: number
}) {
  return appendItemEvent(settings, discussions, {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION, eventId: input.eventId, jobId: input.jobId,
    itemId: input.itemId, action: 'retry', parentEventId: input.expectedCurrentEventId,
    attempt: input.attempt, resultId: null, errorCode: null, errorMessage: null,
    authorId: input.authorId, timestamp: input.timestamp,
  })
}

function detachedResultBucket(jobId: string) {
  const bucket = new Y.Map<unknown>()
  bucket.set('jobId', jobId)
  bucket.set('results', new Y.Map<ScenarioEvaluationResult>())
  return bucket
}

export async function completeScenarioRerunItem(
  doc: Y.Doc,
  request: ScenarioEvaluationRequest,
  output: ScenarioEvaluationOutput,
  input: { eventId: string; resultId: string; authorId: string; authorDisplayName: string; timestamp: number },
): Promise<ScenarioRerunJob> {
  const validated = validateScenarioEvaluationOutput(request, output)
  const { metadata, settings, discussions, scenarios, versions } = getProjectSharedTypes(doc)
  if (doc.guid !== request.documentId || metadata.get('projectId') !== request.projectId) {
    throw new Error('Scenario rerun project identity changed before completion')
  }
  const replayCandidate: ScenarioEvaluationResult = {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION,
    resultId: input.resultId, jobId: request.jobId, itemId: request.itemId, attempt: request.attempt,
    runId: request.runId, projectId: request.projectId, documentId: request.documentId,
    policyVersionId: request.policyVersionId, scenarioId: request.scenarioId,
    scenarioRevision: request.scenarioRevision, promptVersion: request.promptVersion,
    providerId: validated.providerId, requestedModelId: validated.requestedModelId,
    executedModelId: validated.executedModelId, outcome: validated.outcome, response: validated.response,
    rationale: validated.rationale, uncertainty: validated.uncertainty,
    authorId: input.authorId, authorDisplayName: input.authorDisplayName, timestamp: input.timestamp,
  }
  if (!validResult(replayCandidate)) throw new Error('Invalid scenario evaluation result')
  const before = rawJob(settings, discussions, request.jobId)
  const priorEvent = before?.itemEvents.find(({ eventId }) => eventId === input.eventId)
  const priorResult = before?.results.find(({ resultId }) => resultId === input.resultId)
  if (priorEvent || priorResult) {
    const exactEvent = priorEvent?.action === 'complete' && priorEvent.jobId === request.jobId &&
      priorEvent.itemId === request.itemId && priorEvent.attempt === request.attempt &&
      priorEvent.resultId === input.resultId && priorEvent.authorId === input.authorId &&
      priorEvent.timestamp === input.timestamp && priorEvent.errorCode === null && priorEvent.errorMessage === null
    if (!exactEvent || JSON.stringify(priorResult) !== JSON.stringify(replayCandidate)) {
      throw new Error('Scenario rerun completion identity was reused')
    }
    const replayed = readScenarioRerunJob(settings, discussions, request.jobId)
    if (!replayed) throw new Error('Scenario rerun completion replay failed validation')
    return replayed
  }
  const job = readScenarioRerunJob(settings, discussions, request.jobId)
  if (!job || job.status !== 'running' || input.authorId !== job.definition.createdBy) {
    throw new Error('Scenario rerun job is not running for its creator')
  }
  const item = job.items.find(({ definition }) => definition.itemId === request.itemId)
  if (!item || item.status !== 'interrupted' || item.attempt !== request.attempt ||
    item.definition.resultId !== input.resultId || item.definition.scenarioId !== request.scenarioId ||
    item.definition.scenarioRevision !== request.scenarioRevision ||
    job.definition.policyVersionId !== request.policyVersionId || job.definition.providerId !== request.providerId ||
    job.definition.requestedModelId !== request.requestedModelId ||
    `${item.definition.runIdBase}-a${item.attempt}` !== request.runId) {
    throw new Error('Scenario rerun item no longer matches the evaluated request')
  }
  const version = await readPolicyVersion(versions, request.policyVersionId)
  if (!version || version.projectId !== request.projectId) throw new Error('Scenario rerun policy version failed verification')
  const scenario = readScenario(scenarios, request.scenarioId)
  if (!scenario || scenarioGenerationRevision(scenario) !== request.scenarioRevision) {
    throw new Error('Scenario changed during queued evaluation; retry from a new job')
  }
  const result: ScenarioEvaluationResult = {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION,
    resultId: input.resultId, jobId: request.jobId, itemId: request.itemId, attempt: request.attempt,
    runId: request.runId, projectId: request.projectId, documentId: request.documentId,
    policyVersionId: request.policyVersionId, scenarioId: request.scenarioId,
    scenarioRevision: request.scenarioRevision, promptVersion: request.promptVersion,
    providerId: validated.providerId, requestedModelId: validated.requestedModelId,
    executedModelId: validated.executedModelId, outcome: validated.outcome, response: validated.response,
    rationale: validated.rationale, uncertainty: validated.uncertainty,
    authorId: input.authorId, authorDisplayName: input.authorDisplayName, timestamp: input.timestamp,
  }
  if (!validResult(result)) throw new Error('Invalid scenario evaluation result')
  const completion: ScenarioRerunItemEvent = {
    schemaVersion: SCENARIO_RERUN_QUEUE_SCHEMA_VERSION,
    eventId: input.eventId, jobId: request.jobId, itemId: request.itemId, action: 'complete',
    parentEventId: item.currentEventId, attempt: item.attempt, resultId: input.resultId,
    errorCode: null, errorMessage: null, authorId: input.authorId, timestamp: input.timestamp,
  }
  if (!validItemEvent(completion)) throw new Error('Invalid scenario rerun completion event')
  const jobTarget = currentJobBucket(settings, job.definition)
  const resultKey = `${RESULT_PREFIX}${peerKey(discussions, request.jobId)}`
  const storedResultBucket = discussions.get(resultKey)
  if (storedResultBucket !== undefined && (!(storedResultBucket instanceof Y.Map) ||
    storedResultBucket.get('jobId') !== request.jobId || !(storedResultBucket.get('results') instanceof Y.Map))) {
    throw new Error('Scenario evaluation result bucket identity conflict')
  }
  const resultBucket = storedResultBucket instanceof Y.Map ? storedResultBucket : detachedResultBucket(request.jobId)
  doc.transact(() => {
    if (jobTarget.isNew) settings.set(jobTarget.key, jobTarget.bucket)
    if (storedResultBucket === undefined) discussions.set(resultKey, resultBucket)
    ;(resultBucket.get('results') as Y.Map<ScenarioEvaluationResult>).set(peerKey(discussions, result.resultId), result)
    ;(jobTarget.bucket.get('itemEvents') as Y.Map<ScenarioRerunItemEvent>).set(peerKey(settings, completion.eventId), completion)
  }, 'syzygy-scenario-rerun-complete')
  const completed = readScenarioRerunJob(settings, discussions, request.jobId)
  if (!completed) throw new Error('Scenario rerun completion failed post-write verification')
  return completed
}

export function inspectScenarioRerunQueues(
  settings: Y.Map<unknown>, discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>,
) {
  const jobIds = Array.from(new Set(jobEntries(settings).flatMap(([, bucket]) =>
    bucket instanceof Y.Map && stableId(bucket.get('jobId')) ? [bucket.get('jobId') as string] : []))).sort()
  const jobs = jobIds.flatMap((id) => {
    const job = readScenarioRerunJob(settings, discussions, id)
    return job ? [job] : []
  })
  const invalidRecords = jobIds.length - jobs.length + jobEntries(settings).filter(([, bucket]) =>
    !(bucket instanceof Y.Map) || !exactYKeys(bucket, ['jobId', 'definition', 'controls', 'itemEvents'])).length
  const orphanScenarioIds = Array.from(new Set(jobs.flatMap((job) => job.definition.items.flatMap((item) =>
    readScenario(scenarios, item.scenarioId) ? [] : [item.scenarioId])))).sort()
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} scenario rerun queue record(s) failed validation`)
  orphanScenarioIds.forEach((id) => issues.push(`Scenario rerun queue targets missing scenario ${id}`))
  return {
    healthy: issues.length === 0,
    jobCount: jobs.length,
    runningCount: jobs.filter(({ status }) => status === 'running').length,
    pausedCount: jobs.filter(({ status }) => status === 'paused').length,
    cancelledCount: jobs.filter(({ status }) => status === 'cancelled').length,
    completeCount: jobs.filter(({ status }) => status === 'complete').length,
    itemCount: jobs.reduce((total, job) => total + job.items.length, 0),
    completedItemCount: jobs.reduce((total, job) => total + job.items.filter(({ status }) => status === 'complete').length, 0),
    failedItemCount: jobs.reduce((total, job) => total + job.items.filter(({ status }) => status === 'failed').length, 0),
    interruptedItemCount: jobs.reduce((total, job) => total + job.items.filter(({ status }) => status === 'interrupted').length, 0),
    invalidRecords, orphanScenarioIds, issues,
  }
}
