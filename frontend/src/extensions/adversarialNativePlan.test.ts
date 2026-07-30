import { describe, expect, it } from 'vitest'
import type { AdversarialRunnerRequest } from './adversarialRunner'
import {
  buildNativeAdversarialScope,
  validateNativeAdversarialScope,
  type NativeAdversarialAuthorizationScope,
} from './adversarialNativePlan'

const request = (): AdversarialRunnerRequest => ({
  runId: 'run-content-bound-001',
  input: {
    question: 'Which conclusion survives adversarial review?',
    participants: [
      { slotId: 'candidate-a', providerId: 'openai', modelId: 'proposal-a' },
      { slotId: 'candidate-b', providerId: 'anthropic', modelId: 'proposal-b' },
    ],
    judge: { slotId: 'judge', providerId: 'gemini', modelId: 'judge-model' },
    baseline: { slotId: 'baseline', providerId: 'xai', modelId: 'baseline-model' },
    seed: 'deterministic-seed',
  },
  sources: [{ snapshotId: 'source-001', label: 'Evidence', excerpt: 'Bounded source text.' }],
})

function clone(scope: NativeAdversarialAuthorizationScope): NativeAdversarialAuthorizationScope {
  return structuredClone(scope)
}

describe('native adversarial authorization plan', () => {
  it('freezes every adversarial and compute-matched baseline call before approval', () => {
    const scope = buildNativeAdversarialScope(request())

    expect(scope.totalRemoteCalls).toBe(14)
    expect(scope.calls).toHaveLength(14)
    expect(scope.routes).toEqual([
      { provider: 'anthropic', model: 'proposal-b', maxCalls: 2 },
      { provider: 'gemini', model: 'judge-model', maxCalls: 3 },
      { provider: 'openai', model: 'proposal-a', maxCalls: 2 },
      { provider: 'xai', model: 'baseline-model', maxCalls: 7 },
    ])
    expect(validateNativeAdversarialScope(scope)).toEqual([])

    const judgments = scope.calls.filter(({ phase }) => phase === 'judgment')
    expect(judgments).toHaveLength(2)
    expect(judgments[0].presentationOrder).toEqual([...judgments[1].presentationOrder].reverse())
    expect(judgments.map(({ finalPass }) => finalPass)).toEqual([false, true])
    expect(scope.calls.filter(({ phase }) => phase === 'baseline')).toHaveLength(7)
  })

  it('binds critiques and later phases only to prior planned call identities', () => {
    const scope = buildNativeAdversarialScope(request())
    const calls = new Map(scope.calls.map((call) => [call.callId, call]))

    for (const critique of scope.calls.filter(({ phase }) => phase === 'critique')) {
      expect(critique.upstreamCallIds).toHaveLength(1)
      expect(calls.get(critique.upstreamCallIds[0])?.phase).toBe('proposal')
    }
    const audit = scope.calls.find(({ phase }) => phase === 'evidence-audit')!
    expect(audit.upstreamCallIds.every((id) => calls.get(id)?.phase === 'proposal')).toBe(true)
    for (const judgment of scope.calls.filter(({ phase }) => phase === 'judgment')) {
      expect(judgment.upstreamCallIds.some((id) => calls.get(id)?.phase === 'evidence-audit')).toBe(true)
      expect(judgment.upstreamCallIds.filter((id) => calls.get(id)?.phase === 'critique')).toHaveLength(2)
    }
  })

  it('rejects substituted routes, budgets, dependencies, order, and run namespaces', () => {
    const original = buildNativeAdversarialScope(request())
    const badBudget = clone(original)
    badBudget.routes[0].maxCalls += 1
    expect(validateNativeAdversarialScope(badBudget)).toContain(
      'route anthropic\u0000proposal-b budget does not match the call graph',
    )

    const forwardDependency = clone(original)
    forwardDependency.calls[0].upstreamCallIds = [forwardDependency.calls[forwardDependency.calls.length - 1].callId]
    expect(validateNativeAdversarialScope(forwardDependency)).toContain(
      `call ${forwardDependency.calls[0].callId} has an unknown or forward dependency`,
    )

    const badOrder = clone(original)
    const judgment = badOrder.calls.find(({ phase }) => phase === 'judgment')!
    judgment.presentationOrder = [judgment.presentationOrder[0], judgment.presentationOrder[0]]
    expect(validateNativeAdversarialScope(badOrder)).toContain(
      `judgment ${judgment.callId} presentation order must be an exact proposal permutation`,
    )

    const wrongRun = clone(original)
    wrongRun.calls[0].callId = 'other-run:proposal:candidate-1'
    expect(validateNativeAdversarialScope(wrongRun)).toContain(
      'call other-run:proposal:candidate-1 is outside the run namespace',
    )
  })

  it('rejects provider routes that cannot use the built-in native vault boundary', () => {
    const invalid = request()
    invalid.input.participants[0].providerId = 'custom-provider'
    expect(() => buildNativeAdversarialScope(invalid)).toThrow('unsupported remote provider')
  })
})
