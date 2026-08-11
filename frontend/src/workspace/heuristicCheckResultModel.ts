import * as Y from 'yjs'
import type { AutomationDocumentBlock } from './editorAutomationRegistry'
import {
  heuristicCheckExampleRevision,
  heuristicCheckHeuristicRevision,
  heuristicCheckPolicyText,
  validateHeuristicCheckOutput,
  type HeuristicCheckCitation,
  type HeuristicCheckOutput,
  type HeuristicCheckProviderId,
  type HeuristicCheckRequest,
  type HeuristicCheckVerdict,
} from './heuristicCheck'
import { listActiveHeuristicExamples } from './heuristicExampleModel'
import { readHeuristic } from './heuristicsModel'
import { getProjectSharedTypes } from './projectModel'

export const HEURISTIC_CHECK_RESULT_SCHEMA_VERSION = 1 as const
const BUCKET_PREFIX = 'heuristic-check-results:v1:'
const MAX_BUCKETS = 20_000
const MAX_RESULTS_PER_HEURISTIC = 100_000

export interface HeuristicCheckResult {
  schemaVersion: typeof HEURISTIC_CHECK_RESULT_SCHEMA_VERSION
  resultId: string
  runId: string
  projectId: string
  documentId: string
  heuristicId: string
  heuristicRevision: string
  exampleRevision: string
  sourceRevision: string
  providerId: HeuristicCheckProviderId
  requestedModelId: string
  executedModelId: string
  verdict: HeuristicCheckVerdict
  rationale: string
  uncertainty: string
  citations: HeuristicCheckCitation[]
  authorId: string
  authorDisplayName: string
  timestamp: number
}

export interface CommitHeuristicCheckResultInput {
  resultId: string
  authorId: string
  authorDisplayName: string
  timestamp: number
  currentBlocks: AutomationDocumentBlock[]
}

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function canonicalHeuristicCheckResult(result: HeuristicCheckResult): string {
  return JSON.stringify({
    schemaVersion: result.schemaVersion, resultId: result.resultId, runId: result.runId,
    projectId: result.projectId, documentId: result.documentId, heuristicId: result.heuristicId,
    heuristicRevision: result.heuristicRevision, exampleRevision: result.exampleRevision,
    sourceRevision: result.sourceRevision, providerId: result.providerId,
    requestedModelId: result.requestedModelId, executedModelId: result.executedModelId,
    verdict: result.verdict, rationale: result.rationale, uncertainty: result.uncertainty,
    citations: result.citations.map(({ start, end, quote }) => ({ start, end, quote })),
    authorId: result.authorId, authorDisplayName: result.authorDisplayName, timestamp: result.timestamp,
  })
}

export async function heuristicCheckResultSha256(result: HeuristicCheckResult): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalHeuristicCheckResult(result))
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

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

const providerIds = new Set<HeuristicCheckProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])
const verdicts = new Set<HeuristicCheckVerdict>(['pass', 'fail', 'uncertain'])

function validCitation(value: unknown): value is HeuristicCheckCitation {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['start', 'end', 'quote'])) return false
  const citation = value as Partial<HeuristicCheckCitation>
  return Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end) &&
    citation.start! >= 0 && citation.end! > citation.start! && validText(citation.quote, 100_000)
}

function validResult(value: unknown): value is HeuristicCheckResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'resultId', 'runId', 'projectId', 'documentId', 'heuristicId',
    'heuristicRevision', 'exampleRevision', 'sourceRevision', 'providerId', 'requestedModelId',
    'executedModelId', 'verdict', 'rationale', 'uncertainty', 'citations', 'authorId',
    'authorDisplayName', 'timestamp',
  ])) return false
  const result = value as Partial<HeuristicCheckResult>
  return result.schemaVersion === HEURISTIC_CHECK_RESULT_SCHEMA_VERSION && stableId(result.resultId) &&
    stableId(result.runId) && stableId(result.projectId) && stableId(result.documentId) &&
    stableId(result.heuristicId) && validText(result.heuristicRevision, 100_000) &&
    validText(result.exampleRevision, 100_000) && validText(result.sourceRevision, 200) &&
    providerIds.has(result.providerId as HeuristicCheckProviderId) &&
    validText(result.requestedModelId, 200) && validText(result.executedModelId, 200) &&
    verdicts.has(result.verdict as HeuristicCheckVerdict) && validText(result.rationale, 100_000) &&
    validText(result.uncertainty, 50_000) && Array.isArray(result.citations) &&
    result.citations.length > 0 && result.citations.length <= 50 && result.citations.every(validCitation) &&
    stableId(result.authorId) && validText(result.authorDisplayName, 200) && validTimestamp(result.timestamp)
}

const bucketEntries = (collection: Y.Map<unknown>) =>
  Array.from(collection.entries()).filter(([key]) => key.startsWith(BUCKET_PREFIX))

function resultsFor(collection: Y.Map<unknown>, heuristicId: string): HeuristicCheckResult[] | null {
  const raw: HeuristicCheckResult[] = []
  for (const [, bucket] of bucketEntries(collection)) {
    if (!(bucket instanceof Y.Map)) continue
    if (bucket.get('heuristicId') !== heuristicId) continue
    if (!exactYKeys(bucket, ['heuristicId', 'results']) || !(bucket.get('results') instanceof Y.Map)) return null
    for (const result of (bucket.get('results') as Y.Map<unknown>).values()) {
      if (!validResult(result) || result.heuristicId !== heuristicId) return null
      raw.push(result)
      if (raw.length > MAX_RESULTS_PER_HEURISTIC) return null
    }
  }
  const byId = new Map<string, HeuristicCheckResult>()
  for (const result of raw) {
    const previous = byId.get(result.resultId)
    if (previous && JSON.stringify(previous) !== JSON.stringify(result)) return null
    byId.set(result.resultId, result)
  }
  return Array.from(byId.values()).map((result) => structuredClone(result)).sort((left, right) =>
    left.timestamp - right.timestamp || left.resultId.localeCompare(right.resultId))
}

export function listHeuristicCheckResults(collection: Y.Map<unknown>, heuristicId: string): HeuristicCheckResult[] {
  if (!stableId(heuristicId)) return []
  return resultsFor(collection, heuristicId) ?? []
}

export function readHeuristicCheckResult(
  collection: Y.Map<unknown>, heuristicId: string, resultId: string,
): HeuristicCheckResult | null {
  return listHeuristicCheckResults(collection, heuristicId)
    .find((result) => result.resultId === resultId) ?? null
}

function appendResult(collection: Y.Map<unknown>, result: HeuristicCheckResult): void {
  const existing = resultsFor(collection, result.heuristicId)
  if (existing === null) throw new Error('Heuristic check result history is invalid')
  const replay = existing.find(({ resultId }) => resultId === result.resultId)
  if (replay) {
    if (JSON.stringify(replay) !== JSON.stringify(result)) throw new Error('Heuristic check result ID was reused')
    return
  }
  if (existing.length >= MAX_RESULTS_PER_HEURISTIC) throw new Error('Heuristic check result limit reached')
  const bucketKey = `${BUCKET_PREFIX}${peerKey(collection, result.heuristicId)}`
  const stored = collection.get(bucketKey)
  if (stored !== undefined && (!(stored instanceof Y.Map) || stored.get('heuristicId') !== result.heuristicId)) {
    throw new Error('Heuristic check result bucket identity conflict')
  }
  let bucket = stored instanceof Y.Map ? stored : undefined
  const operation = () => {
    if (!bucket) {
      if (bucketEntries(collection).length >= MAX_BUCKETS) throw new Error('Heuristic check result bucket limit reached')
      bucket = new Y.Map<unknown>()
      bucket.set('heuristicId', result.heuristicId)
      bucket.set('results', new Y.Map<HeuristicCheckResult>())
      collection.set(bucketKey, bucket)
    }
    ;(bucket.get('results') as Y.Map<HeuristicCheckResult>).set(peerKey(collection, result.resultId), result)
  }
  if (collection.doc) collection.doc.transact(operation, 'syzygy-heuristic-check-results')
  else operation()
}

export function commitHeuristicCheckResult(
  doc: Y.Doc,
  request: HeuristicCheckRequest,
  output: HeuristicCheckOutput,
  input: CommitHeuristicCheckResultInput,
): HeuristicCheckResult {
  const validated = validateHeuristicCheckOutput(request, output)
  const { metadata, discussions, heuristics } = getProjectSharedTypes(doc)
  if (doc.guid !== request.documentId || metadata.get('projectId') !== request.projectId) {
    throw new Error('Heuristic check project identity changed before commit')
  }
  const currentHeuristic = readHeuristic(heuristics, request.heuristicId)
  if (!currentHeuristic || heuristicCheckHeuristicRevision(currentHeuristic) !== request.heuristicRevision) {
    throw new Error('Heuristic changed during evaluation; review it and run again')
  }
  const currentExamples = listActiveHeuristicExamples(discussions, request.heuristicId)
  if (heuristicCheckExampleRevision(currentExamples) !== request.exampleRevision) {
    throw new Error('Heuristic examples changed during evaluation; review them and run again')
  }
  if (heuristicCheckPolicyText(input.currentBlocks) !== request.policyText) {
    throw new Error('Policy changed during evaluation; review it and run again')
  }
  const result: HeuristicCheckResult = {
    schemaVersion: HEURISTIC_CHECK_RESULT_SCHEMA_VERSION,
    resultId: input.resultId,
    runId: validated.runId,
    projectId: request.projectId,
    documentId: request.documentId,
    heuristicId: request.heuristicId,
    heuristicRevision: request.heuristicRevision,
    exampleRevision: request.exampleRevision,
    sourceRevision: request.sourceRevision,
    providerId: validated.providerId,
    requestedModelId: validated.requestedModelId,
    executedModelId: validated.executedModelId,
    verdict: validated.verdict,
    rationale: validated.rationale,
    uncertainty: validated.uncertainty,
    citations: validated.citations.map((citation) => ({ ...citation })),
    authorId: input.authorId,
    authorDisplayName: input.authorDisplayName,
    timestamp: input.timestamp,
  }
  if (!validResult(result)) throw new Error('Invalid heuristic check result')
  appendResult(discussions, result)
  return listHeuristicCheckResults(discussions, request.heuristicId).find(({ resultId }) =>
    resultId === input.resultId)!
}

export function inspectHeuristicCheckResults(collection: Y.Map<unknown>, heuristics: Y.Map<unknown>) {
  const entries = bucketEntries(collection)
  const heuristicIds = Array.from(new Set(entries.flatMap(([, bucket]) =>
    bucket instanceof Y.Map && stableId(bucket.get('heuristicId')) ? [bucket.get('heuristicId') as string] : []))).sort()
  const invalidBuckets = entries.filter(([, bucket]) => !(bucket instanceof Y.Map) ||
    !exactYKeys(bucket, ['heuristicId', 'results']) || !stableId(bucket.get('heuristicId')) ||
    !(bucket.get('results') instanceof Y.Map)).length
  const invalidGroups = heuristicIds.filter((id) => resultsFor(collection, id) === null).length
  const results = heuristicIds.flatMap((id) => resultsFor(collection, id) ?? [])
  const orphanHeuristicIds = heuristicIds.filter((id) => !readHeuristic(heuristics, id))
  const invalidRecords = invalidBuckets + invalidGroups + (entries.length > MAX_BUCKETS ? 1 : 0)
  const issues: string[] = []
  if (invalidRecords) issues.push(`${invalidRecords} heuristic check result record(s) failed validation`)
  orphanHeuristicIds.forEach((id) => issues.push(`Heuristic check results target missing heuristic ${id}`))
  return {
    healthy: issues.length === 0,
    resultCount: results.length,
    passCount: results.filter(({ verdict }) => verdict === 'pass').length,
    failCount: results.filter(({ verdict }) => verdict === 'fail').length,
    uncertainCount: results.filter(({ verdict }) => verdict === 'uncertain').length,
    localCount: results.filter(({ providerId }) => providerId === 'local').length,
    remoteCount: results.filter(({ providerId }) => providerId !== 'local').length,
    invalidRecords,
    orphanHeuristicIds,
    issues,
  }
}
