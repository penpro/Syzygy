import { describe, expect, it, vi } from 'vitest'
import type { ProviderAdversarialCallRequest, ProviderTaskOutcome, RemoteProviderId } from '../tauri'
import {
  createNativeAdversarialExecutor,
  NativeAdversarialExecutorError,
  parseNativeAdversarialResult,
} from './adversarialNativeExecutor'
import { buildNativeAdversarialScope } from './adversarialNativePlan'
import { runAdversarialPanel, type AdversarialExecutorCall, type AdversarialRunnerRequest } from './adversarialRunner'
import { validateAdversarialRunRecord } from './adversarialRunRecord'

const request = (): AdversarialRunnerRequest => ({
  runId: 'native-run-001',
  input: {
    question: 'Which option is best supported?',
    participants: [
      { slotId: 'slot-a', providerId: 'openai', modelId: 'model-a' },
      { slotId: 'slot-b', providerId: 'anthropic', modelId: 'model-b' },
    ],
    judge: { slotId: 'slot-judge', providerId: 'gemini', modelId: 'judge-model' },
    baseline: { slotId: 'slot-baseline', providerId: 'xai', modelId: 'baseline-model' },
    seed: 'native-executor-seed',
  },
  sources: [
    { snapshotId: 'source-a', label: 'Source A', excerpt: 'A supports option one.' },
    { snapshotId: 'source-b', label: 'Source B', excerpt: 'B identifies a minority risk.' },
  ],
})

function outcome(provider: RemoteProviderId, text: string, usage = true): ProviderTaskOutcome {
  return {
    response: {
      provider,
      id: 'fixture-response',
      status: 'completed',
      model: 'fixture-model',
      text,
      refusals: [],
      unknownOutputTypes: [],
      toolProposals: [],
      usage: usage ? { inputTokens: 10, outputTokens: 5, totalTokens: 15 } : null,
    },
    zeroDataRetention: null,
    errorCode: null,
    runRecord: {} as ProviderTaskOutcome['runRecord'],
    toolContinuationAvailable: false,
    toolContinuationTurn: null,
  }
}

const candidateId = (proposalCallId: string) => proposalCallId.split(':proposal:')[1]

describe('native adversarial executor', () => {
  it('executes the complete content-bound graph and forwards only exact completed upstream bytes', async () => {
    const fixture = request()
    const scope = buildNativeAdversarialScope(fixture)
    const plannedById = new Map(scope.calls.map((call) => [call.callId, call]))
    const returned = new Map<string, string>()
    const requests: ProviderAdversarialCallRequest[] = []
    const execute = vi.fn(async (nativeRequest: ProviderAdversarialCallRequest) => {
      requests.push(structuredClone(nativeRequest))
      const planned = plannedById.get(nativeRequest.callId)!
      expect(nativeRequest.runId).toBe(scope.runId)
      expect(nativeRequest.question).toBe(scope.question)
      expect(nativeRequest.sources).toEqual(scope.sources)
      expect(nativeRequest.upstreamOutputs.map(({ callId }) => callId)).toEqual(planned.upstreamCallIds)
      for (const upstream of nativeRequest.upstreamOutputs) expect(upstream.output).toBe(returned.get(upstream.callId))

      let body: unknown
      if (planned.phase === 'proposal') {
        const id = candidateId(planned.callId)
        body = {
          kind: 'proposal',
          proposal: `Proposal ${id}`,
          claims: [{ claimId: `claim-${id}`, text: 'A bounded claim.' }],
        }
      } else if (planned.phase === 'critique') {
        body = { kind: 'critique', summary: 'A concise cross-critique.' }
      } else if (planned.phase === 'evidence-audit') {
        body = {
          kind: 'evidence-audit',
          entries: planned.upstreamCallIds.map((callId, index) => {
            const id = candidateId(callId)
            return {
              candidateId: id,
              claimId: `claim-${id}`,
              verdict: index === 0 ? 'supported' : 'conflicted',
              sourceIds: index === 0 ? ['source-a'] : ['source-a', 'source-b'],
            }
          }),
        }
      } else if (planned.phase === 'judgment') {
        const order = planned.presentationOrder.map(candidateId)
        body = {
          kind: 'judgment',
          ranking: [...order].sort(),
          ...(planned.finalPass
            ? {
                minorityFindings: [
                  {
                    findingId: 'minority-risk',
                    candidateIds: [order[1]],
                    evidenceStatus: 'conflicted',
                    disposition: 'retained',
                    rationale: 'The distributional risk remains material.',
                  },
                ],
                synthesis: {
                  text: 'Supported option with retained minority risk.',
                  retainedFindingIds: ['minority-risk'],
                },
              }
            : {}),
        }
      } else {
        body = { kind: 'baseline', text: `Independent baseline ${planned.callId}` }
      }
      const text = JSON.stringify(body)
      returned.set(nativeRequest.callId, text)
      return outcome(planned.provider, text)
    })
    const result = await runAdversarialPanel(
      fixture,
      createNativeAdversarialExecutor({
        authorizationId: 'a'.repeat(64),
        request: fixture,
        scope,
        execute,
        cancel: vi.fn(async () => true),
      }),
    )
    expect(execute).toHaveBeenCalledTimes(scope.totalRemoteCalls)
    expect(requests).toHaveLength(14)
    expect(validateAdversarialRunRecord(result.plan, result.record)).toEqual([])
    expect(result.record.sharedMutation.applied).toBe(false)
    expect(result.record.humanDecision.status).toBe('pending')
  })

  it('rejects arbitrary graph nodes before invoking native transport', async () => {
    const fixture = request()
    const scope = buildNativeAdversarialScope(fixture)
    const execute = vi.fn()
    const executor = createNativeAdversarialExecutor({
      authorizationId: 'b'.repeat(64),
      request: fixture,
      scope,
      execute,
    })
    const forged = {
      callId: `${fixture.runId}:proposal:invented`,
      phase: 'proposal',
      route: fixture.input.participants[0],
      payload: { question: fixture.input.question, sources: fixture.sources, candidateId: 'invented' },
    } satisfies AdversarialExecutorCall
    const error = await executor(forged).catch((reason) => reason)
    expect(error).toBeInstanceOf(NativeAdversarialExecutorError)
    expect(error.code).toBe('unauthorized-call-graph')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects malformed, extra-field, private-reasoning, and usage-free provider results', () => {
    const fixture = request()
    const call: AdversarialExecutorCall = {
      callId: `${fixture.runId}:proposal:candidate-a`,
      phase: 'proposal',
      route: fixture.input.participants[0],
      payload: { question: fixture.input.question, sources: fixture.sources, candidateId: 'candidate-a' },
    }
    expect(() => parseNativeAdversarialResult(call, outcome('openai', 'not-json'))).toThrowError(
      NativeAdversarialExecutorError,
    )
    expect(() =>
      parseNativeAdversarialResult(
        call,
        outcome('openai', JSON.stringify({ kind: 'proposal', proposal: 'x', claims: [], surprise: true })),
      ),
    ).toThrowError(NativeAdversarialExecutorError)
    expect(() =>
      parseNativeAdversarialResult(
        call,
        outcome('openai', JSON.stringify({ kind: 'proposal', proposal: 'x', claims: [], hiddenReasoning: 'no' })),
      ),
    ).toThrowError(NativeAdversarialExecutorError)
    expect(() =>
      parseNativeAdversarialResult(
        call,
        outcome('openai', JSON.stringify({ kind: 'proposal', proposal: 'x', claims: [] }), false),
      ),
    ).toThrowError(NativeAdversarialExecutorError)
  })
})
