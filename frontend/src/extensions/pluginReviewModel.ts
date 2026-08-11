import * as Y from 'yjs'
import type { PluginChangeProposal } from './pluginManifest'

export const PLUGIN_REVIEW_SCHEMA_VERSION = 1 as const
export type PluginReviewDecision = 'accepted' | 'rejected'
export type PluginReviewStatus = 'pending' | PluginReviewDecision | 'conflicted'

export interface PluginReviewProposalEvent {
  schemaVersion: typeof PLUGIN_REVIEW_SCHEMA_VERSION
  kind: 'proposal'
  eventId: string
  reviewId: string
  pluginProposalId: string
  pluginId: string
  pluginVersion: string
  componentSha256: string
  contributionId: string
  projectId: string
  expectedRevision: string
  summary: string
  content: string
  operation: 'append' | 'replace'
  runnerId: string
  runnerDisplayName: string
  timestamp: number
}

export interface PluginReviewDecisionEvent {
  schemaVersion: typeof PLUGIN_REVIEW_SCHEMA_VERSION
  kind: 'decision'
  eventId: string
  reviewId: string
  proposalEventId: string
  decision: PluginReviewDecision
  reviewerId: string
  reviewerDisplayName: string
  timestamp: number
}

export interface PluginReviewApplicationEvent {
  schemaVersion: typeof PLUGIN_REVIEW_SCHEMA_VERSION
  kind: 'application'
  eventId: string
  reviewId: string
  proposalEventId: string
  decisionEventId: string
  projectId: string
  operation: 'append' | 'replace'
  sourceDocumentRevision: string
  resultDocumentRevision: string
  linkedPolicyId: string
  applierId: string
  applierDisplayName: string
  timestamp: number
}

export type PluginReviewEvent =
  | PluginReviewProposalEvent
  | PluginReviewDecisionEvent
  | PluginReviewApplicationEvent

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Exact, versioned JSON envelope used for durable plugin-review event hashes. */
export function canonicalPluginReviewEvent(event: PluginReviewEvent): string {
  if (event.kind === 'proposal') {
    return JSON.stringify({
      schemaVersion: event.schemaVersion,
      kind: event.kind,
      eventId: event.eventId,
      reviewId: event.reviewId,
      pluginProposalId: event.pluginProposalId,
      pluginId: event.pluginId,
      pluginVersion: event.pluginVersion,
      componentSha256: event.componentSha256,
      contributionId: event.contributionId,
      projectId: event.projectId,
      expectedRevision: event.expectedRevision,
      summary: event.summary,
      content: event.content,
      operation: event.operation,
      runnerId: event.runnerId,
      runnerDisplayName: event.runnerDisplayName,
      timestamp: event.timestamp,
    })
  }
  if (event.kind === 'decision') {
    return JSON.stringify({
      schemaVersion: event.schemaVersion,
      kind: event.kind,
      eventId: event.eventId,
      reviewId: event.reviewId,
      proposalEventId: event.proposalEventId,
      decision: event.decision,
      reviewerId: event.reviewerId,
      reviewerDisplayName: event.reviewerDisplayName,
      timestamp: event.timestamp,
    })
  }
  return JSON.stringify({
    schemaVersion: event.schemaVersion,
    kind: event.kind,
    eventId: event.eventId,
    reviewId: event.reviewId,
    proposalEventId: event.proposalEventId,
    decisionEventId: event.decisionEventId,
    projectId: event.projectId,
    operation: event.operation,
    sourceDocumentRevision: event.sourceDocumentRevision,
    resultDocumentRevision: event.resultDocumentRevision,
    linkedPolicyId: event.linkedPolicyId,
    applierId: event.applierId,
    applierDisplayName: event.applierDisplayName,
    timestamp: event.timestamp,
  })
}

export async function pluginReviewEventSha256(event: PluginReviewEvent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPluginReviewEvent(event))
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export interface CollaborativePluginReview {
  id: string
  proposal: PluginReviewProposalEvent
  decisions: PluginReviewDecisionEvent[]
  applications: PluginReviewApplicationEvent[]
  status: PluginReviewStatus
}

export interface CreatePluginReviewInput {
  reviewId: string
  eventId: string
  pluginVersion: string
  componentSha256: string
  contributionId: string
  proposal: PluginChangeProposal
  runnerId: string
  runnerDisplayName: string
  timestamp: number
}

export interface DecidePluginReviewInput {
  reviewId: string
  eventId: string
  expectedProposalEventId: string
  decision: PluginReviewDecision
  reviewerId: string
  reviewerDisplayName: string
  timestamp: number
}

export interface RecordPluginReviewApplicationInput {
  reviewId: string
  eventId: string
  expectedProposalEventId: string
  expectedDecisionEventId: string
  projectId: string
  operation: 'append' | 'replace'
  sourceDocumentRevision: string
  resultDocumentRevision: string
  linkedPolicyId: string
  applierId: string
  applierDisplayName: string
  timestamp: number
}

const BUCKET_PREFIX = 'plugin-reviews:v1:'
const MAX_BUCKETS = 20_000
const MAX_EVENTS_PER_REVIEW = 1_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\u0000')
const exactKeys = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, keys: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...keys].sort().join(',')
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const peerKey = (collection: Y.Map<unknown>, id: string) => `${collection.doc?.clientID ?? 'detached'}:${id}`

function validProposal(value: unknown): value is PluginReviewProposalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'eventId', 'reviewId', 'pluginProposalId', 'pluginId', 'pluginVersion',
    'componentSha256', 'contributionId', 'projectId', 'expectedRevision', 'summary', 'content',
    'operation', 'runnerId', 'runnerDisplayName', 'timestamp',
  ])) return false
  const event = value as Partial<PluginReviewProposalEvent>
  return event.schemaVersion === PLUGIN_REVIEW_SCHEMA_VERSION && event.kind === 'proposal' &&
    stableId(event.eventId) && stableId(event.reviewId) && text(event.pluginProposalId, 120) &&
    typeof event.pluginId === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(event.pluginId) &&
    typeof event.pluginVersion === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(event.pluginVersion) &&
    typeof event.componentSha256 === 'string' && /^[a-f0-9]{64}$/.test(event.componentSha256) &&
    stableId(event.contributionId, 120) && stableId(event.projectId) && text(event.expectedRevision, 500) &&
    text(event.summary, 1_000) && text(event.content, 200_000) &&
    (event.operation === 'append' || event.operation === 'replace') &&
    stableId(event.runnerId) && text(event.runnerDisplayName, 200) && timestamp(event.timestamp)
}

function validDecision(value: unknown): value is PluginReviewDecisionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'eventId', 'reviewId', 'proposalEventId', 'decision',
    'reviewerId', 'reviewerDisplayName', 'timestamp',
  ])) return false
  const event = value as Partial<PluginReviewDecisionEvent>
  return event.schemaVersion === PLUGIN_REVIEW_SCHEMA_VERSION && event.kind === 'decision' &&
    stableId(event.eventId) && stableId(event.reviewId) && stableId(event.proposalEventId) &&
    (event.decision === 'accepted' || event.decision === 'rejected') &&
    stableId(event.reviewerId) && text(event.reviewerDisplayName, 200) && timestamp(event.timestamp)
}

function validApplication(value: unknown): value is PluginReviewApplicationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'kind', 'eventId', 'reviewId', 'proposalEventId', 'decisionEventId',
    'projectId', 'operation', 'sourceDocumentRevision', 'resultDocumentRevision', 'linkedPolicyId',
    'applierId', 'applierDisplayName', 'timestamp',
  ])) return false
  const event = value as Partial<PluginReviewApplicationEvent>
  return event.schemaVersion === PLUGIN_REVIEW_SCHEMA_VERSION && event.kind === 'application' &&
    stableId(event.eventId) && stableId(event.reviewId) && stableId(event.proposalEventId) &&
    stableId(event.decisionEventId) && stableId(event.projectId) &&
    (event.operation === 'append' || event.operation === 'replace') &&
    text(event.sourceDocumentRevision, 500) && text(event.resultDocumentRevision, 500) &&
    event.sourceDocumentRevision !== event.resultDocumentRevision &&
    stableId(event.linkedPolicyId) && stableId(event.applierId) &&
    text(event.applierDisplayName, 200) && timestamp(event.timestamp)
}

const validEvent = (value: unknown): value is PluginReviewEvent =>
  validProposal(value) || validDecision(value) || validApplication(value)
const buckets = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(BUCKET_PREFIX))

function reviewBuckets(collection: Y.Map<unknown>, reviewId: string): Y.Map<unknown>[] {
  return buckets(collection).flatMap(([, value]) =>
    value instanceof Y.Map && value.get('reviewId') === reviewId ? [value] : [])
}

function eventsFor(collection: Y.Map<unknown>, reviewId: string): PluginReviewEvent[] | null {
  if (buckets(collection).some(([, value]) =>
    !(value instanceof Y.Map) || !exactYKeys(value, ['reviewId', 'events']) ||
    !stableId(value.get('reviewId')) || !(value.get('events') instanceof Y.Map))) {
    return null
  }
  const events: PluginReviewEvent[] = []
  for (const bucket of reviewBuckets(collection, reviewId)) {
    if (!exactYKeys(bucket, ['reviewId', 'events'])) return null
    const values = bucket.get('events')
    if (!(values instanceof Y.Map)) return null
    for (const value of values.values()) {
      if (!validEvent(value) || value.reviewId !== reviewId) return null
      events.push(value)
      if (events.length > MAX_EVENTS_PER_REVIEW) return null
    }
  }
  const unique = new Map<string, PluginReviewEvent>()
  for (const event of events) {
    const prior = unique.get(event.eventId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) return null
    unique.set(event.eventId, event)
  }
  return Array.from(unique.values()).map((event) => ({ ...event })).sort((left, right) =>
    left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId))
}

function project(events: PluginReviewEvent[]): CollaborativePluginReview | null {
  const proposals = events.filter((event): event is PluginReviewProposalEvent => event.kind === 'proposal')
  if (proposals.length !== 1) return null
  const proposal = proposals[0]
  const decisions = events.filter((event): event is PluginReviewDecisionEvent => event.kind === 'decision')
  const applications = events.filter((event): event is PluginReviewApplicationEvent => event.kind === 'application')
  if (events.some((event) => event.reviewId !== proposal.reviewId) ||
    decisions.some((event) => event.proposalEventId !== proposal.eventId) || applications.length > 1 ||
    applications.some((event) => event.proposalEventId !== proposal.eventId ||
      event.projectId !== proposal.projectId || event.operation !== proposal.operation ||
      event.sourceDocumentRevision !== proposal.expectedRevision ||
      event.linkedPolicyId !== proposal.reviewId || !decisions.some((decision) =>
        decision.eventId === event.decisionEventId && decision.decision === 'accepted'))) return null
  const choices = new Set(decisions.map((event) => event.decision))
  const status: PluginReviewStatus = choices.size === 0
    ? 'pending'
    : choices.size > 1 ? 'conflicted' : decisions[0].decision
  return {
    id: proposal.reviewId,
    proposal: { ...proposal },
    decisions: decisions.map((event) => ({ ...event })),
    applications: applications.map((event) => ({ ...event })),
    status,
  }
}

function append(collection: Y.Map<unknown>, event: PluginReviewEvent) {
  const existing = eventsFor(collection, event.reviewId)
  if (existing === null) throw new Error('Plugin review history is invalid')
  const replay = existing.find((candidate) => candidate.eventId === event.eventId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('Plugin review event ID was reused')
    return
  }
  if (existing.length >= MAX_EVENTS_PER_REVIEW) throw new Error('Plugin review history limit reached')
  const key = `${BUCKET_PREFIX}${peerKey(collection, event.reviewId)}`
  let bucket = collection.get(key)
  if (bucket !== undefined && (!(bucket instanceof Y.Map) || bucket.get('reviewId') !== event.reviewId)) {
    throw new Error('Plugin review bucket identity conflict')
  }
  const operation = () => {
    if (!(bucket instanceof Y.Map)) {
      if (buckets(collection).length >= MAX_BUCKETS) throw new Error('Plugin review limit reached')
      const created = new Y.Map<unknown>()
      const eventMap = new Y.Map<PluginReviewEvent>()
      created.set('reviewId', event.reviewId)
      created.set('events', eventMap)
      eventMap.set(peerKey(collection, event.eventId), event)
      collection.set(key, created)
      bucket = created
      return
    }
    const eventMap = bucket.get('events')
    if (!(eventMap instanceof Y.Map)) throw new Error('Plugin review history is invalid')
    eventMap.set(peerKey(collection, event.eventId), event)
  }
  if (collection.doc) collection.doc.transact(operation, 'syzygy-plugin-review')
  else operation()
}

export function readPluginReview(collection: Y.Map<unknown>, reviewId: string): CollaborativePluginReview | null {
  if (!stableId(reviewId)) return null
  const events = eventsFor(collection, reviewId)
  return events === null ? null : project(events)
}

export function readPluginReviewEvent(
  collection: Y.Map<unknown>,
  reviewId: string,
  eventId: string,
): PluginReviewEvent | null {
  if (!stableId(reviewId) || !stableId(eventId)) return null
  const events = eventsFor(collection, reviewId)
  return events?.find((event) => event.eventId === eventId) ?? null
}

export function listPluginReviews(collection: Y.Map<unknown>): CollaborativePluginReview[] {
  const entries = buckets(collection)
  if (entries.length > MAX_BUCKETS) return []
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('reviewId')) ? [value.get('reviewId') as string] : [],
  ))).sort()
  return ids.flatMap((id) => {
    const review = readPluginReview(collection, id)
    return review ? [review] : []
  })
}

function proposalEvent(input: CreatePluginReviewInput): PluginReviewProposalEvent {
  const event: PluginReviewProposalEvent = {
    schemaVersion: PLUGIN_REVIEW_SCHEMA_VERSION,
    kind: 'proposal',
    eventId: input.eventId,
    reviewId: input.reviewId,
    pluginProposalId: input.proposal.proposalId,
    pluginId: input.proposal.pluginId,
    pluginVersion: input.pluginVersion,
    componentSha256: input.componentSha256,
    contributionId: input.contributionId,
    projectId: input.proposal.projectId,
    expectedRevision: input.proposal.expectedRevision,
    summary: input.proposal.summary,
    content: input.proposal.content,
    operation: input.proposal.operation,
    runnerId: input.runnerId,
    runnerDisplayName: input.runnerDisplayName,
    timestamp: input.timestamp,
  }
  if (!validProposal(event)) throw new Error('Invalid plugin review proposal')
  return event
}

export function createPluginReviews(
  collection: Y.Map<unknown>,
  inputs: CreatePluginReviewInput[],
): CollaborativePluginReview[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) {
    throw new Error('Plugin review batch must contain between one and 32 proposals')
  }
  const events = inputs.map(proposalEvent)
  if (new Set(events.map((event) => event.reviewId)).size !== events.length ||
    new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new Error('Plugin review batch identities must be unique')
  }
  if (buckets(collection).length + events.length > MAX_BUCKETS || events.some((event) => {
    const existing = eventsFor(collection, event.reviewId)
    return existing === null || existing.length > 0
  })) {
    throw new Error('Plugin review batch conflicts with retained history')
  }
  const operation = () => {
    for (const event of events) {
      const bucket = new Y.Map<unknown>()
      const eventMap = new Y.Map<PluginReviewEvent>()
      bucket.set('reviewId', event.reviewId)
      bucket.set('events', eventMap)
      eventMap.set(peerKey(collection, event.eventId), event)
      collection.set(`${BUCKET_PREFIX}${peerKey(collection, event.reviewId)}`, bucket)
    }
  }
  if (collection.doc) collection.doc.transact(operation, 'syzygy-plugin-review-batch')
  else operation()
  const reviews = events.map((event) => readPluginReview(collection, event.reviewId))
  if (reviews.some((review) => !review)) throw new Error('Plugin review batch failed validation')
  return reviews as CollaborativePluginReview[]
}

export function createPluginReview(
  collection: Y.Map<unknown>,
  input: CreatePluginReviewInput,
): CollaborativePluginReview {
  return createPluginReviews(collection, [input])[0]
}

export function decidePluginReview(
  collection: Y.Map<unknown>,
  input: DecidePluginReviewInput,
): CollaborativePluginReview {
  const event: PluginReviewDecisionEvent = {
    schemaVersion: PLUGIN_REVIEW_SCHEMA_VERSION,
    kind: 'decision',
    eventId: input.eventId,
    reviewId: input.reviewId,
    proposalEventId: input.expectedProposalEventId,
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewerDisplayName: input.reviewerDisplayName,
    timestamp: input.timestamp,
  }
  if (!validDecision(event)) throw new Error('Invalid plugin review decision')
  const current = readPluginReview(collection, input.reviewId)
  if (!current) throw new Error('Plugin review not found or invalid')
  if (current.proposal.eventId !== input.expectedProposalEventId) throw new Error('Plugin review proposal revision conflict')
  const replay = current.decisions.find((candidate) => candidate.eventId === input.eventId)
  if (!replay && current.status !== 'pending') throw new Error('Plugin review decision conflict')
  append(collection, event)
  const review = readPluginReview(collection, input.reviewId)
  if (!review) throw new Error('Plugin review decision failed validation')
  return review
}

export function recordPluginReviewApplication(
  collection: Y.Map<unknown>,
  input: RecordPluginReviewApplicationInput,
): CollaborativePluginReview {
  const current = readPluginReview(collection, input.reviewId)
  if (!current) throw new Error('Plugin review not found or invalid')
  if (current.proposal.eventId !== input.expectedProposalEventId ||
    current.proposal.projectId !== input.projectId || current.proposal.operation !== input.operation ||
    current.id !== input.linkedPolicyId) {
    throw new Error('Plugin application does not match the retained proposal')
  }
  if (current.status !== 'accepted' || !current.decisions.some((decision) =>
    decision.eventId === input.expectedDecisionEventId && decision.decision === 'accepted')) {
    throw new Error('Plugin application does not match an accepted decision')
  }
  if (current.applications.length > 0) throw new Error('Plugin proposal was already applied')
  const event: PluginReviewApplicationEvent = {
    schemaVersion: PLUGIN_REVIEW_SCHEMA_VERSION,
    kind: 'application',
    eventId: input.eventId,
    reviewId: input.reviewId,
    proposalEventId: input.expectedProposalEventId,
    decisionEventId: input.expectedDecisionEventId,
    projectId: input.projectId,
    operation: input.operation,
    sourceDocumentRevision: input.sourceDocumentRevision,
    resultDocumentRevision: input.resultDocumentRevision,
    linkedPolicyId: input.linkedPolicyId,
    applierId: input.applierId,
    applierDisplayName: input.applierDisplayName,
    timestamp: input.timestamp,
  }
  if (!validApplication(event)) throw new Error('Invalid plugin application event')
  append(collection, event)
  const review = readPluginReview(collection, input.reviewId)
  if (!review || review.applications[0]?.eventId !== input.eventId) {
    throw new Error('Plugin application event failed validation')
  }
  return review
}

export function inspectPluginReviews(collection: Y.Map<unknown>) {
  const entries = buckets(collection)
  const invalidBuckets = entries.filter(([, value]) =>
    !(value instanceof Y.Map) || !exactYKeys(value, ['reviewId', 'events']) ||
    !stableId(value.get('reviewId')) || !(value.get('events') instanceof Y.Map)).length
  const ids = Array.from(new Set(entries.flatMap(([, value]) =>
    value instanceof Y.Map && stableId(value.get('reviewId')) ? [value.get('reviewId') as string] : [],
  )))
  const invalidGroups = ids.filter((id) => readPluginReview(collection, id) === null).length
  const reviews = listPluginReviews(collection)
  return {
    healthy: invalidBuckets + invalidGroups === 0 && entries.length <= MAX_BUCKETS,
    reviewCount: reviews.length,
    pendingCount: reviews.filter((review) => review.status === 'pending').length,
    conflictedCount: reviews.filter((review) => review.status === 'conflicted').length,
    appliedCount: reviews.filter((review) => review.applications.length === 1).length,
    invalidRecords: invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0),
  }
}
