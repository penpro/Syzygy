import {
  createAdversarialRunPlan,
  type AdversarialParticipant,
  type AdversarialRunInput,
  type AdversarialRunPlan,
} from './adversarialProtocol'
import type {
  AdversarialCandidateOutput,
  AdversarialRunRecord,
} from './adversarialRunRecord'
import { validateAdversarialRunRecord } from './adversarialRunRecord'

export interface AdversarialSourceSnapshot {
  snapshotId: string
  label: string
  excerpt: string
}

export interface AdversarialRunnerRequest {
  runId: string
  input: AdversarialRunInput
  sources: AdversarialSourceSnapshot[]
}

type ProposalCall = {
  callId: string
  phase: 'proposal'
  route: AdversarialParticipant
  payload: { question: string; sources: AdversarialSourceSnapshot[]; candidateId: string }
}
type CritiqueCall = {
  callId: string
  phase: 'critique'
  route: AdversarialParticipant
  payload: { question: string; sources: AdversarialSourceSnapshot[]; criticCandidateId: string; target: AdversarialCandidateOutput }
}
type EvidenceAuditCall = {
  callId: string
  phase: 'evidence-audit'
  route: AdversarialParticipant
  payload: { question: string; sources: AdversarialSourceSnapshot[]; candidates: AdversarialCandidateOutput[] }
}
type JudgmentCall = {
  callId: string
  phase: 'judgment'
  route: AdversarialParticipant
  payload: {
    question: string
    candidates: AdversarialCandidateOutput[]
    critiques: AdversarialRunRecord['critiques']
    evidenceAudit: AdversarialRunRecord['evidenceAudit']
    order: string[]
    finalPass: boolean
  }
}
type BaselineCall = {
  callId: string
  phase: 'baseline'
  route: AdversarialParticipant
  payload: { question: string; sources: AdversarialSourceSnapshot[]; attempt: number }
}

export type AdversarialExecutorCall = ProposalCall | CritiqueCall | EvidenceAuditCall | JudgmentCall | BaselineCall

export interface AdversarialCallUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

type ProposalResult = { kind: 'proposal'; proposal: string; claims: AdversarialCandidateOutput['claims']; usage: AdversarialCallUsage }
type CritiqueResult = { kind: 'critique'; summary: string; usage: AdversarialCallUsage }
type AuditResult = { kind: 'evidence-audit'; entries: AdversarialRunRecord['evidenceAudit']; usage: AdversarialCallUsage }
type JudgmentResult = {
  kind: 'judgment'
  ranking: string[]
  minorityFindings?: AdversarialRunRecord['minorityFindings']
  synthesis?: AdversarialRunRecord['synthesis']
  usage: AdversarialCallUsage
}
type BaselineResult = { kind: 'baseline'; text: string; usage: AdversarialCallUsage }

export type AdversarialExecutorResult = ProposalResult | CritiqueResult | AuditResult | JudgmentResult | BaselineResult
export type AdversarialExecutor = (
  call: AdversarialExecutorCall,
  signal?: AbortSignal,
) => Promise<AdversarialExecutorResult>

export interface AdversarialCallLedgerEntry {
  callId: string
  phase: AdversarialExecutorCall['phase']
  slotId: string
  providerId: string
  modelId: string
  status: 'completed' | 'failed' | 'cancelled'
  errorCode: string | null
  usage: AdversarialCallUsage | null
}

export interface AdversarialRunnerOutcome {
  plan: AdversarialRunPlan
  record: AdversarialRunRecord
  callLedger: AdversarialCallLedgerEntry[]
  baselineArtifacts: Array<{ callId: string; text: string }>
}

const safeCode = (value: unknown) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : 'executor-failed'

const validUsage = (usage: AdversarialCallUsage) =>
  Number.isSafeInteger(usage.inputTokens) &&
  usage.inputTokens >= 0 &&
  Number.isSafeInteger(usage.outputTokens) &&
  usage.outputTokens >= 0 &&
  (usage.costUsd === null || (Number.isFinite(usage.costUsd) && usage.costUsd >= 0))

const unique = (values: string[]) => new Set(values).size === values.length
const hasControlCharacters = (value: string) => /[\u0000-\u001f\u007f]/.test(value)
const validIdentifier = (value: string) =>
  Boolean(value.trim()) && value.length <= 200 && !hasControlCharacters(value)

export class AdversarialRunnerError extends Error {
  readonly code: string
  readonly callLedger: AdversarialCallLedgerEntry[]

  constructor(code: string, callLedger: AdversarialCallLedgerEntry[]) {
    super('Adversarial run failed')
    this.name = 'AdversarialRunnerError'
    this.code = code
    this.callLedger = [...callLedger].sort((left, right) => left.callId.localeCompare(right.callId))
  }
}

function validateRequest(request: AdversarialRunnerRequest) {
  if (!validIdentifier(request.runId)) throw new Error('runId is invalid')
  if (!request.input.question.trim() || request.input.question.length > 4 * 1024 * 1024) {
    throw new Error('question is invalid')
  }
  if (!request.input.seed.trim() || request.input.seed.length > 10_000) throw new Error('seed is invalid')
  if (request.input.participants.length > 200) throw new Error('participant count is invalid')
  if (
    [request.input.judge, request.input.baseline, ...request.input.participants].some(
      ({ slotId, providerId, modelId }) =>
        !validIdentifier(slotId) || !validIdentifier(providerId) || !validIdentifier(modelId),
    )
  ) {
    throw new Error('participant routing is invalid')
  }
  if (request.sources.length === 0 || request.sources.length > 200) throw new Error('bounded sources are required')
  if (!unique(request.sources.map(({ snapshotId }) => snapshotId))) throw new Error('source snapshot IDs must be unique')
  if (
    request.sources.some(
      ({ snapshotId, label, excerpt }) =>
        !validIdentifier(snapshotId) ||
        !label.trim() ||
        label.length > 500 ||
        hasControlCharacters(label) ||
        !excerpt.trim() ||
        excerpt.length > 4 * 1024 * 1024,
    )
  ) {
    throw new Error('source snapshots are invalid')
  }
}

function validateResult(call: AdversarialExecutorCall, result: AdversarialExecutorResult) {
  if (result.kind !== call.phase || !validUsage(result.usage)) throw new Error('invalid-executor-result')
  if (result.kind === 'proposal') {
    if (
      !result.proposal.trim() ||
      result.proposal.length > 4 * 1024 * 1024 ||
      result.claims.length > 10_000 ||
      !unique(result.claims.map(({ claimId }) => claimId)) ||
      result.claims.some(({ claimId, text }) => !validIdentifier(claimId) || !text.trim() || text.length > 500_000)
    ) {
      throw new Error('invalid-executor-result')
    }
  } else if (result.kind === 'critique' && (!result.summary.trim() || result.summary.length > 500_000)) {
    throw new Error('invalid-executor-result')
  } else if (result.kind === 'evidence-audit') {
    if (
      result.entries.length > 10_000 ||
      result.entries.some(
        ({ candidateId, claimId, sourceIds }) =>
          !validIdentifier(candidateId) ||
          !validIdentifier(claimId) ||
          sourceIds.length > 200 ||
          !unique(sourceIds) ||
          sourceIds.some((sourceId) => !validIdentifier(sourceId)),
      )
    ) {
      throw new Error('invalid-executor-result')
    }
  } else if (result.kind === 'baseline' && (!result.text.trim() || result.text.length > 4 * 1024 * 1024)) {
    throw new Error('invalid-executor-result')
  } else if (result.kind === 'judgment') {
    if (call.phase !== 'judgment') throw new Error('invalid-executor-result')
    if (result.ranking.length > 200 || !unique(result.ranking) || result.ranking.some((id) => !validIdentifier(id))) {
      throw new Error('invalid-executor-result')
    }
    if (
      call.payload.finalPass &&
      (!result.synthesis?.text.trim() ||
        result.synthesis.text.length > 4 * 1024 * 1024 ||
        result.synthesis.retainedFindingIds.length > 10_000 ||
        !unique(result.synthesis.retainedFindingIds) ||
        result.synthesis.retainedFindingIds.some((id) => !validIdentifier(id)) ||
        !result.minorityFindings ||
        result.minorityFindings.length > 10_000 ||
        result.minorityFindings.some(
          ({ findingId, candidateIds, rationale }) =>
            !validIdentifier(findingId) ||
            candidateIds.length > 200 ||
            !unique(candidateIds) ||
            candidateIds.some((id) => !validIdentifier(id)) ||
            !rationale.trim() ||
            rationale.length > 500_000,
        ))
    ) {
      throw new Error('invalid-executor-result')
    }
  }
}

export async function runAdversarialPanel(
  request: AdversarialRunnerRequest,
  executor: AdversarialExecutor,
  signal?: AbortSignal,
): Promise<AdversarialRunnerOutcome> {
  validateRequest(request)
  const plan = createAdversarialRunPlan(request.input)
  const ledger: AdversarialCallLedgerEntry[] = []

  const executePhase = async <T extends AdversarialExecutorCall>(calls: T[]) => {
    if (signal?.aborted) throw new AdversarialRunnerError('cancelled', ledger)
    const settled = await Promise.allSettled(
      calls.map(async (call) => {
        try {
          const result = await executor(call, signal)
          validateResult(call, result)
          ledger.push({
            callId: call.callId,
            phase: call.phase,
            slotId: call.route.slotId,
            providerId: call.route.providerId,
            modelId: call.route.modelId,
            status: 'completed',
            errorCode: null,
            usage: result.usage,
          })
          return result
        } catch (error) {
          const cancelled = signal?.aborted === true
          const code = cancelled ? 'cancelled' : safeCode((error as { code?: unknown })?.code)
          ledger.push({
            callId: call.callId,
            phase: call.phase,
            slotId: call.route.slotId,
            providerId: call.route.providerId,
            modelId: call.route.modelId,
            status: cancelled ? 'cancelled' : 'failed',
            errorCode: code,
            usage: null,
          })
          throw new AdversarialRunnerError(code, ledger)
        }
      }),
    )
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
      const reason = failure.reason as AdversarialRunnerError
      throw new AdversarialRunnerError(reason.code, ledger)
    }
    return settled.map((result) => (result as PromiseFulfilledResult<AdversarialExecutorResult>).value)
  }

  const participantBySlot = new Map(request.input.participants.map((participant) => [participant.slotId, participant]))
  const proposalCalls: ProposalCall[] = plan.blindedCandidates.map(({ candidateId, slotId }) => ({
    callId: `${request.runId}:proposal:${candidateId}`,
    phase: 'proposal',
    route: participantBySlot.get(slotId)!,
    payload: { question: request.input.question, sources: request.sources, candidateId },
  }))
  const proposalResults = (await executePhase(proposalCalls)) as ProposalResult[]
  const candidates = proposalResults.map((result, index) => ({
    candidateId: plan.blindedCandidates[index].candidateId,
    proposal: result.proposal,
    claims: result.claims,
  }))

  const critiqueCalls: CritiqueCall[] = candidates.map((candidate, index) => {
    const target = candidates[(index + 1) % candidates.length]
    return {
      callId: `${request.runId}:critique:${candidate.candidateId}`,
      phase: 'critique',
      route: participantBySlot.get(plan.blindedCandidates[index].slotId)!,
      payload: {
        question: request.input.question,
        sources: request.sources,
        criticCandidateId: candidate.candidateId,
        target,
      },
    }
  })
  const critiqueResults = (await executePhase(critiqueCalls)) as CritiqueResult[]
  const critiques = critiqueResults.map((result, index) => ({
    criticCandidateId: candidates[index].candidateId,
    targetCandidateId: critiqueCalls[index].payload.target.candidateId,
    summary: result.summary,
  }))

  const auditCall: EvidenceAuditCall = {
    callId: `${request.runId}:evidence-audit`,
    phase: 'evidence-audit',
    route: request.input.judge,
    payload: { question: request.input.question, sources: request.sources, candidates },
  }
  const [auditResult] = (await executePhase([auditCall])) as AuditResult[]

  const judgmentCalls: JudgmentCall[] = plan.judgeOrders.map((order, index) => ({
    callId: `${request.runId}:judgment:${index + 1}`,
    phase: 'judgment',
    route: request.input.judge,
    payload: {
      question: request.input.question,
      candidates: order.map((candidateId) => candidates.find((candidate) => candidate.candidateId === candidateId)!),
      critiques,
      evidenceAudit: auditResult.entries,
      order,
      finalPass: index === 1,
    },
  }))
  const judgmentResults = (await executePhase(judgmentCalls)) as JudgmentResult[]

  const baselineCalls: BaselineCall[] = Array.from({ length: plan.computeMatchedBaselineCallBudget }, (_, index) => ({
    callId: `${request.runId}:baseline:${index + 1}`,
    phase: 'baseline',
    route: request.input.baseline,
    payload: { question: request.input.question, sources: request.sources, attempt: index + 1 },
  }))
  const baselineResults = (await executePhase(baselineCalls)) as BaselineResult[]

  const usage = ledger.flatMap((entry) => (entry.usage ? [entry.usage] : []))
  const knownCosts = usage.map(({ costUsd }) => costUsd)
  const record: AdversarialRunRecord = {
    recordVersion: 1,
    runId: request.runId,
    protocolVersion: plan.protocolVersion,
    sourceSnapshotIds: request.sources.map(({ snapshotId }) => snapshotId),
    candidates,
    critiques,
    evidenceAudit: auditResult.entries,
    judgments: judgmentResults.map((result, index) => ({ order: plan.judgeOrders[index], ranking: result.ranking })),
    minorityFindings: judgmentResults[1].minorityFindings!,
    synthesis: judgmentResults[1].synthesis!,
    accounting: {
      adversarialCalls: plan.adversarialCallBudget,
      baselineCalls: plan.computeMatchedBaselineCallBudget,
      inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
      costUsd: knownCosts.every((cost) => cost !== null)
        ? (knownCosts as number[]).reduce((sum, cost) => sum + cost, 0)
        : null,
    },
    humanDecision: { status: 'pending', reviewerId: null, notes: '' },
    sharedMutation: { applied: false, proposalId: null, expectedRevision: null, appliedRevision: null },
  }
  if (validateAdversarialRunRecord(plan, record).length > 0) {
    throw new AdversarialRunnerError('invalid-run-record', ledger)
  }
  return {
    plan,
    record,
    callLedger: [...ledger].sort((left, right) => left.callId.localeCompare(right.callId)),
    baselineArtifacts: baselineResults.map((result, index) => ({ callId: baselineCalls[index].callId, text: result.text })),
  }
}
