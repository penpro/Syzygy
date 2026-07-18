import * as Y from 'yjs'
import { readScenario } from './scenarioModel'

export const SCENARIO_RESPONSE_SCHEMA_VERSION = 1 as const
export type ResponseSourceKind = 'human' | 'model'

export interface ScenarioResponseRevision {
  schemaVersion: typeof SCENARIO_RESPONSE_SCHEMA_VERSION
  revisionId: string
  responseId: string
  scenarioId: string
  parentRevisionId: string | null
  content: string
  authorId: string
  authorDisplayName: string
  timestamp: number
  sourceKind: ResponseSourceKind
  providerId: string | null
  modelId: string | null
  runId: string | null
}

export interface ScenarioResponse {
  id: string
  scenarioId: string
  createdBy: string
  createdByDisplayName: string
  createdAt: number
  currentRevisionId: string
  content: string
  revisions: ScenarioResponseRevision[]
}

export interface WriteScenarioResponseInput {
  responseId: string
  scenarioId: string
  revisionId: string
  content: string
  authorId: string
  authorDisplayName: string
  timestamp: number
  sourceKind?: ResponseSourceKind
  providerId?: string | null
  modelId?: string | null
  runId?: string | null
}

export interface EditScenarioResponseInput extends WriteScenarioResponseInput {
  expectedCurrentRevisionId: string
}

const RESPONSE_BUCKET_PREFIX = 'scenario-responses:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_SCENARIO = 100_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenario-responses')
  else operation()
}

function validRevision(value: unknown): value is ScenarioResponseRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'revisionId', 'responseId', 'scenarioId', 'parentRevisionId', 'content',
    'authorId', 'authorDisplayName', 'timestamp', 'sourceKind', 'providerId', 'modelId', 'runId',
  ])) return false
  const revision = value as Partial<ScenarioResponseRevision>
  if (revision.schemaVersion !== SCENARIO_RESPONSE_SCHEMA_VERSION || !stableId(revision.revisionId) ||
    !stableId(revision.responseId) || !stableId(revision.scenarioId) ||
    (revision.parentRevisionId !== null && !stableId(revision.parentRevisionId)) ||
    !validText(revision.content, 500_000, true) || !stableId(revision.authorId) ||
    !validText(revision.authorDisplayName, 200) || !validTimestamp(revision.timestamp) ||
    (revision.sourceKind !== 'human' && revision.sourceKind !== 'model')) return false
  if (revision.sourceKind === 'human') {
    return revision.providerId === null && revision.modelId === null && revision.runId === null
  }
  return stableId(revision.providerId) && stableId(revision.modelId) && stableId(revision.runId)
}

const bucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(RESPONSE_BUCKET_PREFIX))

function bucketsFor(collection: Y.Map<unknown>, scenarioId: string): Array<[string, Y.Map<unknown>]> {
  return bucketEntries(collection).filter(([, value]) =>
    value instanceof Y.Map && value.get('scenarioId') === scenarioId,
  ) as Array<[string, Y.Map<unknown>]>
}

function eventsFor(collection: Y.Map<unknown>, scenarioId: string): ScenarioResponseRevision[] | null {
  const raw: ScenarioResponseRevision[] = []
  for (const [, bucket] of bucketsFor(collection, scenarioId)) {
    if (!exactYKeys(bucket, ['scenarioId', 'events'])) return null
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) return null
    for (const value of events.values()) {
      if (!validRevision(value) || value.scenarioId !== scenarioId) return null
      raw.push(value)
      if (raw.length > MAX_EVENTS_PER_SCENARIO) return null
    }
  }
  const byId = new Map<string, ScenarioResponseRevision>()
  for (const event of raw) {
    const previous = byId.get(event.revisionId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    byId.set(event.revisionId, event)
  }
  return Array.from(byId.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.revisionId.localeCompare(right.revisionId))
}

function projectResponse(events: ScenarioResponseRevision[]): ScenarioResponse | null {
  if (!events.length) return null
  const roots = events.filter((event) => event.parentRevisionId === null)
  if (roots.length !== 1) return null
  const root = roots[0]
  const byId = new Map(events.map((event) => [event.revisionId, event]))
  if (byId.size !== events.length || events.some((event) => event.responseId !== root.responseId ||
    event.scenarioId !== root.scenarioId || (event.parentRevisionId !== null && !byId.has(event.parentRevisionId)))) return null
  for (const event of events) {
    const seen = new Set<string>()
    let cursor: ScenarioResponseRevision | undefined = event
    while (cursor && cursor.parentRevisionId !== null) {
      if (seen.has(cursor.revisionId)) return null
      seen.add(cursor.revisionId)
      cursor = byId.get(cursor.parentRevisionId)
    }
    if (!cursor || cursor.revisionId !== root.revisionId) return null
  }
  const parentIds = new Set(events.flatMap((event) => event.parentRevisionId ? [event.parentRevisionId] : []))
  const leaves = events.filter((event) => !parentIds.has(event.revisionId))
  const current = [...leaves].sort((left, right) =>
    left.timestamp - right.timestamp || left.revisionId.localeCompare(right.revisionId))[leaves.length - 1]
  if (!current) return null
  return {
    id: root.responseId,
    scenarioId: root.scenarioId,
    createdBy: root.authorId,
    createdByDisplayName: root.authorDisplayName,
    createdAt: root.timestamp,
    currentRevisionId: current.revisionId,
    content: current.content,
    revisions: events.map((event) => ({ ...event })),
  }
}

function normalizedRevision(
  input: WriteScenarioResponseInput,
  parentRevisionId: string | null,
): ScenarioResponseRevision {
  const sourceKind = input.sourceKind ?? 'human'
  const providerId = input.providerId ?? null
  const modelId = input.modelId ?? null
  const runId = input.runId ?? null
  const revision: ScenarioResponseRevision = {
    schemaVersion: SCENARIO_RESPONSE_SCHEMA_VERSION,
    revisionId: input.revisionId,
    responseId: input.responseId,
    scenarioId: input.scenarioId,
    parentRevisionId,
    content: input.content,
    authorId: input.authorId,
    authorDisplayName: input.authorDisplayName,
    timestamp: input.timestamp,
    sourceKind,
    providerId,
    modelId,
    runId,
  }
  if (!validRevision(revision)) throw new Error('Invalid scenario response revision')
  return revision
}

function appendRevision(collection: Y.Map<unknown>, revision: ScenarioResponseRevision): void {
  const existing = eventsFor(collection, revision.scenarioId)
  if (existing === null) throw new Error('Scenario response history is invalid')
  const replay = existing.find((candidate) => candidate.revisionId === revision.revisionId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(revision)) throw new Error('Scenario response revision ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS_PER_SCENARIO) throw new Error('Scenario response history limit reached')
  const bucketKey = `${RESPONSE_BUCKET_PREFIX}${peerKey(collection, revision.scenarioId)}`
  let bucket = collection.get(bucketKey)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || bucket.get('scenarioId') !== revision.scenarioId)) {
    throw new Error('Scenario response bucket identity conflict')
  }
  if (!(bucket instanceof Y.Map)) {
    if (bucketEntries(collection).length >= MAX_BUCKETS) throw new Error('Scenario response bucket limit reached')
    bucket = new Y.Map<unknown>()
    const events = new Y.Map<ScenarioResponseRevision>()
    transact(collection, () => {
      ;(bucket as Y.Map<unknown>).set('scenarioId', revision.scenarioId)
      ;(bucket as Y.Map<unknown>).set('events', events)
      events.set(peerKey(collection, revision.revisionId), revision)
      collection.set(bucketKey, bucket)
    })
  } else {
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Scenario response history is invalid')
    transact(collection, () => events.set(peerKey(collection, revision.revisionId), revision))
  }
}

export function readScenarioResponses(collection: Y.Map<unknown>, scenarioId: string): ScenarioResponse[] | null {
  if (!stableId(scenarioId)) return null
  const events = eventsFor(collection, scenarioId)
  if (events === null) return null
  const ids = Array.from(new Set(events.map((event) => event.responseId))).sort()
  const projected = ids.map((id) => projectResponse(events.filter((event) => event.responseId === id)))
  return projected.some((value) => value === null) ? null : projected as ScenarioResponse[]
}

export function createScenarioResponse(
  discussions: Y.Map<unknown>,
  scenarios: Y.Map<unknown>,
  input: WriteScenarioResponseInput,
): ScenarioResponse {
  if (!readScenario(scenarios, input.scenarioId)) throw new Error('Scenario not found or invalid')
  const revision = normalizedRevision(input, null)
  const existing = eventsFor(discussions, input.scenarioId)
  if (existing === null) throw new Error('Scenario response history is invalid')
  const replay = existing.find((candidate) => candidate.revisionId === revision.revisionId)
  if (replay) {
    appendRevision(discussions, revision)
    const responses = readScenarioResponses(discussions, input.scenarioId)
    const response = responses?.find((candidate) => candidate.id === input.responseId)
    if (!response) throw new Error('Scenario response replay failed validation')
    return response
  }
  if ((readScenarioResponses(discussions, input.scenarioId) ?? []).some((response) => response.id === input.responseId)) {
    throw new Error('Scenario response already exists')
  }
  appendRevision(discussions, revision)
  return readScenarioResponses(discussions, input.scenarioId)!.find((response) => response.id === input.responseId)!
}

export function editScenarioResponse(
  discussions: Y.Map<unknown>,
  scenarios: Y.Map<unknown>,
  input: EditScenarioResponseInput,
): ScenarioResponse {
  if (!stableId(input.expectedCurrentRevisionId) || !readScenario(scenarios, input.scenarioId)) {
    throw new Error('Invalid scenario response edit')
  }
  const responses = readScenarioResponses(discussions, input.scenarioId)
  if (responses === null) throw new Error('Scenario response history is invalid')
  const current = responses.find((response) => response.id === input.responseId)
  if (!current) throw new Error('Scenario response not found')
  const revision = normalizedRevision(input, input.expectedCurrentRevisionId)
  const replay = eventsFor(discussions, input.scenarioId)?.find((candidate) => candidate.revisionId === input.revisionId)
  if (!replay && current.currentRevisionId !== input.expectedCurrentRevisionId) {
    throw new Error('Scenario response revision conflict')
  }
  appendRevision(discussions, revision)
  return readScenarioResponses(discussions, input.scenarioId)!.find((response) => response.id === input.responseId)!
}

export function listScenarioResponses(collection: Y.Map<unknown>): ScenarioResponse[] {
  const entries = bucketEntries(collection)
  if (entries.length > MAX_BUCKETS) return []
  const scenarioIds = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('scenarioId')) ? [value.get('scenarioId') as string] : [],
  ))).sort()
  return scenarioIds.flatMap((scenarioId) => readScenarioResponses(collection, scenarioId) ?? [])
}

export function inspectScenarioResponses(discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>) {
  const entries = bucketEntries(discussions)
  const invalidBuckets = entries.filter(([, value]) =>
    !(value instanceof Y.Map) || !exactYKeys(value, ['scenarioId', 'events']) ||
    !stableId(value.get('scenarioId')) || !(value.get('events') instanceof Y.Map)).length
  const scenarioIds = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('scenarioId')) ? [value.get('scenarioId') as string] : [],
  )))
  const invalidGroups = scenarioIds.filter((id) => readScenarioResponses(discussions, id) === null).length
  const responses = listScenarioResponses(discussions)
  const orphanScenarioIds = Array.from(new Set(responses.filter((response) => !readScenario(scenarios, response.scenarioId))
    .map((response) => response.scenarioId))).sort()
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} scenario response record(s) failed validation`)
  orphanScenarioIds.forEach((id) => issues.push(`Scenario responses target missing scenario ${id}`))
  return { healthy: issues.length === 0, responseCount: responses.length, invalidRecords, orphanScenarioIds, issues }
}
