import * as Y from 'yjs'

export const SUGGESTION_SCHEMA_VERSION = 1 as const
export type SuggestionSourceKind = 'human' | 'model'
export type SuggestionDecisionKind = 'accepted' | 'rejected'
export type SuggestionStatus = 'pending' | SuggestionDecisionKind | 'conflicted'

export interface SuggestionProposalEvent {
  schemaVersion: typeof SUGGESTION_SCHEMA_VERSION
  kind: 'proposal'
  eventId: string
  suggestionId: string
  content: string
  sourceDocumentRevision: string
  authorId: string
  authorDisplayName: string
  timestamp: number
  sourceKind: SuggestionSourceKind
  providerId: string | null
  modelId: string | null
  runId: string | null
}

export interface SuggestionDecisionEvent {
  schemaVersion: typeof SUGGESTION_SCHEMA_VERSION
  kind: 'decision'
  eventId: string
  suggestionId: string
  proposalEventId: string
  decision: SuggestionDecisionKind
  reviewerId: string
  reviewerDisplayName: string
  timestamp: number
}

export type SuggestionEvent = SuggestionProposalEvent | SuggestionDecisionEvent

export interface CollaborativeSuggestion {
  id: string
  content: string
  sourceDocumentRevision: string
  proposal: SuggestionProposalEvent
  status: SuggestionStatus
  decisions: SuggestionDecisionEvent[]
}

export interface CreateSuggestionInput {
  suggestionId: string
  eventId: string
  content: string
  sourceDocumentRevision: string
  authorId: string
  authorDisplayName: string
  timestamp: number
  sourceKind?: SuggestionSourceKind
  providerId?: string | null
  modelId?: string | null
  runId?: string | null
}

export interface DecideSuggestionInput {
  suggestionId: string
  eventId: string
  expectedProposalEventId: string
  decision: SuggestionDecisionKind
  reviewerId: string
  reviewerDisplayName: string
  timestamp: number
}

const SUGGESTION_BUCKET_PREFIX = 'suggestions:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_SUGGESTION = 1_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && value.trim().length > 0 && !/[\u0000]/.test(value)
const validRevision = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 500 && value.trim().length > 0 && !/[\u0000]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-suggestions')
  else operation()
}

function validProposal(value: unknown): value is SuggestionProposalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'eventId', 'suggestionId', 'content', 'sourceDocumentRevision',
    'authorId', 'authorDisplayName', 'timestamp', 'sourceKind', 'providerId', 'modelId', 'runId',
  ])) return false
  const event = value as Partial<SuggestionProposalEvent>
  if (event.schemaVersion !== SUGGESTION_SCHEMA_VERSION || event.kind !== 'proposal' ||
    !stableId(event.eventId) || !stableId(event.suggestionId) || !validText(event.content, 500_000) ||
    !validRevision(event.sourceDocumentRevision) || !stableId(event.authorId) ||
    !validText(event.authorDisplayName, 200) || !validTimestamp(event.timestamp) ||
    (event.sourceKind !== 'human' && event.sourceKind !== 'model')) return false
  if (event.sourceKind === 'human') {
    return event.providerId === null && event.modelId === null && event.runId === null
  }
  return stableId(event.providerId) && stableId(event.modelId) && stableId(event.runId)
}

function validDecision(value: unknown): value is SuggestionDecisionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'eventId', 'suggestionId', 'proposalEventId', 'decision',
    'reviewerId', 'reviewerDisplayName', 'timestamp',
  ])) return false
  const event = value as Partial<SuggestionDecisionEvent>
  return event.schemaVersion === SUGGESTION_SCHEMA_VERSION && event.kind === 'decision' &&
    stableId(event.eventId) && stableId(event.suggestionId) && stableId(event.proposalEventId) &&
    (event.decision === 'accepted' || event.decision === 'rejected') && stableId(event.reviewerId) &&
    validText(event.reviewerDisplayName, 200) && validTimestamp(event.timestamp)
}

const validEvent = (value: unknown): value is SuggestionEvent => validProposal(value) || validDecision(value)
const bucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(SUGGESTION_BUCKET_PREFIX))

function bucketsFor(collection: Y.Map<unknown>, suggestionId: string): Array<[string, Y.Map<unknown>]> {
  return bucketEntries(collection).filter(([, value]) =>
    value instanceof Y.Map && value.get('suggestionId') === suggestionId,
  ) as Array<[string, Y.Map<unknown>]>
}

function eventsFor(collection: Y.Map<unknown>, suggestionId: string): SuggestionEvent[] | null {
  const raw: SuggestionEvent[] = []
  for (const [, bucket] of bucketsFor(collection, suggestionId)) {
    if (!exactYKeys(bucket, ['suggestionId', 'events'])) return null
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) return null
    for (const value of events.values()) {
      if (!validEvent(value) || value.suggestionId !== suggestionId) return null
      raw.push(value)
      if (raw.length > MAX_EVENTS_PER_SUGGESTION) return null
    }
  }
  const byId = new Map<string, SuggestionEvent>()
  for (const event of raw) {
    const previous = byId.get(event.eventId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return null
    byId.set(event.eventId, event)
  }
  return Array.from(byId.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId))
}

function projectSuggestion(events: SuggestionEvent[]): CollaborativeSuggestion | null {
  const proposals = events.filter((event): event is SuggestionProposalEvent => event.kind === 'proposal')
  if (proposals.length !== 1) return null
  const proposal = proposals[0]
  const decisions = events.filter((event): event is SuggestionDecisionEvent => event.kind === 'decision')
  if (events.some((event) => event.suggestionId !== proposal.suggestionId) ||
    decisions.some((event) => event.proposalEventId !== proposal.eventId)) return null
  const choices = new Set(decisions.map((event) => event.decision))
  const status: SuggestionStatus = choices.size === 0
    ? 'pending'
    : choices.size > 1
      ? 'conflicted'
      : decisions[0].decision
  return {
    id: proposal.suggestionId,
    content: proposal.content,
    sourceDocumentRevision: proposal.sourceDocumentRevision,
    proposal: { ...proposal },
    status,
    decisions: decisions.map((event) => ({ ...event })),
  }
}

function appendEvent(collection: Y.Map<unknown>, event: SuggestionEvent): void {
  const existing = eventsFor(collection, event.suggestionId)
  if (existing === null) throw new Error('Suggestion history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Suggestion event ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS_PER_SUGGESTION) throw new Error('Suggestion history limit reached')
  const bucketKey = `${SUGGESTION_BUCKET_PREFIX}${peerKey(collection, event.suggestionId)}`
  let bucket = collection.get(bucketKey)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || bucket.get('suggestionId') !== event.suggestionId)) {
    throw new Error('Suggestion bucket identity conflict')
  }
  if (!(bucket instanceof Y.Map)) {
    if (bucketEntries(collection).length >= MAX_BUCKETS) throw new Error('Suggestion bucket limit reached')
    bucket = new Y.Map<unknown>()
    const events = new Y.Map<SuggestionEvent>()
    transact(collection, () => {
      ;(bucket as Y.Map<unknown>).set('suggestionId', event.suggestionId)
      ;(bucket as Y.Map<unknown>).set('events', events)
      events.set(peerKey(collection, event.eventId), event)
      collection.set(bucketKey, bucket)
    })
  } else {
    const events = bucket.get('events')
    if (!(events instanceof Y.Map)) throw new Error('Suggestion history is invalid')
    transact(collection, () => events.set(peerKey(collection, event.eventId), event))
  }
}

function normalizeProposal(input: CreateSuggestionInput): SuggestionProposalEvent {
  const event: SuggestionProposalEvent = {
    schemaVersion: SUGGESTION_SCHEMA_VERSION,
    kind: 'proposal',
    eventId: input.eventId,
    suggestionId: input.suggestionId,
    content: input.content,
    sourceDocumentRevision: input.sourceDocumentRevision,
    authorId: input.authorId,
    authorDisplayName: input.authorDisplayName,
    timestamp: input.timestamp,
    sourceKind: input.sourceKind ?? 'human',
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    runId: input.runId ?? null,
  }
  if (!validProposal(event)) throw new Error('Invalid suggestion proposal')
  return event
}

function normalizeDecision(input: DecideSuggestionInput): SuggestionDecisionEvent {
  const event: SuggestionDecisionEvent = {
    schemaVersion: SUGGESTION_SCHEMA_VERSION,
    kind: 'decision',
    eventId: input.eventId,
    suggestionId: input.suggestionId,
    proposalEventId: input.expectedProposalEventId,
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewerDisplayName: input.reviewerDisplayName,
    timestamp: input.timestamp,
  }
  if (!validDecision(event)) throw new Error('Invalid suggestion decision')
  return event
}

export function readSuggestion(collection: Y.Map<unknown>, suggestionId: string): CollaborativeSuggestion | null {
  if (!stableId(suggestionId)) return null
  const events = eventsFor(collection, suggestionId)
  return events === null ? null : projectSuggestion(events)
}

export function listSuggestions(collection: Y.Map<unknown>): CollaborativeSuggestion[] {
  const entries = bucketEntries(collection)
  if (entries.length > MAX_BUCKETS) return []
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('suggestionId')) ? [value.get('suggestionId') as string] : [],
  ))).sort()
  return ids.flatMap((id) => {
    const suggestion = readSuggestion(collection, id)
    return suggestion ? [suggestion] : []
  })
}

export function createSuggestion(
  discussions: Y.Map<unknown>,
  input: CreateSuggestionInput,
): CollaborativeSuggestion {
  const proposal = normalizeProposal(input)
  const existingEvents = eventsFor(discussions, input.suggestionId)
  if (existingEvents === null) throw new Error('Suggestion history is invalid')
  const replay = existingEvents.find((event) => event.eventId === proposal.eventId)
  if (!replay && existingEvents.length > 0) throw new Error('Suggestion already exists')
  appendEvent(discussions, proposal)
  const suggestion = readSuggestion(discussions, input.suggestionId)
  if (!suggestion) throw new Error('Suggestion proposal failed validation')
  return suggestion
}

export function decideSuggestion(
  discussions: Y.Map<unknown>,
  input: DecideSuggestionInput,
): CollaborativeSuggestion {
  const decision = normalizeDecision(input)
  const existingEvents = eventsFor(discussions, input.suggestionId)
  if (existingEvents === null) throw new Error('Suggestion history is invalid')
  const replay = existingEvents.find((event) => event.eventId === decision.eventId)
  const current = projectSuggestion(existingEvents)
  if (!current) throw new Error('Suggestion not found or invalid')
  if (current.proposal.eventId !== input.expectedProposalEventId) throw new Error('Suggestion proposal revision conflict')
  if (!replay && current.status !== 'pending') throw new Error('Suggestion decision conflict')
  appendEvent(discussions, decision)
  const suggestion = readSuggestion(discussions, input.suggestionId)
  if (!suggestion) throw new Error('Suggestion decision failed validation')
  return suggestion
}

export function inspectSuggestions(discussions: Y.Map<unknown>) {
  const entries = bucketEntries(discussions)
  const invalidBuckets = entries.filter(([, value]) =>
    !(value instanceof Y.Map) || !exactYKeys(value, ['suggestionId', 'events']) ||
    !stableId(value.get('suggestionId')) || !(value.get('events') instanceof Y.Map)).length
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('suggestionId')) ? [value.get('suggestionId') as string] : [],
  )))
  const invalidGroups = ids.filter((id) => readSuggestion(discussions, id) === null).length
  const suggestions = listSuggestions(discussions)
  const conflictedSuggestionIds = suggestions.filter(({ status }) => status === 'conflicted').map(({ id }) => id).sort()
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} suggestion record(s) failed validation`)
  conflictedSuggestionIds.forEach((id) => issues.push(`Suggestion ${id} has conflicting accept/reject decisions`))
  return {
    healthy: issues.length === 0,
    suggestionCount: suggestions.length,
    pendingCount: suggestions.filter(({ status }) => status === 'pending').length,
    invalidRecords,
    conflictedSuggestionIds,
    issues,
  }
}
