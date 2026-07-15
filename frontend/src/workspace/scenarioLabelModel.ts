import * as Y from 'yjs'
import { readScenario } from './scenarioModel'

export const SCENARIO_LABEL_SCHEMA_VERSION = 1 as const
export type ScenarioLabelAction = 'create' | 'rename'
export type ScenarioLabelAssignmentAction = 'add' | 'remove'

export interface ScenarioLabelEvent {
  schemaVersion: typeof SCENARIO_LABEL_SCHEMA_VERSION
  eventId: string
  labelId: string
  action: ScenarioLabelAction
  name: string
  authorId: string
  timestamp: number
  parentEventId: string | null
}

export interface ScenarioLabel {
  id: string
  name: string
  createdBy: string
  createdAt: number
  currentEventId: string
  lastActionBy: string
  lastActionAt: number
  events: ScenarioLabelEvent[]
}

export interface ScenarioLabelAssignmentEvent {
  schemaVersion: typeof SCENARIO_LABEL_SCHEMA_VERSION
  eventId: string
  scenarioId: string
  labelId: string
  action: ScenarioLabelAssignmentAction
  authorId: string
  timestamp: number
  parentEventId: string | null
}

export interface ScenarioLabelAssignment {
  scenarioId: string
  labelId: string
  assigned: boolean
  currentEventId: string
  lastActionBy: string
  lastActionAt: number
  events: ScenarioLabelAssignmentEvent[]
}

export interface CreateScenarioLabelInput {
  labelId: string
  eventId: string
  name: string
  authorId: string
  timestamp: number
}

export interface RenameScenarioLabelInput extends CreateScenarioLabelInput {
  expectedCurrentEventId: string
}

export interface SetScenarioLabelAssignmentInput {
  scenarioId: string
  labelId: string
  eventId: string
  expectedCurrentEventId: string | null
  assigned: boolean
  authorId: string
  timestamp: number
}

const LABEL_PREFIX = 'scenario-labels:v1:'
const ASSIGNMENT_PREFIX = 'scenario-label-assignments:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS = 100_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) => `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenario-labels')
  else operation()
}
const prefixedEntries = (collection: Y.Map<unknown>, prefix: string) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(prefix))
const eventOrder = <T extends { timestamp: number; eventId: string; authorId: string }>(left: T, right: T) =>
  left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId) || left.authorId.localeCompare(right.authorId)

function validLabelEvent(value: unknown): value is ScenarioLabelEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'labelId', 'action', 'name', 'authorId', 'timestamp', 'parentEventId',
  ])) return false
  const event = value as Partial<ScenarioLabelEvent>
  return event.schemaVersion === SCENARIO_LABEL_SCHEMA_VERSION && stableId(event.eventId) &&
    stableId(event.labelId) && (event.action === 'create' || event.action === 'rename') && validName(event.name) &&
    stableId(event.authorId) && validTimestamp(event.timestamp) &&
    (event.parentEventId === null || stableId(event.parentEventId)) &&
    (event.action === 'create' ? event.parentEventId === null : event.parentEventId !== null)
}

function validAssignmentEvent(value: unknown): value is ScenarioLabelAssignmentEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'scenarioId', 'labelId', 'action', 'authorId', 'timestamp', 'parentEventId',
  ])) return false
  const event = value as Partial<ScenarioLabelAssignmentEvent>
  return event.schemaVersion === SCENARIO_LABEL_SCHEMA_VERSION && stableId(event.eventId) &&
    stableId(event.scenarioId) && stableId(event.labelId) && (event.action === 'add' || event.action === 'remove') &&
    stableId(event.authorId) && validTimestamp(event.timestamp) &&
    (event.parentEventId === null || stableId(event.parentEventId)) &&
    (event.action === 'add' || event.parentEventId !== null)
}

function groupedEvents<T>(
  collection: Y.Map<unknown>, prefix: string, fields: Record<string, string>, validator: (value: unknown) => value is T,
): T[] | null {
  const buckets = prefixedEntries(collection, prefix).filter(([, value]) =>
    value instanceof Y.Map && Object.entries(fields).every(([field, expected]) => value.get(field) === expected),
  ) as Array<[string, Y.Map<unknown>]>
  const raw: T[] = []
  for (const [, bucket] of buckets) {
    if (!exactYKeys(bucket, [...Object.keys(fields), 'events'])) return null
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) return null
    for (const event of events.values()) {
      if (!validator(event) || !Object.entries(fields).every(([field, expected]) => (event as Record<string, unknown>)[field] === expected)) return null
      raw.push(event)
      if (raw.length > MAX_EVENTS) return null
    }
  }
  const unique = new Map<string, T>()
  for (const event of raw) {
    const eventId = (event as { eventId: string }).eventId
    const previous = unique.get(eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    unique.set(eventId, event)
  }
  return Array.from(unique.values())
}

function projectLineage<T extends { eventId: string; parentEventId: string | null; timestamp: number; authorId: string }>(
  events: T[], isRoot: (event: T) => boolean,
): { root: T; current: T } | null {
  const roots = events.filter(isRoot)
  if (roots.length !== 1) return null
  const byId = new Map(events.map((event) => [event.eventId, event]))
  if (byId.size !== events.length) return null
  for (const event of events) {
    if (event === roots[0]) continue
    if (!event.parentEventId || !byId.has(event.parentEventId)) return null
    const seen = new Set<string>()
    let cursor: T | undefined = event
    while (cursor?.parentEventId) {
      if (seen.has(cursor.eventId)) return null
      seen.add(cursor.eventId)
      cursor = byId.get(cursor.parentEventId)
    }
    if (cursor?.eventId !== roots[0].eventId) return null
  }
  const parentIds = new Set(events.flatMap((event) => event.parentEventId ? [event.parentEventId] : []))
  const leaves = events.filter((event) => !parentIds.has(event.eventId)).sort(eventOrder)
  return leaves.length ? { root: roots[0], current: leaves[leaves.length - 1] } : null
}

function appendEvent<T extends { eventId: string }>(
  collection: Y.Map<unknown>, prefix: string, fields: Record<string, string>, event: T, validator: (value: unknown) => value is T,
): void {
  const existing = groupedEvents(collection, prefix, fields, validator)
  if (existing === null) throw new Error('Scenario label history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Scenario label event ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS) throw new Error('Scenario label history limit reached')
  const identity = Object.values(fields).join(':')
  const bucketKey = `${prefix}${peerKey(collection, identity)}`
  let bucket = collection.get(bucketKey)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || !Object.entries(fields).every(
    ([field, expected]) => (bucket as Y.Map<unknown>).get(field) === expected,
  ))) {
    throw new Error('Scenario label bucket identity conflict')
  }
  if (!(bucket instanceof Y.Map)) {
    if (prefixedEntries(collection, prefix).length >= MAX_BUCKETS) throw new Error('Scenario label bucket limit reached')
    bucket = new Y.Map<unknown>()
    const events = new Y.Map<T>()
    transact(collection, () => {
      Object.entries(fields).forEach(([field, value]) => (bucket as Y.Map<unknown>).set(field, value))
      ;(bucket as Y.Map<unknown>).set('events', events)
      events.set(peerKey(collection, event.eventId), event)
      collection.set(bucketKey, bucket)
    })
  } else {
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Scenario label history is invalid')
    transact(collection, () => events.set(peerKey(collection, event.eventId), event))
  }
}

export function readScenarioLabel(settings: Y.Map<unknown>, labelId: string): ScenarioLabel | null {
  if (!stableId(labelId)) return null
  const events = groupedEvents(settings, LABEL_PREFIX, { labelId }, validLabelEvent)
  if (events === null || events.some((event) => event.labelId !== labelId)) return null
  const lineage = projectLineage(events, (event) => event.action === 'create' && event.parentEventId === null)
  if (!lineage) return null
  return {
    id: labelId, name: lineage.current.name, createdBy: lineage.root.authorId, createdAt: lineage.root.timestamp,
    currentEventId: lineage.current.eventId, lastActionBy: lineage.current.authorId,
    lastActionAt: lineage.current.timestamp, events: [...events].sort(eventOrder).map((event) => ({ ...event })),
  }
}

export function listScenarioLabels(settings: Y.Map<unknown>): ScenarioLabel[] {
  const ids = Array.from(new Set(prefixedEntries(settings, LABEL_PREFIX).flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('labelId')) ? [value.get('labelId') as string] : [],
  ))).sort()
  return ids.flatMap((id) => readScenarioLabel(settings, id) ?? [])
}

export function createScenarioLabel(settings: Y.Map<unknown>, input: CreateScenarioLabelInput): ScenarioLabel {
  if (!stableId(input.labelId) || !stableId(input.eventId) || !validName(input.name) ||
    !stableId(input.authorId) || !validTimestamp(input.timestamp)) throw new Error('Invalid scenario label')
  const event: ScenarioLabelEvent = {
    schemaVersion: SCENARIO_LABEL_SCHEMA_VERSION, eventId: input.eventId, labelId: input.labelId,
    action: 'create', name: input.name, authorId: input.authorId, timestamp: input.timestamp, parentEventId: null,
  }
  const existing = groupedEvents(settings, LABEL_PREFIX, { labelId: input.labelId }, validLabelEvent)
  if (existing === null) throw new Error('Scenario label history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === input.eventId)
  if (replay) {
    appendEvent(settings, LABEL_PREFIX, { labelId: input.labelId }, event, validLabelEvent)
    const label = readScenarioLabel(settings, input.labelId)
    if (!label) throw new Error('Scenario label history is invalid')
    return label
  }
  if (existing.length > 0) throw new Error('Scenario label already exists')
  appendEvent(settings, LABEL_PREFIX, { labelId: input.labelId }, event, validLabelEvent)
  const label = readScenarioLabel(settings, input.labelId)
  if (!label) throw new Error('Scenario label history is invalid')
  return label
}

export function renameScenarioLabel(settings: Y.Map<unknown>, input: RenameScenarioLabelInput): ScenarioLabel {
  if (!stableId(input.labelId) || !stableId(input.eventId) || !stableId(input.expectedCurrentEventId) ||
    !validName(input.name) || !stableId(input.authorId) || !validTimestamp(input.timestamp)) throw new Error('Invalid scenario label rename')
  const current = readScenarioLabel(settings, input.labelId)
  if (!current) throw new Error('Scenario label not found or invalid')
  const event: ScenarioLabelEvent = {
    schemaVersion: SCENARIO_LABEL_SCHEMA_VERSION, eventId: input.eventId, labelId: input.labelId,
    action: 'rename', name: input.name, authorId: input.authorId, timestamp: input.timestamp,
    parentEventId: input.expectedCurrentEventId,
  }
  const replay = current.events.find((candidate) => candidate.eventId === input.eventId)
  if (replay) { appendEvent(settings, LABEL_PREFIX, { labelId: input.labelId }, event, validLabelEvent); return readScenarioLabel(settings, input.labelId)! }
  if (current.currentEventId !== input.expectedCurrentEventId) throw new Error('Scenario label revision conflict')
  appendEvent(settings, LABEL_PREFIX, { labelId: input.labelId }, event, validLabelEvent)
  return readScenarioLabel(settings, input.labelId)!
}

export function readScenarioLabelAssignment(settings: Y.Map<unknown>, scenarioId: string, labelId: string): ScenarioLabelAssignment | null {
  if (!stableId(scenarioId) || !stableId(labelId)) return null
  const events = groupedEvents(settings, ASSIGNMENT_PREFIX, { scenarioId, labelId }, validAssignmentEvent)
  if (events === null || events.length === 0) return null
  const lineage = projectLineage(events, (event) => event.action === 'add' && event.parentEventId === null)
  if (!lineage) return null
  return {
    scenarioId, labelId, assigned: lineage.current.action === 'add', currentEventId: lineage.current.eventId,
    lastActionBy: lineage.current.authorId, lastActionAt: lineage.current.timestamp,
    events: [...events].sort(eventOrder).map((event) => ({ ...event })),
  }
}

export function setScenarioLabelAssignment(
  settings: Y.Map<unknown>, scenarios: Y.Map<unknown>, input: SetScenarioLabelAssignmentInput,
): ScenarioLabelAssignment {
  if (!stableId(input.scenarioId) || !stableId(input.labelId) || !stableId(input.eventId) ||
    (input.expectedCurrentEventId !== null && !stableId(input.expectedCurrentEventId)) ||
    typeof input.assigned !== 'boolean' || !stableId(input.authorId) || !validTimestamp(input.timestamp)) {
    throw new Error('Invalid scenario label assignment')
  }
  if (!readScenario(scenarios, input.scenarioId)) throw new Error('Scenario not found or invalid')
  if (!readScenarioLabel(settings, input.labelId)) throw new Error('Scenario label not found or invalid')
  const existing = groupedEvents(settings, ASSIGNMENT_PREFIX, {
    scenarioId: input.scenarioId, labelId: input.labelId,
  }, validAssignmentEvent)
  if (existing === null) throw new Error('Scenario label assignment history is invalid')
  const current = readScenarioLabelAssignment(settings, input.scenarioId, input.labelId)
  if (existing.length > 0 && !current) throw new Error('Scenario label assignment history is invalid')
  const event: ScenarioLabelAssignmentEvent = {
    schemaVersion: SCENARIO_LABEL_SCHEMA_VERSION, eventId: input.eventId, scenarioId: input.scenarioId,
    labelId: input.labelId, action: input.assigned ? 'add' : 'remove', authorId: input.authorId,
    timestamp: input.timestamp, parentEventId: input.expectedCurrentEventId,
  }
  const replay = existing.find((candidate) => candidate.eventId === input.eventId)
  if (replay) {
    appendEvent(settings, ASSIGNMENT_PREFIX, { scenarioId: input.scenarioId, labelId: input.labelId }, event, validAssignmentEvent)
    return current!
  }
  if (!current && (!input.assigned || input.expectedCurrentEventId !== null)) throw new Error('Scenario label assignment revision conflict')
  if (current && current.currentEventId !== input.expectedCurrentEventId) throw new Error('Scenario label assignment revision conflict')
  if (current?.assigned === input.assigned) throw new Error(`Scenario label is already ${input.assigned ? 'assigned' : 'unassigned'}`)
  appendEvent(settings, ASSIGNMENT_PREFIX, { scenarioId: input.scenarioId, labelId: input.labelId }, event, validAssignmentEvent)
  return readScenarioLabelAssignment(settings, input.scenarioId, input.labelId)!
}

export function listScenarioIdsForLabel(settings: Y.Map<unknown>, labelId: string): string[] {
  if (!readScenarioLabel(settings, labelId)) return []
  const pairs = prefixedEntries(settings, ASSIGNMENT_PREFIX).flatMap(([, value]) =>
    value instanceof Y.Map && value.get('labelId') === labelId && stableId(value.get('scenarioId'))
      ? [value.get('scenarioId') as string] : [],
  )
  return Array.from(new Set(pairs)).filter((scenarioId) =>
    readScenarioLabelAssignment(settings, scenarioId, labelId)?.assigned === true,
  ).sort()
}

export function inspectScenarioLabels(settings: Y.Map<unknown>, scenarios: Y.Map<unknown>) {
  const labelEntries = prefixedEntries(settings, LABEL_PREFIX)
  const validLabelBucket = (value: unknown): value is Y.Map<unknown> => value instanceof Y.Map &&
    exactYKeys(value, ['labelId', 'events']) && stableId(value.get('labelId')) && value.get('events') instanceof Y.Map
  const invalidBuckets = labelEntries.filter(([, value]) => !validLabelBucket(value)).length
  const labelIds = Array.from(new Set(labelEntries.flatMap(([, value]) =>
    validLabelBucket(value) ? [value.get('labelId') as string] : [],
  )))
  const invalidLabels = labelIds.filter((id) => readScenarioLabel(settings, id) === null).length
  const assignmentEntries = prefixedEntries(settings, ASSIGNMENT_PREFIX)
  const validAssignmentBucket = (value: unknown): value is Y.Map<unknown> => value instanceof Y.Map &&
    exactYKeys(value, ['scenarioId', 'labelId', 'events']) && stableId(value.get('scenarioId')) &&
    stableId(value.get('labelId')) && value.get('events') instanceof Y.Map
  const invalidAssignmentBuckets = assignmentEntries.filter(([, value]) => !validAssignmentBucket(value)).length
  const assignmentPairs = Array.from(new Set(assignmentEntries.flatMap(([, value]) => validAssignmentBucket(value)
    ? [`${value.get('scenarioId')}\u0000${value.get('labelId')}`] : [],
  )))
  const assignments = assignmentPairs.flatMap((pair) => {
    const [scenarioId, labelId] = pair.split('\u0000')
    return readScenarioLabelAssignment(settings, scenarioId, labelId) ?? []
  })
  const invalidAssignments = assignmentPairs.length - assignments.length
  const orphanScenarioIds = Array.from(new Set(assignments.filter((item) => !readScenario(scenarios, item.scenarioId)).map((item) => item.scenarioId))).sort()
  const orphanLabelIds = Array.from(new Set(assignments.filter((item) => !readScenarioLabel(settings, item.labelId)).map((item) => item.labelId))).sort()
  const invalidRecords = invalidBuckets + invalidAssignmentBuckets + invalidLabels + invalidAssignments
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} scenario label record(s) failed validation`)
  orphanScenarioIds.forEach((id) => issues.push(`Scenario label assignments target missing scenario ${id}`))
  orphanLabelIds.forEach((id) => issues.push(`Scenario label assignments target missing label ${id}`))
  return {
    healthy: issues.length === 0, labelCount: listScenarioLabels(settings).length,
    assignmentCount: assignments.filter((item) => item.assigned).length, invalidRecords,
    orphanScenarioIds, orphanLabelIds, issues,
  }
}
