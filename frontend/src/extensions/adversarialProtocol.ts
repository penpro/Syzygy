export const ADVERSARIAL_PROTOCOL_VERSION = 1 as const

export interface AdversarialParticipant {
  slotId: string
  providerId: string
  modelId: string
}

export interface AdversarialRunInput {
  question: string
  participants: AdversarialParticipant[]
  judge: AdversarialParticipant
  baseline: AdversarialParticipant
  seed: string
}

export interface AdversarialRunPlan {
  protocolVersion: typeof ADVERSARIAL_PROTOCOL_VERSION
  participantCount: number
  providerCount: number
  heterogeneous: boolean
  blindedCandidates: Array<{ candidateId: string; slotId: string }>
  judgeOrders: string[][]
  phases: Array<
    | 'independent-proposals'
    | 'cross-critiques'
    | 'evidence-audit'
    | 'order-swapped-judgment'
    | 'minority-report'
    | 'human-acceptance'
  >
  adversarialCallBudget: number
  computeMatchedBaselineCallBudget: number
  gates: string[]
}

function stableScore(seed: string, slotId: string): number {
  let hash = 2166136261
  for (const char of `${seed}\u0000${slotId}`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function validateAdversarialRun(input: AdversarialRunInput): string[] {
  const errors: string[] = []
  if (!input.question.trim()) errors.push('question is required')
  if (input.participants.length < 2) errors.push('at least two participants are required')
  if (!input.seed.trim()) errors.push('seed is required for reproducible ordering')
  const identities = [input.judge, input.baseline, ...input.participants]
  for (const participant of identities) {
    if (!participant.slotId.trim() || !participant.providerId.trim() || !participant.modelId.trim()) {
      errors.push('every participant requires slotId, providerId, and modelId')
      break
    }
  }
  const slotIds = input.participants.map((participant) => participant.slotId)
  if (new Set(slotIds).size !== slotIds.length) errors.push('participant slotId values must be unique')
  return errors
}

/** Build a deterministic, inspectable plan. This schedules model calls but never performs them. */
export function createAdversarialRunPlan(input: AdversarialRunInput): AdversarialRunPlan {
  const errors = validateAdversarialRun(input)
  if (errors.length) throw new Error(errors.join('; '))

  const ordered = [...input.participants].sort(
    (left, right) => stableScore(input.seed, left.slotId) - stableScore(input.seed, right.slotId),
  )
  const blindedCandidates = ordered.map((participant, index) => ({
    candidateId: `candidate-${index + 1}`,
    slotId: participant.slotId,
  }))
  const forward = blindedCandidates.map(({ candidateId }) => candidateId)
  const providerCount = new Set(input.participants.map(({ providerId }) => providerId)).size
  // N proposals + N critiques + one evidence audit + two order-swapped judge calls.
  const callBudget = input.participants.length * 2 + 3

  return {
    protocolVersion: ADVERSARIAL_PROTOCOL_VERSION,
    participantCount: input.participants.length,
    providerCount,
    heterogeneous: providerCount > 1,
    blindedCandidates,
    judgeOrders: [forward, [...forward].reverse()],
    phases: [
      'independent-proposals',
      'cross-critiques',
      'evidence-audit',
      'order-swapped-judgment',
      'minority-report',
      'human-acceptance',
    ],
    adversarialCallBudget: callBudget,
    computeMatchedBaselineCallBudget: callBudget,
    gates: [
      'proposals are generated without seeing one another',
      'candidate and provider identities are hidden from judge prompts',
      'judge ranking is stable when candidate order is reversed',
      'claims retain source spans or are marked unsupported',
      'minority findings survive synthesis',
      'quality is compared with a compute-matched baseline',
      'shared state changes require explicit human acceptance',
    ],
  }
}
