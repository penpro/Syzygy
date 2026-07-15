import { describe, expect, it } from 'vitest'
import { createAdversarialRunPlan, type AdversarialRunInput } from './adversarialProtocol'

const input: AdversarialRunInput = {
  question: 'Which policy option is best supported by the supplied evidence?',
  participants: [
    { slotId: 'local-a', providerId: 'local', modelId: 'model-a' },
    { slotId: 'remote-b', providerId: 'anthropic', modelId: 'model-b' },
    { slotId: 'remote-c', providerId: 'openai', modelId: 'model-c' },
  ],
  judge: { slotId: 'judge', providerId: 'gemini', modelId: 'judge-model' },
  baseline: { slotId: 'baseline', providerId: 'local', modelId: 'model-a' },
  seed: 'fixture-001',
}

describe('adversarial research protocol', () => {
  it('is deterministic, blinded, order-swapped, and compute-matched', () => {
    const first = createAdversarialRunPlan(input)
    const second = createAdversarialRunPlan(input)
    expect(first).toEqual(second)
    expect(first.heterogeneous).toBe(true)
    expect(first.blindedCandidates.map(({ candidateId }) => candidateId)).toEqual([
      'candidate-1',
      'candidate-2',
      'candidate-3',
    ])
    expect(first.judgeOrders[1]).toEqual([...first.judgeOrders[0]].reverse())
    expect(first.computeMatchedBaselineCallBudget).toBe(first.adversarialCallBudget)
    expect(first.phases[first.phases.length - 1]).toBe('human-acceptance')
  })

  it('rejects a debate theater configuration with only one participant', () => {
    expect(() => createAdversarialRunPlan({ ...input, participants: input.participants.slice(0, 1) })).toThrow(
      'at least two participants are required',
    )
  })
})
