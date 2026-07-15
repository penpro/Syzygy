import { describe, expect, it } from 'vitest'
import { validateAdversarialRunRecord } from './adversarialRunRecord'
import {
  AdversarialRunnerError,
  runAdversarialPanel,
  type AdversarialExecutor,
  type AdversarialExecutorCall,
  type AdversarialRunnerRequest,
} from './adversarialRunner'

const request = (): AdversarialRunnerRequest => ({
  runId: 'runner-fixture-001',
  input: {
    question: 'Which option is best supported?',
    participants: [
      { slotId: 'slot-local', providerId: 'local', modelId: 'local-model' },
      { slotId: 'slot-remote', providerId: 'openai', modelId: 'remote-model' },
    ],
    judge: { slotId: 'slot-judge', providerId: 'anthropic', modelId: 'judge-model' },
    baseline: { slotId: 'slot-baseline', providerId: 'local', modelId: 'local-model' },
    seed: 'runner-seed',
  },
  sources: [
    { snapshotId: 'source-a', label: 'Source A', excerpt: 'A supports option one.' },
    { snapshotId: 'source-b', label: 'Source B', excerpt: 'B identifies a minority risk.' },
  ],
})

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0 }

function fixtureExecutor(calls: AdversarialExecutorCall[]): AdversarialExecutor {
  return async (call) => {
    calls.push(call)
    if (call.phase === 'proposal') {
      return {
        kind: 'proposal',
        proposal: `Proposal from ${call.payload.candidateId}`,
        claims: [{ claimId: `claim-${call.payload.candidateId}`, text: 'A bounded claim.' }],
        usage,
      }
    }
    if (call.phase === 'critique') return { kind: 'critique', summary: 'A concise cross-critique.', usage }
    if (call.phase === 'evidence-audit') {
      return {
        kind: 'evidence-audit',
        entries: call.payload.candidates.map((candidate, index) => ({
          candidateId: candidate.candidateId,
          claimId: candidate.claims[0].claimId,
          verdict: index === 0 ? ('supported' as const) : ('conflicted' as const),
          sourceIds: index === 0 ? ['source-a'] : ['source-a', 'source-b'],
        })),
        usage,
      }
    }
    if (call.phase === 'judgment') {
      return {
        kind: 'judgment',
        ranking: [...call.payload.order].sort(),
        ...(call.payload.finalPass
          ? {
              minorityFindings: [
                {
                  findingId: 'minority-risk',
                  candidateIds: [call.payload.order[1]],
                  evidenceStatus: 'conflicted' as const,
                  disposition: 'retained' as const,
                  rationale: 'The distributional risk remains material.',
                },
              ],
              synthesis: { text: 'Supported option with retained minority risk.', retainedFindingIds: ['minority-risk'] },
            }
          : {}),
        usage,
      }
    }
    return { kind: 'baseline', text: `Baseline attempt ${call.payload.attempt}`, usage }
  }
}

describe('adversarial panel runner', () => {
  it('executes the blinded phase graph and emits a valid pending record with matched baseline compute', async () => {
    const calls: AdversarialExecutorCall[] = []
    const outcome = await runAdversarialPanel(request(), fixtureExecutor(calls))
    expect(validateAdversarialRunRecord(outcome.plan, outcome.record)).toEqual([])
    expect(outcome.record.humanDecision.status).toBe('pending')
    expect(outcome.record.sharedMutation.applied).toBe(false)
    expect(outcome.record.accounting.adversarialCalls).toBe(7)
    expect(outcome.record.accounting.baselineCalls).toBe(7)
    expect(calls).toHaveLength(14)
    expect(outcome.baselineArtifacts).toHaveLength(7)
    expect(outcome.callLedger.every(({ status }) => status === 'completed')).toBe(true)
    const phases = calls.map(({ phase }) => phase)
    expect(phases.lastIndexOf('proposal')).toBeLessThan(phases.indexOf('critique'))
    expect(phases.lastIndexOf('critique')).toBeLessThan(phases.indexOf('evidence-audit'))
    expect(phases.lastIndexOf('evidence-audit')).toBeLessThan(phases.indexOf('judgment'))
    expect(phases.lastIndexOf('judgment')).toBeLessThan(phases.indexOf('baseline'))
  })

  it('keeps candidate/provider routing outside judge-visible and baseline payloads', async () => {
    const calls: AdversarialExecutorCall[] = []
    await runAdversarialPanel(request(), fixtureExecutor(calls))
    const judgmentPayloads = calls.filter((call) => call.phase === 'judgment').map((call) => call.payload)
    const baselinePayloads = calls.filter((call) => call.phase === 'baseline').map((call) => call.payload)
    for (const payload of [...judgmentPayloads, ...baselinePayloads]) {
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toMatch(/providerId|modelId|slotId|slot-local|slot-remote|remote-model/)
    }
    expect(calls.filter((call) => call.phase === 'proposal').every((call) => !('candidates' in call.payload))).toBe(true)
  })

  it('sanitizes executor failures and stops before later phases', async () => {
    const calls: AdversarialExecutorCall[] = []
    const failing: AdversarialExecutor = async (call) => {
      calls.push(call)
      throw new Error('provider-body-secret-canary')
    }
    const error = await runAdversarialPanel(request(), failing).catch((reason) => reason)
    expect(error).toBeInstanceOf(AdversarialRunnerError)
    expect(error.code).toBe('executor-failed')
    expect(JSON.stringify(error.callLedger)).not.toContain('provider-body-secret-canary')
    expect(calls.every((call) => call.phase === 'proposal')).toBe(true)
  })

  it('rejects duplicate source identity before invoking an executor', async () => {
    const fixture = request()
    fixture.sources.push({ ...fixture.sources[0] })
    const calls: AdversarialExecutorCall[] = []
    await expect(runAdversarialPanel(fixture, fixtureExecutor(calls))).rejects.toThrow('source snapshot IDs must be unique')
    expect(calls).toEqual([])
  })

  it('rejects oversized executor artifacts before assembling a record', async () => {
    const calls: AdversarialExecutorCall[] = []
    const oversized: AdversarialExecutor = async (call, signal) => {
      const result = await fixtureExecutor(calls)(call, signal)
      if (result.kind === 'evidence-audit') {
        return { ...result, entries: Array.from({ length: 10_001 }, () => result.entries[0]) }
      }
      return result
    }
    const error = await runAdversarialPanel(request(), oversized).catch((reason) => reason)
    expect(error).toBeInstanceOf(AdversarialRunnerError)
    expect(error.code).toBe('executor-failed')
    expect(calls.some((call) => call.phase === 'evidence-audit')).toBe(true)
    expect(calls.some((call) => call.phase === 'judgment')).toBe(false)
  })

  it('honors cancellation before starting any phase', async () => {
    const controller = new AbortController()
    controller.abort()
    const calls: AdversarialExecutorCall[] = []
    const error = await runAdversarialPanel(request(), fixtureExecutor(calls), controller.signal).catch((reason) => reason)
    expect(error).toBeInstanceOf(AdversarialRunnerError)
    expect(error.code).toBe('cancelled')
    expect(error.callLedger).toEqual([])
    expect(calls).toEqual([])
  })
})
