import * as Y from 'yjs'
import { readHeuristic } from './heuristicsModel'

export const HEURISTIC_EXAMPLE_SCHEMA_VERSION = 1 as const
export type HeuristicExamplePolarity = 'positive' | 'negative'
export type HeuristicExampleAction = 'add' | 'remove'

export interface HeuristicExampleEvent {
  schemaVersion: typeof HEURISTIC_EXAMPLE_SCHEMA_VERSION
  eventId: string
  exampleId: string
  heuristicId: string
  action: HeuristicExampleAction
  parentEventId: string | null
  polarity: HeuristicExamplePolarity | null
  body: string | null
  participantId: string
  displayName: string
  timestamp: number
}

export interface HeuristicExampleHistory {
  id: string
  heuristicId: string
  polarity: HeuristicExamplePolarity
  body: string
  status: 'active' | 'removed'
  createdBy: string
  createdByDisplayName: string
  createdAt: number
  currentEventId: string
  events: HeuristicExampleEvent[]
}

export interface CreateHeuristicExampleInput {
  eventId: string
  exampleId: string
  heuristicId: string
  polarity: HeuristicExamplePolarity
  body: string
  participantId: string
  displayName: string
  timestamp: number
}

export interface RemoveHeuristicExampleInput {
  eventId: string
  exampleId: string
  heuristicId: string
  expectedCurrentEventId: string
  participantId: string
  displayName: string
  timestamp: number
}

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function canonicalHeuristicExampleEvent(event: HeuristicExampleEvent): string {
  return JSON.stringify({
    schemaVersion: event.schemaVersion, eventId: event.eventId, exampleId: event.exampleId,
    heuristicId: event.heuristicId, action: event.action, parentEventId: event.parentEventId,
    polarity: event.polarity, body: event.body, participantId: event.participantId,
    displayName: event.displayName, timestamp: event.timestamp,
  })
}

export async function heuristicExampleEventSha256(event: HeuristicExampleEvent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalHeuristicExampleEvent(event))
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

const BUCKET_PREFIX = 'heuristic-examples:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_HEURISTIC = 100_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
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

function validEvent(value: unknown): value is HeuristicExampleEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'exampleId', 'heuristicId', 'action', 'parentEventId',
    'polarity', 'body', 'participantId', 'displayName', 'timestamp',
  ])) return false
  const event = value as Partial<HeuristicExampleEvent>
  if (event.schemaVersion !== HEURISTIC_EXAMPLE_SCHEMA_VERSION || !stableId(event.eventId) ||
    !stableId(event.exampleId) || !stableId(event.heuristicId) || !stableId(event.participantId) ||
    !validText(event.displayName, 200) || !validTimestamp(event.timestamp)) return false
  if (event.action === 'add') {
    return event.parentEventId === null && (event.polarity === 'positive' || event.polarity === 'negative') &&
      validText(event.body, 100_000)
  }
  return event.action === 'remove' && stableId(event.parentEventId) &&
    event.polarity === null && event.body === null
}

const bucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(BUCKET_PREFIX))

function eventsFor(collection: Y.Map<unknown>, heuristicId: string): HeuristicExampleEvent[] | null {
  const raw: HeuristicExampleEvent[] = []
  for (const [, bucket] of bucketEntries(collection)) {
    if (!(bucket instanceof Y.Map)) continue
    if (bucket.get('heuristicId') !== heuristicId) continue
    if (!exactYKeys(bucket, ['heuristicId', 'events']) || !(bucket.get('events') instanceof Y.Map)) return null
    for (const event of (bucket.get('events') as Y.Map<unknown>).values()) {
      if (!validEvent(event) || event.heuristicId !== heuristicId) return null
      raw.push(event)
      if (raw.length > MAX_EVENTS_PER_HEURISTIC) return null
    }
  }
  const byId = new Map<string, HeuristicExampleEvent>()
  for (const event of raw) {
    const previous = byId.get(event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    byId.set(event.eventId, event)
  }
  return Array.from(byId.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId))
}

function projectExample(events: HeuristicExampleEvent[]): HeuristicExampleHistory | null {
  const roots = events.filter(({ action, parentEventId }) => action === 'add' && parentEventId === null)
  if (roots.length !== 1) return null
  const root = roots[0]
  if (events.some((event) => event.exampleId !== root.exampleId || event.heuristicId !== root.heuristicId ||
    (event.action === 'remove' && event.parentEventId !== root.eventId))) return null
  const removals = events.filter(({ action }) => action === 'remove')
  const current = removals.length ? removals[removals.length - 1] : root
  return {
    id: root.exampleId,
    heuristicId: root.heuristicId,
    polarity: root.polarity!,
    body: root.body!,
    status: removals.length ? 'removed' : 'active',
    createdBy: root.participantId,
    createdByDisplayName: root.displayName,
    createdAt: root.timestamp,
    currentEventId: current.eventId,
    events: events.map((event) => ({ ...event })),
  }
}

function appendEvent(collection: Y.Map<unknown>, event: HeuristicExampleEvent): void {
  const existing = eventsFor(collection, event.heuristicId)
  if (existing === null) throw new Error('Heuristic example history is invalid')
  const replay = existing.find(({ eventId }) => eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Heuristic example event ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS_PER_HEURISTIC) throw new Error('Heuristic example event limit reached')
  const bucketKey = `${BUCKET_PREFIX}${peerKey(collection, event.heuristicId)}`
  const storedBucket = collection.get(bucketKey)
  if (storedBucket !== undefined && (!(storedBucket instanceof Y.Map) || storedBucket.get('heuristicId') !== event.heuristicId)) {
    throw new Error('Heuristic example bucket identity conflict')
  }
  let bucket = storedBucket instanceof Y.Map ? storedBucket : undefined
  const operation = () => {
    if (!bucket) {
      if (bucketEntries(collection).length >= MAX_BUCKETS) throw new Error('Heuristic example bucket limit reached')
      bucket = new Y.Map<unknown>()
      bucket.set('heuristicId', event.heuristicId)
      bucket.set('events', new Y.Map<HeuristicExampleEvent>())
      collection.set(bucketKey, bucket)
    }
    ;(bucket.get('events') as Y.Map<HeuristicExampleEvent>).set(peerKey(collection, event.eventId), event)
  }
  if (collection.doc) collection.doc.transact(operation, 'syzygy-heuristic-examples')
  else operation()
}

export function readHeuristicExampleHistories(
  collection: Y.Map<unknown>,
  heuristicId: string,
): HeuristicExampleHistory[] | null {
  if (!stableId(heuristicId)) return null
  const events = eventsFor(collection, heuristicId)
  if (events === null) return null
  const ids = Array.from(new Set(events.map(({ exampleId }) => exampleId))).sort()
  const projected = ids.map((id) => projectExample(events.filter(({ exampleId }) => exampleId === id)))
  return projected.some((value) => value === null) ? null : projected as HeuristicExampleHistory[]
}

export function readHeuristicExampleEvent(
  collection: Y.Map<unknown>, heuristicId: string, exampleId: string, eventId: string,
): HeuristicExampleEvent | null {
  const history = readHeuristicExampleHistories(collection, heuristicId)
    ?.find((candidate) => candidate.id === exampleId)
  const event = history?.events.find((candidate) => candidate.eventId === eventId)
  return event ? { ...event } : null
}

export function listActiveHeuristicExamples(collection: Y.Map<unknown>, heuristicId: string) {
  return (readHeuristicExampleHistories(collection, heuristicId) ?? []).filter(({ status }) => status === 'active')
}

export function createHeuristicExample(
  discussions: Y.Map<unknown>,
  heuristics: Y.Map<unknown>,
  input: CreateHeuristicExampleInput,
): HeuristicExampleHistory {
  if (!readHeuristic(heuristics, input.heuristicId)) throw new Error('Heuristic not found or invalid')
  const event: HeuristicExampleEvent = {
    schemaVersion: HEURISTIC_EXAMPLE_SCHEMA_VERSION,
    eventId: input.eventId,
    exampleId: input.exampleId,
    heuristicId: input.heuristicId,
    action: 'add',
    parentEventId: null,
    polarity: input.polarity,
    body: input.body,
    participantId: input.participantId,
    displayName: input.displayName,
    timestamp: input.timestamp,
  }
  if (!validEvent(event)) throw new Error('Invalid heuristic example')
  const existing = eventsFor(discussions, input.heuristicId)
  if (existing === null) throw new Error('Heuristic example history is invalid')
  if (existing.some(({ eventId }) => eventId === event.eventId)) {
    appendEvent(discussions, event)
    const replayed = readHeuristicExampleHistories(discussions, input.heuristicId)
      ?.find(({ id }) => id === input.exampleId)
    if (!replayed) throw new Error('Heuristic example replay did not resolve')
    return replayed
  }
  const histories = readHeuristicExampleHistories(discussions, input.heuristicId)
  if (histories === null) throw new Error('Heuristic example history is invalid')
  if (histories.some(({ id }) => id === input.exampleId)) throw new Error('Heuristic example already exists')
  appendEvent(discussions, event)
  return readHeuristicExampleHistories(discussions, input.heuristicId)!.find(({ id }) => id === input.exampleId)!
}

export function removeHeuristicExample(
  discussions: Y.Map<unknown>,
  heuristics: Y.Map<unknown>,
  input: RemoveHeuristicExampleInput,
): HeuristicExampleHistory {
  if (!readHeuristic(heuristics, input.heuristicId)) throw new Error('Heuristic not found or invalid')
  const event: HeuristicExampleEvent = {
    schemaVersion: HEURISTIC_EXAMPLE_SCHEMA_VERSION,
    eventId: input.eventId,
    exampleId: input.exampleId,
    heuristicId: input.heuristicId,
    action: 'remove',
    parentEventId: input.expectedCurrentEventId,
    polarity: null,
    body: null,
    participantId: input.participantId,
    displayName: input.displayName,
    timestamp: input.timestamp,
  }
  if (!validEvent(event)) throw new Error('Invalid heuristic example removal')
  const existing = eventsFor(discussions, input.heuristicId)
  if (existing === null) throw new Error('Heuristic example history is invalid')
  if (existing.some(({ eventId }) => eventId === event.eventId)) {
    appendEvent(discussions, event)
    const replayed = readHeuristicExampleHistories(discussions, input.heuristicId)
      ?.find(({ id }) => id === input.exampleId)
    if (!replayed) throw new Error('Heuristic example removal replay did not resolve')
    return replayed
  }
  const current = readHeuristicExampleHistories(discussions, input.heuristicId)?.find(({ id }) => id === input.exampleId)
  if (!current || current.status !== 'active' || current.currentEventId !== input.expectedCurrentEventId) {
    throw new Error('Heuristic example changed or was already removed')
  }
  appendEvent(discussions, event)
  return readHeuristicExampleHistories(discussions, input.heuristicId)!.find(({ id }) => id === input.exampleId)!
}

export function inspectHeuristicExamples(discussions: Y.Map<unknown>, heuristics: Y.Map<unknown>) {
  const entries = bucketEntries(discussions)
  const heuristicIds = Array.from(new Set(entries.flatMap(([, bucket]) =>
    bucket instanceof Y.Map && stableId(bucket.get('heuristicId')) ? [bucket.get('heuristicId') as string] : []))).sort()
  const invalidBuckets = entries.filter(([, bucket]) => !(bucket instanceof Y.Map) ||
    !exactYKeys(bucket, ['heuristicId', 'events']) || !stableId(bucket.get('heuristicId')) ||
    !(bucket.get('events') instanceof Y.Map)).length
  const invalidGroups = heuristicIds.filter((id) => readHeuristicExampleHistories(discussions, id) === null).length
  const histories = heuristicIds.flatMap((id) => readHeuristicExampleHistories(discussions, id) ?? [])
  const orphanHeuristicIds = heuristicIds.filter((id) => !readHeuristic(heuristics, id))
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} heuristic example record(s) failed validation`)
  orphanHeuristicIds.forEach((id) => issues.push(`Heuristic examples target missing heuristic ${id}`))
  return {
    healthy: issues.length === 0,
    exampleCount: histories.filter(({ status }) => status === 'active').length,
    removedCount: histories.filter(({ status }) => status === 'removed').length,
    positiveCount: histories.filter(({ status, polarity }) => status === 'active' && polarity === 'positive').length,
    negativeCount: histories.filter(({ status, polarity }) => status === 'active' && polarity === 'negative').length,
    invalidRecords,
    orphanHeuristicIds,
    issues,
  }
}
