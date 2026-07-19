import type { PolicyVersion, VersionPolicyBlock } from './policyVersionModel'
import type { ScenarioEvaluationProviderId } from './scenarioEvaluation'
import type { ScenarioEvaluationResult, ScenarioRerunJob } from './scenarioRerunQueue'

export const SCENARIO_COMPARISON_FORMAT = 'syzygy-scenario-comparison-v1' as const
export const SCENARIO_COMPARISON_SCHEMA_VERSION = 1 as const
export const SCENARIO_COMPARISON_EXTENSION = '.syzygy-scenario-comparison.json'
export const SCENARIO_COMPARISON_MAX_FILE_BYTES = 24_000_000
const SCENARIO_COMPARISON_MAX_CONTENT_CHARS = 20_000_000
export const SCENARIO_COMPARISON_NONDETERMINISM_LABEL =
  'Model hash, sampler settings, and seed were not captured; repeating the same exact inputs may produce different output.'

const encoder = new TextEncoder()
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const sha256Pattern = /^[a-f0-9]{64}$/
const providers = new Set<ScenarioEvaluationProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])
const outcomes = ['handled', 'unhandled', 'uncertain'] as const
type Outcome = typeof outcomes[number]

export interface ScenarioComparisonSource {
  jobId: string
  policyVersion: PolicyVersion
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  executedModelIds: string[]
  promptVersion: string
  createdBy: string
  createdByDisplayName: string
  createdAt: number
  modelHash: null
  sampler: null
  seed: null
  nondeterminismLabel: typeof SCENARIO_COMPARISON_NONDETERMINISM_LABEL
}

export interface ScenarioComparisonRow {
  scenarioId: string
  scenarioRevision: string
  scenarioRevisionSha256: string
  outcomeChanged: boolean
  baseline: ScenarioEvaluationResult
  candidate: ScenarioEvaluationResult
}

export type ScenarioOutcomeMatrix = Record<Outcome, Record<Outcome, number>>

export interface ScenarioComparisonSummary {
  scenarioCount: number
  unchangedOutcomeCount: number
  changedOutcomeCount: number
  outcomeMatrix: ScenarioOutcomeMatrix
}

export interface ScenarioComparisonPayload {
  format: typeof SCENARIO_COMPARISON_FORMAT
  schemaVersion: typeof SCENARIO_COMPARISON_SCHEMA_VERSION
  projectId: string
  documentId: string
  latestSourceTimestamp: number
  baseline: ScenarioComparisonSource
  candidate: ScenarioComparisonSource
  summary: ScenarioComparisonSummary
  rows: ScenarioComparisonRow[]
}

export interface ScenarioComparisonArtifact extends ScenarioComparisonPayload {
  artifactSha256: string
}

const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && stableIdPattern.test(value)
const validText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) &&
  !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const routeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function policyPayload(version: PolicyVersion) {
  return {
    schemaVersion: version.schemaVersion,
    projectId: version.projectId,
    parentVersionId: version.parentVersionId,
    policy: { format: version.policy.format, blocks: version.policy.blocks.map((block) => ({ ...block })) },
    scenarioIds: [...version.scenarioIds],
    author: { ...version.author },
    createdAt: version.createdAt,
    note: version.note,
  }
}

function validBlock(block: unknown): block is VersionPolicyBlock {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false
  const value = block as Partial<VersionPolicyBlock>
  if (!['paragraph', 'heading1', 'heading2', 'quote', 'policy', 'spotlight', 'suggestion'].includes(value.kind ?? '') ||
    !validText(value.text, 500_000, true) || value.text !== value.text.replace(/\r\n?/g, '\n')) return false
  if (value.kind === 'policy') return exactKeys(block, ['kind', 'text', 'policyId', 'status']) &&
    stableId(value.policyId) && ['draft', 'review', 'approved'].includes(value.status ?? '')
  if (value.kind === 'spotlight') return exactKeys(block, ['kind', 'text', 'scenarioId']) &&
    value.text === '' && stableId(value.scenarioId)
  if (value.kind === 'suggestion') return exactKeys(block, ['kind', 'text', 'suggestionId']) &&
    value.text === '' && stableId(value.suggestionId)
  return exactKeys(block, ['kind', 'text'])
}

async function assertPolicyVersion(value: unknown, projectId: string): Promise<PolicyVersion> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'versionId', 'projectId', 'parentVersionId', 'policy', 'scenarioIds', 'author',
    'createdAt', 'note',
  ])) throw new Error('Scenario comparison policy snapshot has an unsupported shape')
  const version = value as PolicyVersion
  if (version.schemaVersion !== 1 || !sha256Pattern.test(version.versionId) || version.projectId !== projectId ||
    (version.parentVersionId !== null && !sha256Pattern.test(version.parentVersionId)) ||
    !version.policy || typeof version.policy !== 'object' || Array.isArray(version.policy) ||
    !exactKeys(version.policy, ['format', 'blocks']) || version.policy.format !== 'syzygy-semantic-blocks-v1' ||
    !Array.isArray(version.policy.blocks) || version.policy.blocks.length === 0 || version.policy.blocks.length > 10_000 ||
    !version.policy.blocks.every(validBlock) ||
    version.policy.blocks.reduce((total, block) => total + block.text.length, 0) > 500_000 ||
    new Set(version.policy.blocks.flatMap((block) => block.kind === 'policy' ? [block.policyId!] : [])).size !==
      version.policy.blocks.filter((block) => block.kind === 'policy').length ||
    new Set(version.policy.blocks.flatMap((block) => block.kind === 'suggestion' ? [block.suggestionId!] : [])).size !==
      version.policy.blocks.filter((block) => block.kind === 'suggestion').length ||
    !Array.isArray(version.scenarioIds) || version.scenarioIds.length > 10_000 ||
    !version.scenarioIds.every((id) => stableId(id)) || new Set(version.scenarioIds).size !== version.scenarioIds.length ||
    JSON.stringify([...version.scenarioIds].sort()) !== JSON.stringify(version.scenarioIds) ||
    !version.author || typeof version.author !== 'object' || Array.isArray(version.author) ||
    !exactKeys(version.author, ['participantId', 'displayName']) || !stableId(version.author.participantId) ||
    !validText(version.author.displayName, 200) || version.author.displayName.trim() !== version.author.displayName ||
    !validTimestamp(version.createdAt) || (version.note !== null &&
      (!validText(version.note, 20_000, true) || version.note !== version.note.replace(/\r\n?/g, '\n')))) {
    throw new Error('Scenario comparison policy snapshot is invalid')
  }
  const canonical = JSON.stringify(policyPayload(version))
  if (encoder.encode(canonical).byteLength > 1_000_000 || await sha256(canonical) !== version.versionId) {
    throw new Error('Scenario comparison policy snapshot checksum does not match')
  }
  return structuredClone(version)
}

function assertResult(value: unknown, source: ScenarioComparisonSource, row: {
  scenarioId: string; scenarioRevision: string; projectId: string; documentId: string
}): ScenarioEvaluationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'schemaVersion', 'resultId', 'jobId', 'itemId', 'attempt', 'runId', 'projectId', 'documentId',
    'policyVersionId', 'scenarioId', 'scenarioRevision', 'promptVersion', 'providerId',
    'requestedModelId', 'executedModelId', 'outcome', 'response', 'rationale', 'uncertainty',
    'authorId', 'authorDisplayName', 'timestamp',
  ])) throw new Error('Scenario comparison result has an unsupported shape')
  const result = value as ScenarioEvaluationResult
  if (result.schemaVersion !== 1 || !stableId(result.resultId) || result.jobId !== source.jobId ||
    !stableId(result.itemId) || !Number.isSafeInteger(result.attempt) || result.attempt < 1 || result.attempt > 3 ||
    !stableId(result.runId) || result.projectId !== row.projectId || result.documentId !== row.documentId ||
    result.policyVersionId !== source.policyVersion.versionId || result.scenarioId !== row.scenarioId ||
    result.scenarioRevision !== row.scenarioRevision || result.promptVersion !== source.promptVersion ||
    result.providerId !== source.providerId || result.requestedModelId !== source.requestedModelId ||
    !routeId(result.executedModelId) || !outcomes.includes(result.outcome) ||
    !validText(result.response, 500_000) || !validText(result.rationale, 100_000) ||
    !validText(result.uncertainty, 50_000) || !stableId(result.authorId) ||
    !validText(result.authorDisplayName, 200) || !validTimestamp(result.timestamp)) {
    throw new Error('Scenario comparison result does not match its exact source')
  }
  return structuredClone(result)
}

function emptyMatrix(): ScenarioOutcomeMatrix {
  return {
    handled: { handled: 0, unhandled: 0, uncertain: 0 },
    unhandled: { handled: 0, unhandled: 0, uncertain: 0 },
    uncertain: { handled: 0, unhandled: 0, uncertain: 0 },
  }
}

function summarize(rows: ScenarioComparisonRow[]): ScenarioComparisonSummary {
  const outcomeMatrix = emptyMatrix()
  let unchangedOutcomeCount = 0
  rows.forEach((row) => {
    outcomeMatrix[row.baseline.outcome][row.candidate.outcome] += 1
    if (!row.outcomeChanged) unchangedOutcomeCount += 1
  })
  return {
    scenarioCount: rows.length,
    unchangedOutcomeCount,
    changedOutcomeCount: rows.length - unchangedOutcomeCount,
    outcomeMatrix,
  }
}

function sourceFromJob(job: ScenarioRerunJob, policyVersion: PolicyVersion): ScenarioComparisonSource {
  return {
    jobId: job.definition.jobId,
    policyVersion: structuredClone(policyVersion),
    providerId: job.definition.providerId,
    requestedModelId: job.definition.requestedModelId,
    executedModelIds: Array.from(new Set(job.items.map(({ result }) => result!.executedModelId))).sort(),
    promptVersion: job.definition.promptVersion,
    createdBy: job.definition.createdBy,
    createdByDisplayName: job.definition.createdByDisplayName,
    createdAt: job.definition.createdAt,
    modelHash: null,
    sampler: null,
    seed: null,
    nondeterminismLabel: SCENARIO_COMPARISON_NONDETERMINISM_LABEL,
  }
}

function assertComparableJob(job: ScenarioRerunJob, version: PolicyVersion, side: string): void {
  if (job.status !== 'complete' || !job.items.length || job.items.some(({ status, result }) => status !== 'complete' || !result)) {
    throw new Error(`${side} scenario rerun queue is not complete`)
  }
  if (job.definition.policyVersionId !== version.versionId || job.definition.projectId !== version.projectId) {
    throw new Error(`${side} scenario rerun queue does not match its policy snapshot`)
  }
}

function canonicalPayload(payload: ScenarioComparisonPayload): string {
  return JSON.stringify(payload)
}

export async function createScenarioComparison(input: {
  baselineJob: ScenarioRerunJob
  candidateJob: ScenarioRerunJob
  baselineVersion: PolicyVersion
  candidateVersion: PolicyVersion
}): Promise<ScenarioComparisonArtifact> {
  assertComparableJob(input.baselineJob, input.baselineVersion, 'Baseline')
  assertComparableJob(input.candidateJob, input.candidateVersion, 'Candidate')
  const baselineJob = input.baselineJob
  const candidateJob = input.candidateJob
  if (baselineJob.definition.jobId === candidateJob.definition.jobId) throw new Error('Choose two different completed queues')
  if (baselineJob.definition.projectId !== candidateJob.definition.projectId ||
    baselineJob.definition.documentId !== candidateJob.definition.documentId) {
    throw new Error('Scenario comparison queues belong to different projects or documents')
  }
  if (baselineJob.definition.promptVersion !== candidateJob.definition.promptVersion) {
    throw new Error('Scenario comparison queues use different prompt versions')
  }
  const baselineByScenario = new Map(baselineJob.items.map((item) => [item.definition.scenarioId, item]))
  const candidateByScenario = new Map(candidateJob.items.map((item) => [item.definition.scenarioId, item]))
  if (baselineByScenario.size !== candidateByScenario.size ||
    [...baselineByScenario.keys()].some((id) => !candidateByScenario.has(id))) {
    throw new Error('Scenario comparison queues do not contain the same scenario IDs')
  }
  const rows: ScenarioComparisonRow[] = []
  let contentCharacters = JSON.stringify(policyPayload(input.baselineVersion)).length +
    JSON.stringify(policyPayload(input.candidateVersion)).length
  for (const scenarioId of [...baselineByScenario.keys()].sort()) {
    const baseline = baselineByScenario.get(scenarioId)!
    const candidate = candidateByScenario.get(scenarioId)!
    if (!validText(baseline.definition.scenarioRevision, 200_000) ||
      !validText(candidate.definition.scenarioRevision, 200_000)) {
      throw new Error(`Scenario ${scenarioId} revision exceeds comparison bounds`)
    }
    contentCharacters += baseline.definition.scenarioRevision.length +
      baseline.result!.response.length + baseline.result!.rationale.length + baseline.result!.uncertainty.length +
      candidate.result!.response.length + candidate.result!.rationale.length + candidate.result!.uncertainty.length
    if (contentCharacters > SCENARIO_COMPARISON_MAX_CONTENT_CHARS) {
      throw new Error('Scenario comparison content exceeds the size limit')
    }
    if (baseline.definition.scenarioRevision !== candidate.definition.scenarioRevision) {
      throw new Error(`Scenario ${scenarioId} changed between comparison queues`)
    }
    rows.push({
      scenarioId,
      scenarioRevision: baseline.definition.scenarioRevision,
      scenarioRevisionSha256: await sha256(baseline.definition.scenarioRevision),
      outcomeChanged: baseline.result!.outcome !== candidate.result!.outcome,
      baseline: structuredClone(baseline.result!),
      candidate: structuredClone(candidate.result!),
    })
  }
  const baseline = sourceFromJob(baselineJob, input.baselineVersion)
  const candidate = sourceFromJob(candidateJob, input.candidateVersion)
  const payload: ScenarioComparisonPayload = {
    format: SCENARIO_COMPARISON_FORMAT,
    schemaVersion: SCENARIO_COMPARISON_SCHEMA_VERSION,
    projectId: baselineJob.definition.projectId,
    documentId: baselineJob.definition.documentId,
    latestSourceTimestamp: Math.max(
      baseline.createdAt, candidate.createdAt, baseline.policyVersion.createdAt, candidate.policyVersion.createdAt,
      ...rows.flatMap((row) => [row.baseline.timestamp, row.candidate.timestamp]),
    ),
    baseline,
    candidate,
    summary: summarize(rows),
    rows,
  }
  const artifact: ScenarioComparisonArtifact = { ...payload, artifactSha256: await sha256(canonicalPayload(payload)) }
  const encoded = JSON.stringify(artifact)
  if (encoder.encode(encoded).byteLength > SCENARIO_COMPARISON_MAX_FILE_BYTES) {
    throw new Error('Scenario comparison export exceeds the size limit')
  }
  return decodeScenarioComparison(encoded)
}

async function assertSource(value: unknown, projectId: string): Promise<ScenarioComparisonSource> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'jobId', 'policyVersion', 'providerId', 'requestedModelId', 'executedModelIds', 'promptVersion',
    'createdBy', 'createdByDisplayName', 'createdAt', 'modelHash', 'sampler', 'seed', 'nondeterminismLabel',
  ])) throw new Error('Scenario comparison source has an unsupported shape')
  const source = value as ScenarioComparisonSource
  if (!stableId(source.jobId) || !providers.has(source.providerId) || !routeId(source.requestedModelId) ||
    !Array.isArray(source.executedModelIds) || source.executedModelIds.length === 0 ||
    !source.executedModelIds.every(routeId) || new Set(source.executedModelIds).size !== source.executedModelIds.length ||
    JSON.stringify([...source.executedModelIds].sort()) !== JSON.stringify(source.executedModelIds) ||
    !validText(source.promptVersion, 200) || !stableId(source.createdBy) ||
    !validText(source.createdByDisplayName, 200) || !validTimestamp(source.createdAt) ||
    source.modelHash !== null || source.sampler !== null || source.seed !== null ||
    source.nondeterminismLabel !== SCENARIO_COMPARISON_NONDETERMINISM_LABEL) {
    throw new Error('Scenario comparison source is invalid')
  }
  return { ...structuredClone(source), policyVersion: await assertPolicyVersion(source.policyVersion, projectId) }
}

export async function decodeScenarioComparison(text: string): Promise<ScenarioComparisonArtifact> {
  if (typeof text !== 'string' || text.length === 0 || encoder.encode(text).byteLength > SCENARIO_COMPARISON_MAX_FILE_BYTES) {
    throw new Error('Scenario comparison export is empty or exceeds the size limit')
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Scenario comparison export is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !exactKeys(parsed, [
    'format', 'schemaVersion', 'projectId', 'documentId', 'latestSourceTimestamp', 'baseline',
    'candidate', 'summary', 'rows', 'artifactSha256',
  ])) throw new Error('Scenario comparison envelope has an unsupported shape')
  const envelope = parsed as ScenarioComparisonArtifact
  if (envelope.format !== SCENARIO_COMPARISON_FORMAT || envelope.schemaVersion !== SCENARIO_COMPARISON_SCHEMA_VERSION ||
    !stableId(envelope.projectId) || !stableId(envelope.documentId) || !validTimestamp(envelope.latestSourceTimestamp) ||
    !sha256Pattern.test(envelope.artifactSha256)) throw new Error('Scenario comparison envelope is invalid')
  const baseline = await assertSource(envelope.baseline, envelope.projectId)
  const candidate = await assertSource(envelope.candidate, envelope.projectId)
  if (baseline.jobId === candidate.jobId || baseline.promptVersion !== candidate.promptVersion) {
    throw new Error('Scenario comparison sources are not distinct and compatible')
  }
  if (!Array.isArray(envelope.rows) || envelope.rows.length === 0 || envelope.rows.length > 200) {
    throw new Error('Scenario comparison rows are invalid')
  }
  const rows: ScenarioComparisonRow[] = []
  const seen = new Set<string>()
  for (const raw of envelope.rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exactKeys(raw, [
      'scenarioId', 'scenarioRevision', 'scenarioRevisionSha256', 'outcomeChanged', 'baseline', 'candidate',
    ]) || !stableId(raw.scenarioId) || !validText(raw.scenarioRevision, 200_000) ||
      !sha256Pattern.test(raw.scenarioRevisionSha256) || typeof raw.outcomeChanged !== 'boolean' ||
      seen.has(raw.scenarioId) || await sha256(raw.scenarioRevision) !== raw.scenarioRevisionSha256) {
      throw new Error('Scenario comparison row is invalid')
    }
    seen.add(raw.scenarioId)
    const rowContext = {
      scenarioId: raw.scenarioId, scenarioRevision: raw.scenarioRevision,
      projectId: envelope.projectId, documentId: envelope.documentId,
    }
    const baselineResult = assertResult(raw.baseline, baseline, rowContext)
    const candidateResult = assertResult(raw.candidate, candidate, rowContext)
    if (raw.outcomeChanged !== (baselineResult.outcome !== candidateResult.outcome)) {
      throw new Error('Scenario comparison outcome-change marker is invalid')
    }
    rows.push({ scenarioId: raw.scenarioId, scenarioRevision: raw.scenarioRevision,
      scenarioRevisionSha256: raw.scenarioRevisionSha256, outcomeChanged: raw.outcomeChanged,
      baseline: baselineResult, candidate: candidateResult })
  }
  if (JSON.stringify(rows.map(({ scenarioId }) => scenarioId).sort()) !== JSON.stringify(rows.map(({ scenarioId }) => scenarioId))) {
    throw new Error('Scenario comparison rows are not canonically ordered')
  }
  const executed = (side: 'baseline' | 'candidate') => Array.from(new Set(rows.map((row) => row[side].executedModelId))).sort()
  if (JSON.stringify(baseline.executedModelIds) !== JSON.stringify(executed('baseline')) ||
    JSON.stringify(candidate.executedModelIds) !== JSON.stringify(executed('candidate'))) {
    throw new Error('Scenario comparison executed-model provenance does not match')
  }
  const summary = summarize(rows)
  if (!envelope.summary || typeof envelope.summary !== 'object' || Array.isArray(envelope.summary) ||
    !exactKeys(envelope.summary, ['scenarioCount', 'unchangedOutcomeCount', 'changedOutcomeCount', 'outcomeMatrix']) ||
    JSON.stringify(envelope.summary) !== JSON.stringify(summary)) {
    throw new Error('Scenario comparison summary does not match its rows')
  }
  const latestSourceTimestamp = Math.max(
    baseline.createdAt, candidate.createdAt, baseline.policyVersion.createdAt, candidate.policyVersion.createdAt,
    ...rows.flatMap((row) => [row.baseline.timestamp, row.candidate.timestamp]),
  )
  if (envelope.latestSourceTimestamp !== latestSourceTimestamp) {
    throw new Error('Scenario comparison source timestamp does not match')
  }
  const payload: ScenarioComparisonPayload = {
    format: SCENARIO_COMPARISON_FORMAT, schemaVersion: SCENARIO_COMPARISON_SCHEMA_VERSION,
    projectId: envelope.projectId, documentId: envelope.documentId, latestSourceTimestamp,
    baseline, candidate, summary, rows,
  }
  if (await sha256(canonicalPayload(payload)) !== envelope.artifactSha256) {
    throw new Error('Scenario comparison artifact checksum does not match')
  }
  return { ...payload, artifactSha256: envelope.artifactSha256 }
}

export async function exportScenarioComparison(artifact: ScenarioComparisonArtifact): Promise<string> {
  const verified = await decodeScenarioComparison(JSON.stringify(artifact))
  return JSON.stringify(verified, null, 2)
}

export function countComparableScenarioRerunPairs(jobs: ScenarioRerunJob[]): number {
  const complete = jobs.filter((job) => job.status === 'complete')
  let count = 0
  for (let left = 0; left < complete.length; left += 1) {
    for (let right = left + 1; right < complete.length; right += 1) {
      const a = complete[left]
      const b = complete[right]
      const aItems = [...a.items].sort((x, y) => x.definition.scenarioId.localeCompare(y.definition.scenarioId))
      const bItems = [...b.items].sort((x, y) => x.definition.scenarioId.localeCompare(y.definition.scenarioId))
      if (a.definition.projectId === b.definition.projectId && a.definition.documentId === b.definition.documentId &&
        a.definition.promptVersion === b.definition.promptVersion && aItems.length === bItems.length &&
        aItems.every((item, index) => item.status === 'complete' && bItems[index]?.status === 'complete' &&
          item.definition.scenarioId === bItems[index].definition.scenarioId &&
          item.definition.scenarioRevision === bItems[index].definition.scenarioRevision)) count += 1
    }
  }
  return count
}
