import * as Y from 'yjs'
import { projectStateFingerprint, getProjectSharedTypes } from '../workspace/projectModel'
import { createAdversarialRunPlan } from './adversarialProtocol'
import { validateAdversarialRunRecord } from './adversarialRunRecord'
import {
  buildNativeAdversarialScope,
  type NativeAdversarialAuthorizationScope,
} from './adversarialNativePlan'
import type { NativeAdversarialPanelOutcome } from './adversarialNativeExecutor'
import type { AdversarialRunnerRequest } from './adversarialRunner'
import { validateProviderRunRecord, type ProviderRunRecord } from './providerRunRecord'

export const ADVERSARIAL_REVIEW_ARCHIVE_VERSION = 1 as const
export const ADVERSARIAL_REVIEW_DECISION_VERSION = 1 as const

export type AdversarialReviewDecision = 'accepted' | 'rejected'

export interface AdversarialReviewArchive {
  schemaVersion: typeof ADVERSARIAL_REVIEW_ARCHIVE_VERSION
  recordSha256: string
  runId: string
  projectId: string
  sourceDocumentRevision: string
  researchRevisionAtSave: string
  request: AdversarialRunnerRequest
  outcome: NativeAdversarialPanelOutcome
  createdBy: {
    participantId: string
    displayName: string
  }
  createdAt: number
}

export interface AdversarialReviewDecisionEvent {
  schemaVersion: typeof ADVERSARIAL_REVIEW_DECISION_VERSION
  eventId: string
  runId: string
  recordSha256: string
  expectedCurrentDecisionId: string | null
  decision: AdversarialReviewDecision
  participantId: string
  displayName: string
  notes: string
  timestamp: number
}

export interface AdversarialReviewDecisionSummary {
  runId: string
  recordSha256: string
  current: AdversarialReviewDecisionEvent
  history: AdversarialReviewDecisionEvent[]
}

export interface SaveAdversarialReviewInput {
  expectedResearchRevision: string
  projectId: string
  sourceDocumentRevision: string
  request: AdversarialRunnerRequest
  outcome: NativeAdversarialPanelOutcome
  participantId: string
  displayName: string
  createdAt: number
}

export interface DecideAdversarialReviewInput {
  expectedResearchRevision: string
  projectId: string
  runId: string
  recordSha256: string
  expectedCurrentDecisionId: string | null
  decision: AdversarialReviewDecision
  eventId: string
  participantId: string
  displayName: string
  notes: string
  timestamp: number
}

export interface AdversarialReviewSummary {
  runId: string
  recordSha256: string
  sourceDocumentRevision: string
  researchRevisionAtSave: string
  createdBy: AdversarialReviewArchive['createdBy']
  createdAt: number
  sourceCount: number
  participantCount: number
  providerCount: number
  totalRemoteCalls: number
  decision: AdversarialReviewDecision | 'pending' | 'conflicted'
  currentDecisionId: string | null
  decisionCount: number
}

const ARCHIVE_PREFIX = 'adversarial-review:v1:'
const DECISION_PREFIX = 'adversarial-review-decision:v1:'
const MAX_ARCHIVE_RECORDS = 2_000
const MAX_DECISION_EVENTS = 20_000
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const MAX_NOTES = 20_000
const encoder = new TextEncoder()
const shaPattern = /^[a-f0-9]{64}$/
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const decisions = new Set<AdversarialReviewDecision>(['accepted', 'rejected'])

const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && stableIdPattern.test(value)
const boundedText = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  (empty || value.trim().length > 0) &&
  !/[\u0000-\u001f\u007f]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const peerKey = (collection: Y.Map<unknown>, publicId: string) =>
  `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const clone = <T>(value: T): T => structuredClone(value)

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function strictRequest(value: unknown): value is AdversarialRunnerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['runId', 'input', 'sources'])) return false
  const request = value as Partial<AdversarialRunnerRequest>
  const input = request.input
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    !exactKeys(input, ['question', 'participants', 'judge', 'baseline', 'seed']) ||
    !Array.isArray(input.participants) || !Array.isArray(request.sources)) return false
  const route = (candidate: unknown) =>
    !!candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
    exactKeys(candidate, ['slotId', 'providerId', 'modelId'])
  if (!input.participants.every(route) || !route(input.judge) || !route(input.baseline)) return false
  return request.sources.every((source) =>
    !!source && typeof source === 'object' && !Array.isArray(source) &&
    exactKeys(source, ['snapshotId', 'label', 'excerpt']))
}

function strictProviderRunRecord(record: ProviderRunRecord): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    !exactKeys(record, [
      'recordVersion', 'runId', 'callId', 'executionMode', 'provider', 'request',
      'disclosure', 'dataHandling', 'result', 'usage',
    ])) return false
  if (!record.provider || typeof record.provider !== 'object' || Array.isArray(record.provider) ||
    !record.request || typeof record.request !== 'object' || Array.isArray(record.request) ||
    !record.disclosure || typeof record.disclosure !== 'object' || Array.isArray(record.disclosure) ||
    !record.dataHandling || typeof record.dataHandling !== 'object' || Array.isArray(record.dataHandling) ||
    !record.result || typeof record.result !== 'object' || Array.isArray(record.result) ||
    !record.usage || typeof record.usage !== 'object' || Array.isArray(record.usage) ||
    !exactKeys(record.provider, ['id', 'transport', 'model', 'adapterStatus', 'remote']) ||
    !exactKeys(record.request, [
      'taskType', 'startedAt', 'completedAt', 'sourceSnapshotIds', 'inputSha256',
      'maxOutputTokens', 'timeoutMs', 'stream',
    ]) ||
    !exactKeys(record.disclosure, [
      'required', 'approved', 'approvedAt', 'destination', 'policyUrl', 'policyCheckedAt',
    ]) ||
    !exactKeys(record.dataHandling, ['storageRequest', 'zeroRetention', 'attestation']) ||
    !exactKeys(record.result, ['status', 'outputSha256', 'errorCode']) ||
    !exactKeys(record.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'costUsd'])) return false
  const attestation = record.dataHandling.attestation
  return (attestation === null ||
    (typeof attestation === 'object' && !Array.isArray(attestation) &&
      exactKeys(attestation, ['kind', 'name', 'value']))) &&
    validateProviderRunRecord(record).length === 0
}

function strictOutcome(
  request: AdversarialRunnerRequest,
  outcomeValue: unknown,
): outcomeValue is NativeAdversarialPanelOutcome {
  if (!outcomeValue || typeof outcomeValue !== 'object' || Array.isArray(outcomeValue) ||
    !exactKeys(outcomeValue, [
      'plan', 'record', 'callLedger', 'baselineArtifacts', 'authorization', 'providerRunRecords',
    ])) return false
  const outcome = outcomeValue as NativeAdversarialPanelOutcome
  if (!outcome.plan || typeof outcome.plan !== 'object' || Array.isArray(outcome.plan) ||
    !outcome.record || typeof outcome.record !== 'object' || Array.isArray(outcome.record) ||
    !exactKeys(outcome.record, [
      'recordVersion', 'runId', 'protocolVersion', 'sourceSnapshotIds', 'candidates',
      'critiques', 'evidenceAudit', 'judgments', 'minorityFindings', 'synthesis',
      'accounting', 'humanDecision', 'sharedMutation',
    ]) ||
    !Array.isArray(outcome.record.sourceSnapshotIds) ||
    !Array.isArray(outcome.callLedger) || !Array.isArray(outcome.baselineArtifacts) ||
    !Array.isArray(outcome.providerRunRecords) || !outcome.authorization ||
    typeof outcome.authorization !== 'object' || Array.isArray(outcome.authorization) ||
    !exactKeys(outcome.authorization, ['scopeSha256', 'totalRemoteCalls']) ||
    !shaPattern.test(outcome.authorization.scopeSha256)) return false
  let scope: NativeAdversarialAuthorizationScope
  try {
    scope = buildNativeAdversarialScope(request)
  } catch {
    return false
  }
  const expectedPlan = createAdversarialRunPlan(request.input)
  let recordErrors: string[]
  try {
    recordErrors = validateAdversarialRunRecord(expectedPlan, outcome.record)
  } catch {
    return false
  }
  const expectedSourceIds = request.sources.map(({ snapshotId }) => snapshotId)
  if (JSON.stringify(outcome.plan) !== JSON.stringify(expectedPlan) ||
    outcome.record.runId !== request.runId ||
    outcome.record.sourceSnapshotIds.join('\0') !== expectedSourceIds.join('\0') ||
    !outcome.record.humanDecision || typeof outcome.record.humanDecision !== 'object' ||
    outcome.record.humanDecision.status !== 'pending' ||
    !outcome.record.sharedMutation || typeof outcome.record.sharedMutation !== 'object' ||
    outcome.record.sharedMutation.applied ||
    recordErrors.length > 0 ||
    outcome.authorization.totalRemoteCalls !== scope.totalRemoteCalls) return false
  const callsById = new Map(scope.calls.map((call) => [call.callId, call]))
  if (outcome.callLedger.length !== scope.calls.length ||
    outcome.providerRunRecords.length !== scope.calls.length ||
    new Set(outcome.callLedger.map(({ callId }) => callId)).size !== scope.calls.length ||
    new Set(outcome.providerRunRecords.map(({ callId }) => callId)).size !== scope.calls.length) return false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd = 0
  let allCostsKnown = true
  const ledgerByCallId = new Map<string, NativeAdversarialPanelOutcome['callLedger'][number]>()
  for (const entry of outcome.callLedger) {
    const planned = callsById.get(entry.callId)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !exactKeys(entry, [
        'callId', 'phase', 'slotId', 'providerId', 'modelId', 'status', 'errorCode', 'usage',
      ]) ||
      !planned || entry.phase !== planned.phase || entry.providerId !== planned.provider ||
      entry.modelId !== planned.model || entry.status !== 'completed' || entry.errorCode !== null ||
      !entry.usage || typeof entry.usage !== 'object' || Array.isArray(entry.usage) ||
      !exactKeys(entry.usage, ['inputTokens', 'outputTokens', 'costUsd']) ||
      !Number.isSafeInteger(entry.usage.inputTokens) || entry.usage.inputTokens < 0 ||
      !Number.isSafeInteger(entry.usage.outputTokens) || entry.usage.outputTokens < 0 ||
      (entry.usage.costUsd !== null &&
        (!Number.isFinite(entry.usage.costUsd) || entry.usage.costUsd < 0))) return false
    totalInputTokens += entry.usage.inputTokens
    totalOutputTokens += entry.usage.outputTokens
    if (entry.usage.costUsd === null) allCostsKnown = false
    else totalCostUsd += entry.usage.costUsd
    ledgerByCallId.set(entry.callId, entry)
  }
  if (outcome.record.accounting.inputTokens !== totalInputTokens ||
    outcome.record.accounting.outputTokens !== totalOutputTokens ||
    outcome.record.accounting.costUsd !== (allCostsKnown ? totalCostUsd : null)) return false
  for (const artifact of outcome.baselineArtifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
      !exactKeys(artifact, ['callId', 'text']) || callsById.get(artifact.callId)?.phase !== 'baseline' ||
      !boundedText(artifact.text, 4 * 1024 * 1024)) return false
  }
  if (outcome.baselineArtifacts.length !== expectedPlan.computeMatchedBaselineCallBudget) return false
  return outcome.providerRunRecords.every((record) => {
    const planned = callsById.get(record.callId)
    const ledger = ledgerByCallId.get(record.callId)
    return strictProviderRunRecord(record) &&
      record.runId === request.runId &&
      !!planned && !!ledger &&
      record.provider.id === planned.provider &&
      record.provider.model === planned.model &&
      record.request.taskType === `adversarial.${planned.phase}` &&
      record.request.timeoutMs === planned.timeoutMs &&
      record.request.maxOutputTokens === planned.maxOutputTokens &&
      record.result.status === 'completed' &&
      record.usage.inputTokens === ledger.usage!.inputTokens &&
      record.usage.outputTokens === ledger.usage!.outputTokens &&
      record.usage.costUsd === ledger.usage!.costUsd &&
      record.request.sourceSnapshotIds.join('\0') === expectedSourceIds.join('\0')
  })
}

type ArchivePayload = Omit<AdversarialReviewArchive, 'recordSha256'>

function strictArchiveEnvelope(value: unknown): value is AdversarialReviewArchive {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    exactKeys(value, [
      'schemaVersion', 'recordSha256', 'runId', 'projectId', 'sourceDocumentRevision',
      'researchRevisionAtSave', 'request', 'outcome', 'createdBy', 'createdAt',
    ])
}

async function decodeArchive(value: unknown): Promise<AdversarialReviewArchive | null> {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > MAX_ARCHIVE_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!strictArchiveEnvelope(parsed)) return null
  const archive = parsed as AdversarialReviewArchive
  if (archive.schemaVersion !== ADVERSARIAL_REVIEW_ARCHIVE_VERSION ||
    !shaPattern.test(archive.recordSha256) || !stableId(archive.runId) ||
    !stableId(archive.projectId) || !boundedText(archive.sourceDocumentRevision, 500) ||
    !boundedText(archive.researchRevisionAtSave, 500) ||
    !archive.createdBy || typeof archive.createdBy !== 'object' || Array.isArray(archive.createdBy) ||
    !exactKeys(archive.createdBy, ['participantId', 'displayName']) ||
    !stableId(archive.createdBy.participantId) ||
    !boundedText(archive.createdBy.displayName, 200) || !validTimestamp(archive.createdAt) ||
    !strictRequest(archive.request) || archive.request.runId !== archive.runId) return null
  try {
    if (!strictOutcome(archive.request, archive.outcome)) return null
  } catch {
    return null
  }
  const { recordSha256, ...payload } = archive
  if (await sha256(JSON.stringify(payload)) !== recordSha256) return null
  return clone(archive)
}

async function createArchive(input: SaveAdversarialReviewInput): Promise<AdversarialReviewArchive> {
  if (!stableId(input.projectId) || !boundedText(input.expectedResearchRevision, 500) ||
    !boundedText(input.sourceDocumentRevision, 500) || !stableId(input.participantId) || !boundedText(input.displayName, 200) ||
    !validTimestamp(input.createdAt) || !strictRequest(input.request) ||
    !strictOutcome(input.request, input.outcome)) {
    throw new Error('Invalid adversarial review archive')
  }
  const payload: ArchivePayload = {
    schemaVersion: ADVERSARIAL_REVIEW_ARCHIVE_VERSION,
    runId: input.request.runId,
    projectId: input.projectId,
    sourceDocumentRevision: input.sourceDocumentRevision,
    researchRevisionAtSave: input.expectedResearchRevision,
    request: clone(input.request),
    outcome: clone(input.outcome),
    createdBy: { participantId: input.participantId, displayName: input.displayName.trim() },
    createdAt: input.createdAt,
  }
  const canonical = JSON.stringify(payload)
  if (encoder.encode(canonical).byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Adversarial review archive exceeds the collaborative size limit')
  }
  return { recordSha256: await sha256(canonical), ...payload }
}

function archiveEntries(discussions: Y.Map<unknown>) {
  return Array.from(discussions.entries()).filter(([key]) => key.startsWith(ARCHIVE_PREFIX))
}

function decisionEntries(discussions: Y.Map<unknown>) {
  return Array.from(discussions.entries()).filter(([key]) => key.startsWith(DECISION_PREFIX))
}

async function decodedArchives(discussions: Y.Map<unknown>) {
  return Promise.all(archiveEntries(discussions).map(async ([key, value]) => ({ key, archive: await decodeArchive(value) })))
}

export async function readAdversarialReviewArchive(
  discussions: Y.Map<unknown>,
  runId: string,
): Promise<AdversarialReviewArchive | null> {
  if (!stableId(runId)) return null
  const matches = (await decodedArchives(discussions))
    .flatMap(({ archive }) => archive?.runId === runId ? [archive] : [])
  if (matches.length === 0 || new Set(matches.map(({ recordSha256 }) => recordSha256)).size !== 1) return null
  return clone(matches[0])
}

export async function listAdversarialReviewArchives(
  discussions: Y.Map<unknown>,
): Promise<AdversarialReviewArchive[]> {
  const decoded = await decodedArchives(discussions)
  const byRun = new Map<string, AdversarialReviewArchive[]>()
  for (const archive of decoded.flatMap(({ archive }) => archive ? [archive] : [])) {
    const group = byRun.get(archive.runId) ?? []
    group.push(archive)
    byRun.set(archive.runId, group)
  }
  return [...byRun.values()]
    .filter((group) => new Set(group.map(({ recordSha256 }) => recordSha256)).size === 1)
    .map((group) => clone(group[0]))
    .sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId))
}

export async function saveAdversarialReviewArchive(
  doc: Y.Doc,
  input: SaveAdversarialReviewInput,
): Promise<{ archive: AdversarialReviewArchive; researchRevision: string }> {
  const { metadata, discussions } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== input.projectId) throw new Error('Live collaboration document project identity does not match')
  const archive = await createArchive(input)
  const decoded = await decodedArchives(discussions)
  if (decoded.some(({ archive: candidate }) => !candidate)) {
    throw new Error('Adversarial review history contains invalid records')
  }
  const sameRun = decoded.filter(({ archive: candidate }) => candidate?.runId === archive.runId)
  if (sameRun.some(({ archive: candidate }) => candidate?.recordSha256 !== archive.recordSha256)) {
    throw new Error('Adversarial review run ID conflicts with a different archive')
  }
  const existing = sameRun[0]?.archive
  if (archiveEntries(discussions).length >= MAX_ARCHIVE_RECORDS && !existing) {
    throw new Error('Adversarial review archive limit reached')
  }
  const key = `${ARCHIVE_PREFIX}${peerKey(discussions, archive.runId)}`
  const canonical = JSON.stringify(archive)
  const current = discussions.get(key)
  if (current !== undefined && current !== canonical) throw new Error('Adversarial review archive identity conflict')
  doc.transact(() => {
    if (metadata.get('projectId') !== input.projectId ||
      projectStateFingerprint(doc) !== input.expectedResearchRevision) {
      throw new Error('Research state changed before the adversarial review could be saved')
    }
    if (current === undefined) discussions.set(key, canonical)
  }, 'syzygy-adversarial-review-archive')
  return {
    archive: existing ? clone(existing) : archive,
    researchRevision: projectStateFingerprint(doc),
  }
}

function validDecisionEvent(value: unknown): value is AdversarialReviewDecisionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, [
      'schemaVersion', 'eventId', 'runId', 'recordSha256', 'expectedCurrentDecisionId',
      'decision', 'participantId', 'displayName', 'notes', 'timestamp',
    ])) return false
  const event = value as Partial<AdversarialReviewDecisionEvent>
  return event.schemaVersion === ADVERSARIAL_REVIEW_DECISION_VERSION &&
    stableId(event.eventId) && stableId(event.runId) &&
    typeof event.recordSha256 === 'string' && shaPattern.test(event.recordSha256) &&
    (event.expectedCurrentDecisionId === null || stableId(event.expectedCurrentDecisionId)) &&
    typeof event.decision === 'string' && decisions.has(event.decision as AdversarialReviewDecision) &&
    stableId(event.participantId) && boundedText(event.displayName, 200) &&
    boundedText(event.notes, MAX_NOTES, true) && validTimestamp(event.timestamp)
}

function decodeDecision(value: unknown): AdversarialReviewDecisionEvent | null {
  if (typeof value !== 'string' || value.length > MAX_NOTES + 2_000) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return validDecisionEvent(parsed) ? clone(parsed) : null
  } catch {
    return null
  }
}

function decisionEventsFor(discussions: Y.Map<unknown>, runId: string) {
  return decisionEntries(discussions).flatMap(([, value]) => {
    const event = decodeDecision(value)
    return event?.runId === runId ? [event] : []
  })
}

export function readAdversarialReviewDecision(
  discussions: Y.Map<unknown>,
  runId: string,
): AdversarialReviewDecisionSummary | null {
  if (!stableId(runId)) return null
  const raw = decisionEventsFor(discussions, runId)
  if (raw.length === 0) return null
  const byId = new Map<string, AdversarialReviewDecisionEvent>()
  for (const event of raw) {
    const existing = byId.get(event.eventId)
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) return null
    byId.set(event.eventId, event)
  }
  const events = [...byId.values()]
  const recordHashes = new Set(events.map(({ recordSha256 }) => recordSha256))
  if (recordHashes.size !== 1) return null
  const roots = events.filter(({ expectedCurrentDecisionId }) => expectedCurrentDecisionId === null)
  if (roots.length !== 1) return null
  const history: AdversarialReviewDecisionEvent[] = [roots[0]]
  const visited = new Set([roots[0].eventId])
  while (true) {
    const children = events.filter(({ expectedCurrentDecisionId }) =>
      expectedCurrentDecisionId === history[history.length - 1].eventId)
    if (children.length > 1) return null
    if (children.length === 0) break
    if (visited.has(children[0].eventId)) return null
    history.push(children[0])
    visited.add(children[0].eventId)
  }
  if (visited.size !== events.length) return null
  return {
    runId,
    recordSha256: history[0].recordSha256,
    current: clone(history[history.length - 1]),
    history: history.map(clone),
  }
}

export async function decideAdversarialReview(
  doc: Y.Doc,
  input: DecideAdversarialReviewInput,
): Promise<{ decision: AdversarialReviewDecisionSummary; researchRevision: string }> {
  if (!stableId(input.projectId) || !boundedText(input.expectedResearchRevision, 500) ||
    !stableId(input.runId) || !shaPattern.test(input.recordSha256) ||
    (input.expectedCurrentDecisionId !== null && !stableId(input.expectedCurrentDecisionId)) ||
    !decisions.has(input.decision) || !stableId(input.eventId) ||
    !stableId(input.participantId) || !boundedText(input.displayName, 200) ||
    !boundedText(input.notes, MAX_NOTES, true) || !validTimestamp(input.timestamp)) {
    throw new Error('Invalid adversarial review decision')
  }
  const { metadata, discussions } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== input.projectId) throw new Error('Live collaboration document project identity does not match')
  const archive = await readAdversarialReviewArchive(discussions, input.runId)
  if (!archive || archive.projectId !== input.projectId || archive.recordSha256 !== input.recordSha256) {
    throw new Error('Adversarial review archive is missing, conflicted, or changed')
  }
  const rawDecisionEntries = decisionEntries(discussions)
  if (rawDecisionEntries.some(([, value]) => !decodeDecision(value))) {
    throw new Error('Adversarial review decision history contains invalid records')
  }
  const event: AdversarialReviewDecisionEvent = {
    schemaVersion: ADVERSARIAL_REVIEW_DECISION_VERSION,
    eventId: input.eventId,
    runId: input.runId,
    recordSha256: input.recordSha256,
    expectedCurrentDecisionId: input.expectedCurrentDecisionId,
    decision: input.decision,
    participantId: input.participantId,
    displayName: input.displayName.trim(),
    notes: input.notes.replace(/\r\n?/g, '\n'),
    timestamp: input.timestamp,
  }
  const allSameId = rawDecisionEntries.flatMap(([, value]) => {
    const candidate = decodeDecision(value)
    return candidate?.eventId === input.eventId ? [candidate] : []
  })
  if (allSameId.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(event))) {
    throw new Error('Adversarial review decision event ID was reused')
  }
  const replay = allSameId.find((candidate) => JSON.stringify(candidate) === JSON.stringify(event))
  const existingEvents = decisionEventsFor(discussions, input.runId)
  const current = existingEvents.length ? readAdversarialReviewDecision(discussions, input.runId) : null
  if (existingEvents.length && (!current || current.recordSha256 !== archive.recordSha256)) {
    throw new Error('Adversarial review decision history is conflicted')
  }
  if (replay) {
    if (!current || !current.history.some(({ eventId }) => eventId === replay.eventId)) {
      throw new Error('Adversarial review decision history is conflicted')
    }
    return { decision: current, researchRevision: projectStateFingerprint(doc) }
  }
  if ((current?.current.eventId ?? null) !== input.expectedCurrentDecisionId) {
    throw new Error('Adversarial review decision changed; inspect again')
  }
  if (rawDecisionEntries.length >= MAX_DECISION_EVENTS) {
    throw new Error('Adversarial review decision history limit reached')
  }
  const key = `${DECISION_PREFIX}${peerKey(discussions, input.eventId)}`
  const canonical = JSON.stringify(event)
  const stored = discussions.get(key)
  if (stored !== undefined && stored !== canonical) throw new Error('Adversarial review decision identity conflict')
  doc.transact(() => {
    if (metadata.get('projectId') !== input.projectId ||
      projectStateFingerprint(doc) !== input.expectedResearchRevision) {
      throw new Error('Research state changed before the adversarial review decision')
    }
    if (stored === undefined) discussions.set(key, canonical)
  }, 'syzygy-adversarial-review-decision')
  const summary = readAdversarialReviewDecision(discussions, input.runId)
  if (!summary) throw new Error('Adversarial review decision failed post-write validation')
  return { decision: summary, researchRevision: projectStateFingerprint(doc) }
}

export async function inspectAdversarialReviewHistory(
  discussions: Y.Map<unknown>,
): Promise<{
  healthy: boolean
  archiveCount: number
  decisionCount: number
  invalidRecords: number
  conflictedRunIds: string[]
  items: AdversarialReviewSummary[]
  issues: string[]
}> {
  const rawArchives = await decodedArchives(discussions)
  const invalidArchives = rawArchives.filter(({ archive }) => !archive).length
  const validArchives = rawArchives.flatMap(({ archive }) => archive ? [archive] : [])
  const grouped = new Map<string, AdversarialReviewArchive[]>()
  validArchives.forEach((archive) => {
    const group = grouped.get(archive.runId) ?? []
    group.push(archive)
    grouped.set(archive.runId, group)
  })
  const conflictedRunIds = [...grouped.entries()]
    .filter(([, group]) => new Set(group.map(({ recordSha256 }) => recordSha256)).size !== 1)
    .map(([runId]) => runId)
    .sort()
  const archives = [...grouped.entries()]
    .filter(([runId]) => !conflictedRunIds.includes(runId))
    .map(([, group]) => group[0])
  const rawDecisions = decisionEntries(discussions)
  const invalidDecisionRecords = rawDecisions.filter(([, value]) => !decodeDecision(value)).length
  const decisionRunIds = [...new Set(rawDecisions.flatMap(([, value]) => {
    const event = decodeDecision(value)
    return event ? [event.runId] : []
  }))]
  const archiveByRunId = new Map(archives.map((archive) => [archive.runId, archive]))
  const conflictedDecisionRunIds = decisionRunIds.filter((runId) => {
    const decision = readAdversarialReviewDecision(discussions, runId)
    const archive = archiveByRunId.get(runId)
    return decisionEventsFor(discussions, runId).length > 0 &&
      (!decision || !archive || decision.recordSha256 !== archive.recordSha256)
  })
  conflictedRunIds.push(...conflictedDecisionRunIds.filter((runId) => !conflictedRunIds.includes(runId)))
  conflictedRunIds.sort()
  const issues: string[] = []
  if (invalidArchives + invalidDecisionRecords > 0) {
    issues.push(`${invalidArchives + invalidDecisionRecords} adversarial review record(s) failed validation`)
  }
  conflictedRunIds.forEach((runId) => issues.push(`Adversarial review ${runId} has conflicting archive or decision history`))
  const items = archives.map((archive) => {
    const decision = readAdversarialReviewDecision(discussions, archive.runId)
    const conflicted = conflictedRunIds.includes(archive.runId)
    return {
      runId: archive.runId,
      recordSha256: archive.recordSha256,
      sourceDocumentRevision: archive.sourceDocumentRevision,
      researchRevisionAtSave: archive.researchRevisionAtSave,
      createdBy: clone(archive.createdBy),
      createdAt: archive.createdAt,
      sourceCount: archive.request.sources.length,
      participantCount: archive.outcome.plan.participantCount,
      providerCount: archive.outcome.plan.providerCount,
      totalRemoteCalls: archive.outcome.authorization.totalRemoteCalls,
      decision: conflicted ? 'conflicted' as const : decision?.current.decision ?? 'pending' as const,
      currentDecisionId: conflicted ? null : decision?.current.eventId ?? null,
      decisionCount: conflicted ? 0 : decision?.history.length ?? 0,
    }
  }).sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId))
  return {
    healthy: issues.length === 0,
    archiveCount: archives.length,
    decisionCount: rawDecisions.length - invalidDecisionRecords,
    invalidRecords: invalidArchives + invalidDecisionRecords,
    conflictedRunIds,
    items,
    issues,
  }
}
