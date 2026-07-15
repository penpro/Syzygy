import * as Y from 'yjs'
import { readScenario } from './scenarioModel'

export const SCENARIO_VOTE_SCHEMA_VERSION = 1 as const
export type ScenarioVoteChoice = 'support' | 'oppose' | 'abstain' | 'withdrawn'

export interface ScenarioVoteEvent {
  schemaVersion: typeof SCENARIO_VOTE_SCHEMA_VERSION
  eventId: string
  scenarioId: string
  participantId: string
  displayName: string
  choice: ScenarioVoteChoice
  timestamp: number
}

export interface CastScenarioVoteInput {
  eventId: string
  scenarioId: string
  participantId: string
  displayName: string
  choice: ScenarioVoteChoice
  timestamp: number
}

export interface ScenarioVoteSummary {
  scenarioId: string
  counts: Record<Exclude<ScenarioVoteChoice, 'withdrawn'>, number>
  activeVotes: ScenarioVoteEvent[]
  history: ScenarioVoteEvent[]
}

const choices = new Set<ScenarioVoteChoice>(['support', 'oppose', 'abstain', 'withdrawn'])
const VOTE_BUCKET_PREFIX = 'scenario-votes:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_SCENARIO = 100_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const validDisplayName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenario-votes')
  else operation()
}

function validEvent(value: unknown): value is ScenarioVoteEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'eventId', 'scenarioId', 'participantId', 'displayName', 'choice', 'timestamp',
  ])) return false
  const event = value as Partial<ScenarioVoteEvent>
  return event.schemaVersion === SCENARIO_VOTE_SCHEMA_VERSION && stableId(event.eventId) &&
    stableId(event.scenarioId) && stableId(event.participantId) && validDisplayName(event.displayName) &&
    typeof event.choice === 'string' && choices.has(event.choice as ScenarioVoteChoice) && validTimestamp(event.timestamp)
}

function bucketsFor(collection: Y.Map<unknown>, scenarioId: string): Array<[string, Y.Map<unknown>]> {
  return Array.from(collection.entries()).filter(([key, value]) =>
    key.startsWith(VOTE_BUCKET_PREFIX) && value instanceof Y.Map && value.get('scenarioId') === scenarioId,
  ) as Array<[string, Y.Map<unknown>]>
}

const voteBucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(VOTE_BUCKET_PREFIX))

function eventsFor(collection: Y.Map<unknown>, scenarioId: string): ScenarioVoteEvent[] | null {
  const buckets = bucketsFor(collection, scenarioId)
  const raw: ScenarioVoteEvent[] = []
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
  const byEventId = new Map<string, ScenarioVoteEvent>()
  for (const event of raw) {
    const previous = byEventId.get(event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    byEventId.set(event.eventId, event)
  }
  return Array.from(byEventId.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId) || left.participantId.localeCompare(right.participantId))
}

export function castScenarioVote(
  discussions: Y.Map<unknown>,
  scenarios: Y.Map<unknown>,
  input: CastScenarioVoteInput,
): ScenarioVoteSummary {
  if (!stableId(input.eventId) || !stableId(input.scenarioId) || !stableId(input.participantId) ||
    !validDisplayName(input.displayName) || !choices.has(input.choice) || !validTimestamp(input.timestamp)) {
    throw new Error('Invalid scenario vote')
  }
  if (!readScenario(scenarios, input.scenarioId)) throw new Error('Scenario not found or invalid')
  const event: ScenarioVoteEvent = { schemaVersion: SCENARIO_VOTE_SCHEMA_VERSION, ...input }
  const existing = eventsFor(discussions, input.scenarioId)
  if (existing === null) throw new Error('Scenario vote history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === input.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Scenario vote event ID was reused')
    return readScenarioVotes(discussions, input.scenarioId)!
  }
  if (existing.length >= MAX_EVENTS_PER_SCENARIO) throw new Error('Scenario vote history limit reached')

  const bucketKey = `${VOTE_BUCKET_PREFIX}${peerKey(discussions, input.scenarioId)}`
  let bucket = discussions.get(bucketKey)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || bucket.get('scenarioId') !== input.scenarioId)) {
    throw new Error('Scenario vote bucket identity conflict')
  }
  if (!(bucket instanceof Y.Map)) {
    if (voteBucketEntries(discussions).length >= MAX_BUCKETS) throw new Error('Scenario vote bucket limit reached')
    bucket = new Y.Map<unknown>()
    const events = new Y.Map<ScenarioVoteEvent>()
    transact(discussions, () => {
      ;(bucket as Y.Map<unknown>).set('scenarioId', input.scenarioId)
      ;(bucket as Y.Map<unknown>).set('events', events)
      events.set(peerKey(discussions, input.eventId), event)
      discussions.set(bucketKey, bucket)
    })
  } else {
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Scenario vote history is invalid')
    transact(discussions, () => events.set(peerKey(discussions, input.eventId), event))
  }
  return readScenarioVotes(discussions, input.scenarioId)!
}

export function readScenarioVotes(discussions: Y.Map<unknown>, scenarioId: string): ScenarioVoteSummary | null {
  if (!stableId(scenarioId)) return null
  const history = eventsFor(discussions, scenarioId)
  if (history === null || history.length === 0) return null
  const current = new Map<string, ScenarioVoteEvent>()
  for (const event of history) current.set(event.participantId, event)
  const activeVotes = Array.from(current.values()).filter((event) => event.choice !== 'withdrawn')
    .sort((left, right) => left.participantId.localeCompare(right.participantId))
  const counts = { support: 0, oppose: 0, abstain: 0 }
  activeVotes.forEach((event) => { counts[event.choice as keyof typeof counts] += 1 })
  return { scenarioId, counts, activeVotes, history }
}

export function listScenarioVoteSummaries(discussions: Y.Map<unknown>): ScenarioVoteSummary[] {
  const entries = voteBucketEntries(discussions)
  if (entries.length > MAX_BUCKETS) return []
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('scenarioId')) ? [value.get('scenarioId') as string] : [],
  ))).sort()
  return ids.map((id) => readScenarioVotes(discussions, id)).filter((value): value is ScenarioVoteSummary => value !== null)
}

export function inspectScenarioVotes(discussions: Y.Map<unknown>, scenarios: Y.Map<unknown>) {
  const summaries = listScenarioVoteSummaries(discussions)
  const entries = voteBucketEntries(discussions)
  const bucketValues = entries.map(([, value]) => value)
  const validBucket = (value: unknown): value is Y.Map<unknown> =>
    value instanceof Y.Map && exactYKeys(value, ['scenarioId', 'events']) && stableId(value.get('scenarioId')) &&
    value.get('events') instanceof Y.Map
  const invalidBuckets = bucketValues.filter((value) => !validBucket(value)).length
  const validScenarioIds = Array.from(new Set(bucketValues.filter(validBucket)
    .map((value) => value.get('scenarioId') as string)))
  const invalidGroups = validScenarioIds.filter((id) => readScenarioVotes(discussions, id) === null).length
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const orphanScenarioIds = summaries.filter((summary) => !readScenario(scenarios, summary.scenarioId))
    .map((summary) => summary.scenarioId).sort()
  const issues: string[] = []
  if (invalidRecords > 0) issues.push(`${invalidRecords} scenario vote record(s) failed validation`)
  orphanScenarioIds.forEach((id) => issues.push(`Scenario votes target missing scenario ${id}`))
  return { healthy: issues.length === 0, summaryCount: summaries.length, invalidRecords, orphanScenarioIds, issues }
}
