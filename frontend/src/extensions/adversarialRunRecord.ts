import type { AdversarialRunPlan } from './adversarialProtocol'

export const ADVERSARIAL_RUN_RECORD_VERSION = 1 as const

export interface AdversarialCandidateClaim {
  claimId: string
  text: string
}

export interface AdversarialCandidateOutput {
  candidateId: string
  proposal: string
  claims: AdversarialCandidateClaim[]
}

export interface AdversarialRunRecord {
  recordVersion: typeof ADVERSARIAL_RUN_RECORD_VERSION
  runId: string
  protocolVersion: 1
  sourceSnapshotIds: string[]
  candidates: AdversarialCandidateOutput[]
  critiques: Array<{ criticCandidateId: string; targetCandidateId: string; summary: string }>
  evidenceAudit: Array<{
    candidateId: string
    claimId: string
    verdict: 'supported' | 'unsupported' | 'conflicted'
    sourceIds: string[]
  }>
  judgments: Array<{ order: string[]; ranking: string[] }>
  minorityFindings: Array<{
    findingId: string
    candidateIds: string[]
    evidenceStatus: 'supported' | 'unsupported' | 'conflicted'
    disposition: 'retained' | 'rejected'
    rationale: string
  }>
  synthesis: { text: string; retainedFindingIds: string[] }
  accounting: {
    adversarialCalls: number
    baselineCalls: number
    inputTokens: number
    outputTokens: number
    costUsd: number | null
  }
  humanDecision: {
    status: 'pending' | 'accepted' | 'rejected'
    reviewerId: string | null
    notes: string
  }
  sharedMutation: {
    applied: boolean
    proposalId: string | null
    expectedRevision: string | null
    appliedRevision: string | null
  }
}

export interface AdversarialRunMetrics {
  sourceSupportRate: number
  positionStable: boolean
  minorityRetentionRate: number
  callBudgetMatched: boolean
  sharedMutationAuthorized: boolean
}

const unique = (values: string[]) => new Set(values).size === values.length
const sameMembers = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value) => right.includes(value)) && unique(left) && unique(right)
const unsafeReasoningKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(unsafeReasoningKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(
    ([key, nested]) => /^(?:chainOfThought|hiddenReasoning|reasoningTrace)$/i.test(key) || unsafeReasoningKey(nested),
  )
}

export function validateAdversarialRunRecord(plan: AdversarialRunPlan, record: AdversarialRunRecord): string[] {
  const errors: string[] = []
  const candidateIds = plan.blindedCandidates.map(({ candidateId }) => candidateId)
  if (record.recordVersion !== ADVERSARIAL_RUN_RECORD_VERSION) errors.push('unsupported recordVersion')
  if (record.protocolVersion !== plan.protocolVersion) errors.push('record protocolVersion does not match plan')
  if (!record.runId.trim()) errors.push('runId is required')
  if (!unique(record.sourceSnapshotIds) || record.sourceSnapshotIds.some((id) => !id.trim())) {
    errors.push('sourceSnapshotIds must be unique and non-empty')
  }
  if (!sameMembers(record.candidates.map(({ candidateId }) => candidateId), candidateIds)) {
    errors.push('candidate outputs must cover every blinded candidate exactly once')
  }
  for (const candidate of record.candidates) {
    const untrusted = candidate as unknown as Record<string, unknown>
    if ('providerId' in untrusted || 'modelId' in untrusted || 'slotId' in untrusted) {
      errors.push(`candidate ${candidate.candidateId} leaks participant identity`)
    }
    if (!candidate.proposal.trim() || !unique(candidate.claims.map(({ claimId }) => claimId))) {
      errors.push(`candidate ${candidate.candidateId} requires a proposal and unique claim IDs`)
    }
  }

  const critics = record.critiques.map(({ criticCandidateId }) => criticCandidateId)
  if (!sameMembers(critics, candidateIds)) errors.push('each blinded candidate must contribute exactly one critique')
  for (const critique of record.critiques) {
    if (
      critique.criticCandidateId === critique.targetCandidateId ||
      !candidateIds.includes(critique.targetCandidateId) ||
      !critique.summary.trim()
    ) {
      errors.push('critiques require a different valid target and non-empty summary')
      break
    }
  }

  const auditKeys = new Set(record.evidenceAudit.map(({ candidateId, claimId }) => `${candidateId}\0${claimId}`))
  if (auditKeys.size !== record.evidenceAudit.length) errors.push('evidence audit entries must be unique per claim')
  for (const candidate of record.candidates) {
    for (const claim of candidate.claims) {
      const key = `${candidate.candidateId}\0${claim.claimId}`
      if (!auditKeys.has(key)) errors.push(`claim ${candidate.candidateId}/${claim.claimId} lacks an evidence audit`)
    }
  }
  for (const audit of record.evidenceAudit) {
    const candidate = record.candidates.find(({ candidateId }) => candidateId === audit.candidateId)
    if (!candidate?.claims.some(({ claimId }) => claimId === audit.claimId)) {
      errors.push(`evidence audit targets unknown claim ${audit.candidateId}/${audit.claimId}`)
    }
    if (!unique(audit.sourceIds) || audit.sourceIds.some((id) => !record.sourceSnapshotIds.includes(id))) {
      errors.push(`evidence audit ${audit.candidateId}/${audit.claimId} uses an unknown or duplicate source`)
    }
    if (audit.verdict === 'supported' && audit.sourceIds.length === 0) {
      errors.push(`supported claim ${audit.candidateId}/${audit.claimId} requires a source`)
    }
  }

  if (record.judgments.length !== 2) {
    errors.push('exactly two order-swapped judgments are required')
  } else {
    record.judgments.forEach((judgment, index) => {
      if (judgment.order.join('\0') !== plan.judgeOrders[index].join('\0')) {
        errors.push(`judgment ${index + 1} does not use the planned blinded order`)
      }
      if (!sameMembers(judgment.ranking, candidateIds)) {
        errors.push(`judgment ${index + 1} ranking must contain every blinded candidate exactly once`)
      }
      const untrusted = judgment as unknown as Record<string, unknown>
      if ('providerId' in untrusted || 'modelId' in untrusted || 'slotId' in untrusted) {
        errors.push(`judgment ${index + 1} leaks participant identity`)
      }
    })
  }

  const findingIds = record.minorityFindings.map(({ findingId }) => findingId)
  if (!unique(findingIds)) errors.push('minority finding IDs must be unique')
  for (const finding of record.minorityFindings) {
    if (
      !finding.findingId.trim() ||
      !finding.rationale.trim() ||
      !unique(finding.candidateIds) ||
      finding.candidateIds.some((id) => !candidateIds.includes(id))
    ) {
      errors.push('minority findings require stable identity, rationale, and known candidates')
    }
    if (finding.evidenceStatus === 'supported' && finding.disposition !== 'retained') {
      errors.push(`supported minority finding ${finding.findingId} must be retained`)
    }
    if (finding.disposition === 'retained' && !record.synthesis.retainedFindingIds.includes(finding.findingId)) {
      errors.push(`retained minority finding ${finding.findingId} is absent from synthesis metadata`)
    }
  }
  if (!record.synthesis.text.trim() || !unique(record.synthesis.retainedFindingIds)) {
    errors.push('synthesis text and unique retained finding IDs are required')
  }
  for (const findingId of record.synthesis.retainedFindingIds) {
    if (!record.minorityFindings.some((finding) => finding.findingId === findingId && finding.disposition === 'retained')) {
      errors.push(`synthesis retains unknown or rejected finding ${findingId}`)
    }
  }

  if (
    record.accounting.adversarialCalls !== plan.adversarialCallBudget ||
    record.accounting.baselineCalls !== plan.computeMatchedBaselineCallBudget ||
    record.accounting.adversarialCalls !== record.accounting.baselineCalls
  ) {
    errors.push('actual adversarial and baseline calls must match the planned equal compute budget')
  }
  if (
    !Number.isSafeInteger(record.accounting.inputTokens) ||
    !Number.isSafeInteger(record.accounting.outputTokens) ||
    record.accounting.inputTokens < 0 ||
    record.accounting.outputTokens < 0 ||
    (record.accounting.costUsd !== null && (!Number.isFinite(record.accounting.costUsd) || record.accounting.costUsd < 0))
  ) {
    errors.push('token accounting must be non-negative integers and cost must be finite and non-negative')
  }

  const positionStable =
    record.judgments.length === 2 && record.judgments[0].ranking.join('\0') === record.judgments[1].ranking.join('\0')
  if (!positionStable && record.humanDecision.status === 'accepted' && !record.humanDecision.notes.trim()) {
    errors.push('accepting an order-unstable judgment requires explicit human notes')
  }
  if (record.humanDecision.status !== 'pending' && !record.humanDecision.reviewerId?.trim()) {
    errors.push('completed human decisions require reviewerId')
  }
  if (record.sharedMutation.applied) {
    if (
      record.humanDecision.status !== 'accepted' ||
      !record.sharedMutation.proposalId?.trim() ||
      !record.sharedMutation.expectedRevision?.trim() ||
      !record.sharedMutation.appliedRevision?.trim()
    ) {
      errors.push('shared mutation requires accepted human review, proposal identity, and revision guards')
    }
  }
  if (unsafeReasoningKey(record)) errors.push('hidden chain-of-thought fields are prohibited')
  return errors
}

export function adversarialRunMetrics(plan: AdversarialRunPlan, record: AdversarialRunRecord): AdversarialRunMetrics {
  const supported = record.evidenceAudit.filter(({ verdict }) => verdict === 'supported').length
  const retained = record.minorityFindings.filter(({ disposition }) => disposition === 'retained').length
  return {
    sourceSupportRate: record.evidenceAudit.length === 0 ? 0 : supported / record.evidenceAudit.length,
    positionStable:
      record.judgments.length === 2 && record.judgments[0].ranking.join('\0') === record.judgments[1].ranking.join('\0'),
    minorityRetentionRate: record.minorityFindings.length === 0 ? 1 : retained / record.minorityFindings.length,
    callBudgetMatched:
      record.accounting.adversarialCalls === plan.adversarialCallBudget &&
      record.accounting.baselineCalls === plan.computeMatchedBaselineCallBudget &&
      record.accounting.adversarialCalls === record.accounting.baselineCalls,
    sharedMutationAuthorized: !record.sharedMutation.applied || record.humanDecision.status === 'accepted',
  }
}
