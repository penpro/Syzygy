import * as Y from 'yjs'
import type {
  ProviderNormalizedResponse,
  ProviderResearchTaskRequest,
} from '../tauri'
import {
  validateProviderRunRecord,
  type ProviderRunRecord,
} from '../extensions/providerRunRecord'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'

export const PROVIDER_REVIEW_ARCHIVE_VERSION = 1 as const
export const PROVIDER_REVIEW_PREFIX = 'provider-review:v1:'
export const MAX_PROVIDER_REVIEW_ARCHIVES = 256
export const MAX_PROVIDER_REVIEW_ARCHIVE_BYTES = 8 * 1024 * 1024
export const MAX_PROVIDER_REVIEW_HISTORY_BYTES = 32 * 1024 * 1024

export interface ProviderReviewArchive {
  schemaVersion: typeof PROVIDER_REVIEW_ARCHIVE_VERSION
  recordSha256: string
  runId: string
  projectId: string
  documentId: string
  sourceDocumentRevision: string
  researchRevisionAtSave: string
  request: ProviderResearchTaskRequest
  response: ProviderNormalizedResponse
  runRecord: ProviderRunRecord
  createdBy: {
    participantId: string
    displayName: string
  }
  createdAt: number
}

export interface SaveProviderReviewInput {
  expectedResearchRevision: string
  projectId: string
  documentId: string
  sourceDocumentRevision: string
  request: ProviderResearchTaskRequest
  response: ProviderNormalizedResponse
  runRecord: ProviderRunRecord
  participantId: string
  displayName: string
  createdAt: number
}

export interface ProviderReviewSummary {
  runId: string
  recordSha256: string
  sourceDocumentRevision: string
  providerId: string
  model: string
  createdBy: ProviderReviewArchive['createdBy']
  createdAt: number
  sourceCount: number
  totalTokens: number | null
}

export interface ProviderReviewHistoryInspection {
  healthy: boolean
  archiveCount: number
  items: ProviderReviewSummary[]
  conflictedRunIds: string[]
  issues: string[]
  totalBytes: number
}

const SHA256_HEX = /^[a-f0-9]{64}$/
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const RESEARCH_REVISION = /^[0-9]+(?:\.[0-9]+)*$/
const PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'xai'])
const encoder = new TextEncoder()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')

const boundedId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && STABLE_ID.test(value)

const boundedText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max &&
  (allowEmpty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)

const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const jsonBytes = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? encoder.encode(serialized).byteLength : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

function strictSource(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['snapshotId', 'label', 'excerpt']) &&
    boundedId(value.snapshotId, 512) && boundedText(value.label, 1_000) &&
    boundedText(value.excerpt, 4 * 1024 * 1024)
}

function strictToolDefinition(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['name', 'description', 'parameters']) &&
    typeof value.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.name) &&
    boundedText(value.description, 4_096) && isRecord(value.parameters) &&
    jsonBytes(value.parameters) <= 64 * 1024
}

function strictRequest(value: unknown): value is ProviderResearchTaskRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'runId', 'callId', 'taskType', 'provider', 'timeoutMs', 'model',
    'developerInstructions', 'question', 'sources', 'maxOutputTokens',
    'toolDefinitions', 'enableSourceLocator',
  ]) || !boundedId(value.runId) || !boundedId(value.callId) ||
    value.taskType !== 'research.remote-review' || typeof value.provider !== 'string' ||
    !PROVIDERS.has(value.provider) || !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 600_000 ||
    !boundedText(value.model, 200) ||
    !(value.developerInstructions === null || boundedText(value.developerInstructions, 20_000)) ||
    !boundedText(value.question, 20_000) || !Array.isArray(value.sources) ||
    value.sources.length < 1 || value.sources.length > 16 || !value.sources.every(strictSource) ||
    !Number.isSafeInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1 ||
    Number(value.maxOutputTokens) > 1_000_000 || !Array.isArray(value.toolDefinitions) ||
    value.toolDefinitions.length > 32 || !value.toolDefinitions.every(strictToolDefinition) ||
    typeof value.enableSourceLocator !== 'boolean') return false
  const names = value.toolDefinitions.map((tool) => tool.name)
  const sourceIds = value.sources.map((source) => source.snapshotId)
  return new Set(names).size === names.length && new Set(sourceIds).size === sourceIds.length
}

function strictValidation(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['schemaStatus', 'domainStatus', 'executable', 'errors']) &&
    ['pending', 'valid', 'invalid', 'missing-definition'].includes(String(value.schemaStatus)) &&
    ['unreviewed', 'source-snapshot-approved', 'source-snapshot-rejected'].includes(String(value.domainStatus)) &&
    typeof value.executable === 'boolean' && Array.isArray(value.errors) && value.errors.length <= 8 &&
    value.errors.every((error) => boundedText(error, 500, true))
}

function strictToolProposal(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['callId', 'name', 'arguments', 'validation']) &&
    boundedText(value.callId, 512) && typeof value.name === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.name) && isRecord(value.arguments) &&
    jsonBytes(value.arguments) <= 256 * 1024 && strictValidation(value.validation)
}

function strictResponse(value: unknown): value is ProviderNormalizedResponse {
  if (!isRecord(value) || !exactKeys(value, [
    'provider', 'id', 'status', 'model', 'text', 'refusals', 'unknownOutputTypes',
    'toolProposals', 'usage',
  ]) || typeof value.provider !== 'string' || !PROVIDERS.has(value.provider) ||
    !boundedText(value.id, 512) || value.status !== 'completed' ||
    !(value.model === null || boundedText(value.model, 200)) ||
    !boundedText(value.text, 4 * 1024 * 1024, true) || !Array.isArray(value.refusals) ||
    value.refusals.length > 128 || !value.refusals.every((item) => boundedText(item, 20_000, true)) ||
    !Array.isArray(value.unknownOutputTypes) || value.unknownOutputTypes.length > 128 ||
    !value.unknownOutputTypes.every((item) => boundedText(item, 500, true)) ||
    !Array.isArray(value.toolProposals) || value.toolProposals.length > 32 ||
    !value.toolProposals.every(strictToolProposal)) return false
  if (value.usage === null) return true
  return isRecord(value.usage) && exactKeys(value.usage, ['inputTokens', 'outputTokens', 'totalTokens']) &&
    [value.usage.inputTokens, value.usage.outputTokens, value.usage.totalTokens]
      .every(nonnegativeSafeInteger) &&
    Number(value.usage.inputTokens) + Number(value.usage.outputTokens) === Number(value.usage.totalTokens)
}

function strictRunRecord(value: unknown): value is ProviderRunRecord {
  if (!isRecord(value)) return false
  try {
    return validateProviderRunRecord(value as unknown as ProviderRunRecord).length === 0
  } catch {
    return false
  }
}

function canonicalArchiveWithoutHash(archive: ProviderReviewArchive): Omit<ProviderReviewArchive, 'recordSha256'> {
  return {
    schemaVersion: 1,
    runId: archive.runId,
    projectId: archive.projectId,
    documentId: archive.documentId,
    sourceDocumentRevision: archive.sourceDocumentRevision,
    researchRevisionAtSave: archive.researchRevisionAtSave,
    request: structuredClone(archive.request),
    response: structuredClone(archive.response),
    runRecord: structuredClone(archive.runRecord),
    createdBy: { ...archive.createdBy },
    createdAt: archive.createdAt,
  }
}

async function parseArchive(value: unknown): Promise<ProviderReviewArchive | null> {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'recordSha256', 'runId', 'projectId', 'documentId',
    'sourceDocumentRevision', 'researchRevisionAtSave', 'request', 'response',
    'runRecord', 'createdBy', 'createdAt',
  ]) || value.schemaVersion !== 1 || typeof value.recordSha256 !== 'string' ||
    !SHA256_HEX.test(value.recordSha256) || !boundedId(value.runId) ||
    !boundedId(value.projectId) || !boundedId(value.documentId) ||
    !boundedId(value.sourceDocumentRevision, 1_024) ||
    typeof value.researchRevisionAtSave !== 'string' || value.researchRevisionAtSave.length > 32_000 ||
    !RESEARCH_REVISION.test(value.researchRevisionAtSave) || !strictRequest(value.request) ||
    !strictResponse(value.response) || !strictRunRecord(value.runRecord) ||
    !isRecord(value.createdBy) || !exactKeys(value.createdBy, ['participantId', 'displayName']) ||
    !boundedId(value.createdBy.participantId) || !boundedText(value.createdBy.displayName, 200) ||
    !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 1 ||
    Number(value.createdAt) > 8_640_000_000_000_000 ||
    jsonBytes(value) > MAX_PROVIDER_REVIEW_ARCHIVE_BYTES) return null
  const archive = structuredClone(value) as unknown as ProviderReviewArchive
  const requestSourceIds = archive.request.sources.map(({ snapshotId }) => snapshotId)
  if (archive.runId !== archive.request.runId || archive.runId !== archive.runRecord.runId ||
    archive.request.callId !== archive.runRecord.callId ||
    archive.request.provider !== archive.response.provider ||
    archive.request.provider !== archive.runRecord.provider.id ||
    archive.request.model !== archive.runRecord.provider.model ||
    archive.runRecord.result.status !== 'completed' ||
    archive.runRecord.request.taskType !== archive.request.taskType ||
    archive.runRecord.request.sourceSnapshotIds.join('\n') !== requestSourceIds.join('\n') ||
    archive.runRecord.request.maxOutputTokens !== archive.request.maxOutputTokens ||
    archive.runRecord.request.timeoutMs !== archive.request.timeoutMs) return null
  const expected = await sha256Hex(canonicalJson(canonicalArchiveWithoutHash(archive)))
  return expected === archive.recordSha256 ? archive : null
}

function emptyInspection(overrides: Partial<ProviderReviewHistoryInspection> = {}): ProviderReviewHistoryInspection {
  return {
    healthy: true,
    archiveCount: 0,
    items: [],
    conflictedRunIds: [],
    issues: [],
    totalBytes: 0,
    ...overrides,
  }
}

function compareArchives(left: ProviderReviewArchive, right: ProviderReviewArchive): number {
  return left.createdAt - right.createdAt || left.recordSha256.localeCompare(right.recordSha256)
}

export async function inspectProviderReviewHistory(
  discussions: Y.Map<unknown>,
): Promise<ProviderReviewHistoryInspection> {
  const candidates = Array.from(discussions.entries())
    .filter(([key]) => key.startsWith(PROVIDER_REVIEW_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
  if (candidates.length > MAX_PROVIDER_REVIEW_ARCHIVES) {
    return emptyInspection({
      healthy: false,
      archiveCount: candidates.length,
      issues: [`Provider review history exceeds ${MAX_PROVIDER_REVIEW_ARCHIVES} archives`],
    })
  }
  let totalBytes = 0
  const archives: ProviderReviewArchive[] = []
  const issues: string[] = []
  for (const [key, value] of candidates) {
    const size = jsonBytes(value)
    totalBytes += size
    if (size > MAX_PROVIDER_REVIEW_ARCHIVE_BYTES) {
      issues.push(`Provider review record ${key} exceeds the per-archive bound`)
      continue
    }
    const parsed = await parseArchive(value)
    if (!parsed || !key.endsWith(`:${parsed.runId}`)) issues.push(`Provider review record ${key} failed integrity checks`)
    else archives.push(parsed)
  }
  if (totalBytes > MAX_PROVIDER_REVIEW_HISTORY_BYTES) {
    issues.push(`Provider review history exceeds ${MAX_PROVIDER_REVIEW_HISTORY_BYTES} bytes`)
  }
  const byRun = new Map<string, ProviderReviewArchive[]>()
  for (const archive of archives) {
    const group = byRun.get(archive.runId) ?? []
    group.push(archive)
    byRun.set(archive.runId, group)
  }
  const items: ProviderReviewSummary[] = []
  const conflictedRunIds: string[] = []
  for (const [runId, group] of byRun) {
    const hashes = new Set(group.map(({ recordSha256 }) => recordSha256))
    if (hashes.size !== 1) {
      conflictedRunIds.push(runId)
      continue
    }
    const archive = [...group].sort(compareArchives)[0]
    items.push({
      runId,
      recordSha256: archive.recordSha256,
      sourceDocumentRevision: archive.sourceDocumentRevision,
      providerId: archive.runRecord.provider.id,
      model: archive.runRecord.provider.model,
      createdBy: { ...archive.createdBy },
      createdAt: archive.createdAt,
      sourceCount: archive.request.sources.length,
      totalTokens: archive.runRecord.usage.totalTokens,
    })
  }
  items.sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId))
  conflictedRunIds.sort()
  if (conflictedRunIds.length) issues.push(`${conflictedRunIds.length} provider review run identity conflict(s) require inspection`)
  return {
    healthy: issues.length === 0,
    archiveCount: candidates.length,
    items,
    conflictedRunIds,
    issues,
    totalBytes,
  }
}

export async function readProviderReviewArchive(
  discussions: Y.Map<unknown>,
  runId: string,
): Promise<ProviderReviewArchive | null> {
  if (!boundedId(runId)) return null
  const matches: ProviderReviewArchive[] = []
  for (const [key, value] of Array.from(discussions.entries())) {
    if (!key.startsWith(PROVIDER_REVIEW_PREFIX) || !key.endsWith(`:${runId}`)) continue
    const archive = await parseArchive(value)
    if (!archive || archive.runId !== runId) return null
    matches.push(archive)
  }
  if (!matches.length || new Set(matches.map(({ recordSha256 }) => recordSha256)).size !== 1) return null
  return [...matches].sort(compareArchives)[0]
}

export async function saveProviderReview(
  document: Y.Doc,
  input: SaveProviderReviewInput,
): Promise<ProviderReviewArchive> {
  const { metadata, discussions } = getProjectSharedTypes(document)
  if (metadata.get('projectId') !== input.projectId || document.guid !== input.documentId) {
    throw new Error('Live collaboration document identity does not match the provider review')
  }
  if (projectStateFingerprint(document) !== input.expectedResearchRevision) {
    throw new Error('Shared research changed before the provider review could be saved')
  }
  const before = await inspectProviderReviewHistory(discussions)
  if (!before.healthy) throw new Error('Shared provider review history needs attention before another archive can be saved')
  if (before.items.some(({ runId }) => runId === input.request.runId) ||
    before.conflictedRunIds.includes(input.request.runId)) {
    throw new Error('Provider review run identity already exists')
  }
  if (before.archiveCount >= MAX_PROVIDER_REVIEW_ARCHIVES) throw new Error('Provider review history limit reached')
  const unsigned: ProviderReviewArchive = {
    schemaVersion: 1,
    recordSha256: '0'.repeat(64),
    runId: input.request.runId,
    projectId: input.projectId,
    documentId: input.documentId,
    sourceDocumentRevision: input.sourceDocumentRevision,
    researchRevisionAtSave: input.expectedResearchRevision,
    request: structuredClone(input.request),
    response: structuredClone(input.response),
    runRecord: structuredClone(input.runRecord),
    createdBy: { participantId: input.participantId, displayName: input.displayName.trim() },
    createdAt: input.createdAt,
  }
  const recordSha256 = await sha256Hex(canonicalJson(canonicalArchiveWithoutHash(unsigned)))
  const archive = { ...unsigned, recordSha256 }
  if (!await parseArchive(archive)) throw new Error('Provider review archive failed validation')
  if (before.totalBytes + jsonBytes(archive) > MAX_PROVIDER_REVIEW_HISTORY_BYTES) {
    throw new Error('Provider review history byte limit reached')
  }
  const key = `${PROVIDER_REVIEW_PREFIX}${document.clientID}:${archive.runId}`
  let stale = false
  document.transact(() => {
    if (projectStateFingerprint(document) !== input.expectedResearchRevision) {
      stale = true
      return
    }
    discussions.set(key, structuredClone(archive))
  }, 'syzygy-provider-review-archive')
  if (stale) throw new Error('Shared research changed before the provider review could be saved')
  const stored = await readProviderReviewArchive(discussions, archive.runId)
  if (!stored || stored.recordSha256 !== archive.recordSha256) {
    throw new Error('Provider review archive was not retained exactly')
  }
  return stored
}

export function providerReviewArchiveAttestationEventId(archive: ProviderReviewArchive): string {
  return `archive:${archive.runId}`
}

export async function providerReviewArchiveEventSha256(archive: ProviderReviewArchive): Promise<string> {
  const parsed = await parseArchive(archive)
  if (!parsed) throw new Error('Provider review archive is invalid')
  return sha256Base64Url(canonicalJson(parsed))
}
