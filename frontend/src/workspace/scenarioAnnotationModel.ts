import * as Y from 'yjs'
import { readScenario } from './scenarioModel'

export const SCENARIO_ANNOTATION_SCHEMA_VERSION = 1 as const
export type ScenarioAnnotationKind = 'flag' | 'note'
export type ScenarioAnnotationAction = 'create' | 'edit' | 'resolve' | 'reopen'
export type ScenarioAnnotationStatus = 'open' | 'resolved'

export interface ScenarioAnnotationEvent {
  schemaVersion: typeof SCENARIO_ANNOTATION_SCHEMA_VERSION
  eventId: string
  annotationId: string
  scenarioId: string
  turnId: string | null
  kind: ScenarioAnnotationKind
  action: ScenarioAnnotationAction
  body: string | null
  authorId: string
  displayName: string
  timestamp: number
  parentEventId: string | null
}

export interface ScenarioAnnotation {
  id: string
  scenarioId: string
  turnId: string | null
  kind: ScenarioAnnotationKind
  body: string
  status: ScenarioAnnotationStatus
  createdBy: string
  createdByDisplayName: string
  createdAt: number
  currentEventId: string
  lastActionBy: string
  lastActionDisplayName: string
  lastActionAt: number
  resolvedBy: string | null
  resolvedAt: number | null
  events: ScenarioAnnotationEvent[]
}

export interface CreateScenarioAnnotationInput {
  annotationId: string
  eventId: string
  scenarioId: string
  turnId?: string | null
  kind: ScenarioAnnotationKind
  body: string
  authorId: string
  displayName: string
  timestamp: number
}

export interface UpdateScenarioAnnotationInput {
  annotationId: string
  eventId: string
  scenarioId: string
  expectedCurrentEventId: string
  body: string
  authorId: string
  displayName: string
  timestamp: number
}

export interface SetScenarioAnnotationResolutionInput {
  annotationId: string
  eventId: string
  scenarioId: string
  expectedCurrentEventId: string
  resolved: boolean
  authorId: string
  displayName: string
  timestamp: number
}

const ANNOTATION_BUCKET_PREFIX = 'scenario-annotations:v1:'
const kinds = new Set<ScenarioAnnotationKind>(['flag', 'note'])
const actions = new Set<ScenarioAnnotationAction>(['create', 'edit', 'resolve', 'reopen'])
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_SCENARIO = 100_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenario-annotations')
  else operation()
}
const annotationBucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(ANNOTATION_BUCKET_PREFIX))

function validEvent(value: unknown): value is ScenarioAnnotationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'annotationId', 'scenarioId', 'turnId', 'kind', 'action', 'body',
    'authorId', 'displayName', 'timestamp', 'parentEventId',
  ])) return false
  const event = value as Partial<ScenarioAnnotationEvent>
  if (event.schemaVersion !== SCENARIO_ANNOTATION_SCHEMA_VERSION || !stableId(event.eventId) ||
    !stableId(event.annotationId) || !stableId(event.scenarioId) ||
    (event.turnId !== null && !stableId(event.turnId)) || typeof event.kind !== 'string' ||
    !kinds.has(event.kind as ScenarioAnnotationKind) || typeof event.action !== 'string' ||
    !actions.has(event.action as ScenarioAnnotationAction) || !stableId(event.authorId) ||
    !validText(event.displayName, 200) || !validTimestamp(event.timestamp) ||
    (event.parentEventId !== null && !stableId(event.parentEventId))) return false
  if (event.action === 'create') return event.parentEventId === null && validText(event.body, 50_000)
  if (event.parentEventId === null) return false
  return event.action === 'edit' ? validText(event.body, 50_000) : event.body === null
}

function eventsFor(collection: Y.Map<unknown>, scenarioId: string): ScenarioAnnotationEvent[] | null {
  const buckets = annotationBucketEntries(collection).filter(([, value]) =>
    value instanceof Y.Map && value.get('scenarioId') === scenarioId,
  ) as Array<[string, Y.Map<unknown>]>
  const raw: ScenarioAnnotationEvent[] = []
  for (const [, bucket] of buckets) {
    if (!exactYKeys(bucket, ['scenarioId', 'events'])) return null
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) return null
    for (const value of events.values()) {
      if (!validEvent(value) || value.scenarioId !== scenarioId) return null
      raw.push(value)
      if (raw.length > MAX_EVENTS_PER_SCENARIO) return null
    }
  }
  const byEventId = new Map<string, ScenarioAnnotationEvent>()
  for (const event of raw) {
    const previous = byEventId.get(event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    byEventId.set(event.eventId, event)
  }
  return Array.from(byEventId.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId) || left.authorId.localeCompare(right.authorId))
}

function projectAnnotation(events: ScenarioAnnotationEvent[]): ScenarioAnnotation | null {
  const roots = events.filter((event) => event.action === 'create' && event.parentEventId === null)
  if (roots.length !== 1) return null
  const root = roots[0]
  if (events.some((event) => event.annotationId !== root.annotationId || event.scenarioId !== root.scenarioId ||
    event.turnId !== root.turnId || event.kind !== root.kind)) return null
  const byId = new Map(events.map((event) => [event.eventId, event]))
  if (byId.size !== events.length) return null
  for (const event of events) {
    if (event === root) continue
    if (!event.parentEventId || !byId.has(event.parentEventId)) return null
    const seen = new Set<string>()
    let cursor: ScenarioAnnotationEvent | undefined = event
    while (cursor && cursor.parentEventId !== null) {
      if (seen.has(cursor.eventId)) return null
      seen.add(cursor.eventId)
      cursor = byId.get(cursor.parentEventId)
    }
    if (cursor?.eventId !== root.eventId) return null
  }
  const parentIds = new Set(events.flatMap((event) => event.parentEventId ? [event.parentEventId] : []))
  const leaves = events.filter((event) => !parentIds.has(event.eventId))
  const sortedLeaves = [...leaves].sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId) || left.authorId.localeCompare(right.authorId))
  const current = sortedLeaves[sortedLeaves.length - 1]
  if (!current) return null
  const lineage: ScenarioAnnotationEvent[] = []
  let cursor: ScenarioAnnotationEvent | undefined = current
  while (cursor) {
    lineage.push(cursor)
    cursor = cursor.parentEventId ? byId.get(cursor.parentEventId) : undefined
  }
  lineage.reverse()
  let status: ScenarioAnnotationStatus = 'open'
  let body = root.body!
  let resolvedBy: string | null = null
  let resolvedAt: number | null = null
  for (const event of lineage.slice(1)) {
    if (event.action === 'edit') body = event.body!
    if (event.action === 'resolve') { status = 'resolved'; resolvedBy = event.authorId; resolvedAt = event.timestamp }
    if (event.action === 'reopen') { status = 'open'; resolvedBy = null; resolvedAt = null }
  }
  return {
    id: root.annotationId, scenarioId: root.scenarioId, turnId: root.turnId, kind: root.kind, body, status,
    createdBy: root.authorId, createdByDisplayName: root.displayName, createdAt: root.timestamp,
    currentEventId: current.eventId, lastActionBy: current.authorId,
    lastActionDisplayName: current.displayName, lastActionAt: current.timestamp,
    resolvedBy, resolvedAt, events: events.map((event) => ({ ...event })),
  }
}

export function readScenarioAnnotations(collection: Y.Map<unknown>, scenarioId: string): ScenarioAnnotation[] | null {
  if (!stableId(scenarioId)) return null
  const events = eventsFor(collection, scenarioId)
  if (events === null) return null
  const annotationIds = Array.from(new Set(events.map((event) => event.annotationId))).sort()
  const projected = annotationIds.map((id) => projectAnnotation(events.filter((event) => event.annotationId === id)))
  return projected.some((value) => value === null) ? null : projected as ScenarioAnnotation[]
}

function requireTarget(scenarios: Y.Map<unknown>, scenarioId: string, turnId: string | null) {
  const scenario = readScenario(scenarios, scenarioId)
  if (!scenario) throw new Error('Scenario not found or invalid')
  if (turnId !== null && !scenario.turns.some((turn) => turn.id === turnId)) throw new Error('Scenario turn not found or invalid')
}

function appendEvent(collection: Y.Map<unknown>, event: ScenarioAnnotationEvent): void {
  const existing = eventsFor(collection, event.scenarioId)
  if (existing === null) throw new Error('Scenario annotation history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Scenario annotation event ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS_PER_SCENARIO) throw new Error('Scenario annotation history limit reached')
  const bucketKey = `${ANNOTATION_BUCKET_PREFIX}${peerKey(collection, event.scenarioId)}`
  let bucket = collection.get(bucketKey)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || bucket.get('scenarioId') !== event.scenarioId)) {
    throw new Error('Scenario annotation bucket identity conflict')
  }
  if (!(bucket instanceof Y.Map)) {
    if (annotationBucketEntries(collection).length >= MAX_BUCKETS) throw new Error('Scenario annotation bucket limit reached')
    bucket = new Y.Map<unknown>()
    const events = new Y.Map<ScenarioAnnotationEvent>()
    transact(collection, () => {
      ;(bucket as Y.Map<unknown>).set('scenarioId', event.scenarioId)
      ;(bucket as Y.Map<unknown>).set('events', events)
      events.set(peerKey(collection, event.eventId), event)
      collection.set(bucketKey, bucket)
    })
  } else {
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Scenario annotation history is invalid')
    transact(collection, () => events.set(peerKey(collection, event.eventId), event))
  }
}

export function createScenarioAnnotation(
  discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>, input: CreateScenarioAnnotationInput,
): ScenarioAnnotation {
  const turnId = input.turnId ?? null
  if (!stableId(input.annotationId) || !stableId(input.eventId) || !stableId(input.scenarioId) ||
    (turnId !== null && !stableId(turnId)) || !kinds.has(input.kind) || !validText(input.body, 50_000) ||
    !stableId(input.authorId) || !validText(input.displayName, 200) || !validTimestamp(input.timestamp)) {
    throw new Error('Invalid scenario annotation')
  }
  requireTarget(scenarios, input.scenarioId, turnId)
  const current = readScenarioAnnotations(discussions, input.scenarioId)
  if (current === null) throw new Error('Scenario annotation history is invalid')
  const event: ScenarioAnnotationEvent = {
    schemaVersion: SCENARIO_ANNOTATION_SCHEMA_VERSION, eventId: input.eventId,
    annotationId: input.annotationId, scenarioId: input.scenarioId, turnId, kind: input.kind,
    action: 'create', body: input.body, authorId: input.authorId, displayName: input.displayName,
    timestamp: input.timestamp, parentEventId: null,
  }
  const replay = eventsFor(discussions, input.scenarioId)?.find((candidate) => candidate.eventId === input.eventId)
  if (replay && JSON.stringify(replay) === JSON.stringify(event)) return current.find((item) => item.id === input.annotationId)!
  if (current.some((annotation) => annotation.id === input.annotationId)) throw new Error('Scenario annotation already exists')
  appendEvent(discussions, event)
  return readScenarioAnnotations(discussions, input.scenarioId)!.find((item) => item.id === input.annotationId)!
}

function currentAnnotation(collection: Y.Map<unknown>, scenarioId: string, annotationId: string) {
  const annotations = readScenarioAnnotations(collection, scenarioId)
  if (annotations === null) throw new Error('Scenario annotation history is invalid')
  const annotation = annotations.find((item) => item.id === annotationId)
  if (!annotation) throw new Error('Scenario annotation not found')
  return annotation
}

export function updateScenarioAnnotation(
  discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>, input: UpdateScenarioAnnotationInput,
): ScenarioAnnotation {
  if (!stableId(input.annotationId) || !stableId(input.eventId) || !stableId(input.scenarioId) ||
    !stableId(input.expectedCurrentEventId) || !validText(input.body, 50_000) || !stableId(input.authorId) ||
    !validText(input.displayName, 200) || !validTimestamp(input.timestamp)) throw new Error('Invalid scenario annotation edit')
  const current = currentAnnotation(discussions, input.scenarioId, input.annotationId)
  requireTarget(scenarios, input.scenarioId, current.turnId)
  const event: ScenarioAnnotationEvent = {
    schemaVersion: SCENARIO_ANNOTATION_SCHEMA_VERSION, eventId: input.eventId,
    annotationId: input.annotationId, scenarioId: input.scenarioId, turnId: current.turnId, kind: current.kind,
    action: 'edit', body: input.body, authorId: input.authorId, displayName: input.displayName,
    timestamp: input.timestamp, parentEventId: input.expectedCurrentEventId,
  }
  const replay = eventsFor(discussions, input.scenarioId)?.find((candidate) => candidate.eventId === input.eventId)
  if (replay) { appendEvent(discussions, event); return currentAnnotation(discussions, input.scenarioId, input.annotationId) }
  if (current.status !== 'open') throw new Error('Resolved scenario annotation must be reopened before editing')
  if (current.currentEventId !== input.expectedCurrentEventId) throw new Error('Scenario annotation revision conflict')
  appendEvent(discussions, event)
  return currentAnnotation(discussions, input.scenarioId, input.annotationId)
}

export function setScenarioAnnotationResolution(
  discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>, input: SetScenarioAnnotationResolutionInput,
): ScenarioAnnotation {
  if (!stableId(input.annotationId) || !stableId(input.eventId) || !stableId(input.scenarioId) ||
    !stableId(input.expectedCurrentEventId) || !stableId(input.authorId) || !validText(input.displayName, 200) ||
    !validTimestamp(input.timestamp)) throw new Error('Invalid scenario annotation resolution')
  const current = currentAnnotation(discussions, input.scenarioId, input.annotationId)
  requireTarget(scenarios, input.scenarioId, current.turnId)
  const event: ScenarioAnnotationEvent = {
    schemaVersion: SCENARIO_ANNOTATION_SCHEMA_VERSION, eventId: input.eventId,
    annotationId: input.annotationId, scenarioId: input.scenarioId, turnId: current.turnId, kind: current.kind,
    action: input.resolved ? 'resolve' : 'reopen', body: null, authorId: input.authorId,
    displayName: input.displayName, timestamp: input.timestamp, parentEventId: input.expectedCurrentEventId,
  }
  const replay = eventsFor(discussions, input.scenarioId)?.find((candidate) => candidate.eventId === input.eventId)
  if (replay) { appendEvent(discussions, event); return currentAnnotation(discussions, input.scenarioId, input.annotationId) }
  if (current.currentEventId !== input.expectedCurrentEventId) throw new Error('Scenario annotation revision conflict')
  if (input.resolved === (current.status === 'resolved')) throw new Error(`Scenario annotation is already ${current.status}`)
  appendEvent(discussions, event)
  return currentAnnotation(discussions, input.scenarioId, input.annotationId)
}

export function listScenarioAnnotationSummaries(discussions: Y.Map<unknown>): ScenarioAnnotation[] {
  const entries = annotationBucketEntries(discussions)
  if (entries.length > MAX_BUCKETS) return []
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('scenarioId')) ? [value.get('scenarioId') as string] : [],
  ))).sort()
  return ids.flatMap((id) => readScenarioAnnotations(discussions, id) ?? [])
}

export function inspectScenarioAnnotations(discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>) {
  const entries = annotationBucketEntries(discussions)
  const bucketValues = entries.map(([, value]) => value)
  const validBucket = (value: unknown): value is Y.Map<unknown> =>
    value instanceof Y.Map && exactYKeys(value, ['scenarioId', 'events']) && stableId(value.get('scenarioId')) &&
    value.get('events') instanceof Y.Map
  const invalidBuckets = bucketValues.filter((value) => !validBucket(value)).length
  const scenarioIds = Array.from(new Set(bucketValues.filter(validBucket).map((value) => value.get('scenarioId') as string)))
  const invalidGroups = scenarioIds.filter((id) => readScenarioAnnotations(discussions, id) === null).length
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const annotations = listScenarioAnnotationSummaries(discussions)
  const issues: string[] = []
  if (invalidRecords > 0) issues.push(`${invalidRecords} scenario annotation record(s) failed validation`)
  const orphanScenarioIds = Array.from(new Set(annotations.filter((item) => !readScenario(scenarios, item.scenarioId))
    .map((item) => item.scenarioId))).sort()
  orphanScenarioIds.forEach((id) => issues.push(`Scenario annotations target missing scenario ${id}`))
  const orphanTurnTargets = annotations.flatMap((item) => {
    const scenario = readScenario(scenarios, item.scenarioId)
    return item.turnId !== null && scenario && !scenario.turns.some((turn) => turn.id === item.turnId)
      ? [{ scenarioId: item.scenarioId, turnId: item.turnId }] : []
  }).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId) || left.turnId.localeCompare(right.turnId))
  orphanTurnTargets.forEach(({ scenarioId, turnId }) => issues.push(`Scenario annotation targets missing turn ${scenarioId}/${turnId}`))
  return { healthy: issues.length === 0, annotationCount: annotations.length, invalidRecords, orphanScenarioIds, orphanTurnTargets, issues }
}
