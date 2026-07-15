import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import adversarialRunSchema from '../../../docs/schemas/syzygy-adversarial-run-v1.schema.json'
import { createAdversarialRunPlan, type AdversarialRunInput } from './adversarialProtocol'
import {
  adversarialRunMetrics,
  validateAdversarialRunRecord,
  type AdversarialRunRecord,
} from './adversarialRunRecord'

const plan = createAdversarialRunPlan({
  question: 'Which option is supported by the frozen evidence packet?',
  participants: [
    { slotId: 'local-a', providerId: 'local', modelId: 'model-a' },
    { slotId: 'remote-b', providerId: 'openai', modelId: 'model-b' },
  ],
  judge: { slotId: 'judge', providerId: 'local', modelId: 'judge-model' },
  baseline: { slotId: 'baseline', providerId: 'local', modelId: 'model-a' },
  seed: 'adversarial-record-fixture',
} satisfies AdversarialRunInput)

const [first, second] = plan.blindedCandidates.map(({ candidateId }) => candidateId)
const validatePublicSchema = new Ajv2020({ allErrors: true, strict: true }).compile(adversarialRunSchema)
const record = (): AdversarialRunRecord => ({
  recordVersion: 1,
  runId: 'run-fixture-001',
  protocolVersion: 1,
  sourceSnapshotIds: ['source-a', 'source-b'],
  candidates: [
    { candidateId: first, proposal: 'Option A is better supported.', claims: [{ claimId: 'claim-a', text: 'A has evidence.' }] },
    { candidateId: second, proposal: 'Option B exposes a distributional risk.', claims: [{ claimId: 'claim-b', text: 'B has a risk.' }] },
  ],
  critiques: [
    { criticCandidateId: first, targetCandidateId: second, summary: 'Risk magnitude is uncertain.' },
    { criticCandidateId: second, targetCandidateId: first, summary: 'Option A omits affected groups.' },
  ],
  evidenceAudit: [
    { candidateId: first, claimId: 'claim-a', verdict: 'supported', sourceIds: ['source-a'] },
    { candidateId: second, claimId: 'claim-b', verdict: 'conflicted', sourceIds: ['source-a', 'source-b'] },
  ],
  judgments: plan.judgeOrders.map((order) => ({ order, ranking: [first, second] })),
  minorityFindings: [
    {
      findingId: 'finding-risk',
      candidateIds: [second],
      evidenceStatus: 'conflicted',
      disposition: 'retained',
      rationale: 'The disagreement is material even though the magnitude is unresolved.',
    },
  ],
  synthesis: { text: 'A is better supported; B identifies a material unresolved risk.', retainedFindingIds: ['finding-risk'] },
  accounting: {
    adversarialCalls: plan.adversarialCallBudget,
    baselineCalls: plan.computeMatchedBaselineCallBudget,
    inputTokens: 1200,
    outputTokens: 400,
    costUsd: 0,
  },
  humanDecision: { status: 'accepted', reviewerId: 'reviewer-fixture', notes: 'Reviewed source conflict.' },
  sharedMutation: {
    applied: true,
    proposalId: 'proposal-fixture',
    expectedRevision: 'revision-before',
    appliedRevision: 'revision-after',
  },
})

describe('adversarial run record', () => {
  it('keeps the public Draft 2020-12 schema aligned with the typed valid fixture', () => {
    const fixture = record()
    expect(validatePublicSchema(fixture), JSON.stringify(validatePublicSchema.errors)).toBe(true)
  })

  it('public schema rejects identity leaks, hidden reasoning, unsafe accounting, and unguarded mutation', () => {
    const identityLeak = record() as AdversarialRunRecord & { hiddenReasoning?: string }
    Object.assign(identityLeak.candidates[0], { providerId: 'openai' })
    identityLeak.hiddenReasoning = 'not an allowed interchange field'
    expect(validatePublicSchema(identityLeak)).toBe(false)

    const unsafeAccounting = record()
    unsafeAccounting.accounting.inputTokens = Number.MAX_SAFE_INTEGER + 1
    expect(validatePublicSchema(unsafeAccounting)).toBe(false)

    const unguardedMutation = record()
    unguardedMutation.humanDecision = { status: 'pending', reviewerId: null, notes: '' }
    unguardedMutation.sharedMutation = {
      applied: true,
      proposalId: null,
      expectedRevision: null,
      appliedRevision: null,
    }
    expect(validatePublicSchema(unguardedMutation)).toBe(false)
  })

  it('validates a blinded, cited, compute-matched, human-accepted synthetic record', () => {
    const fixture = record()
    expect(validateAdversarialRunRecord(plan, fixture)).toEqual([])
    expect(adversarialRunMetrics(plan, fixture)).toEqual({
      sourceSupportRate: 0.5,
      positionStable: true,
      minorityRetentionRate: 1,
      callBudgetMatched: true,
      sharedMutationAuthorized: true,
    })
  })

  it('rejects candidate and judge identity leakage plus hidden reasoning fields', () => {
    const fixture = record() as AdversarialRunRecord & { hiddenReasoning?: string }
    Object.assign(fixture.candidates[0], { providerId: 'openai' })
    Object.assign(fixture.judgments[0], { modelId: 'judge-model' })
    fixture.hiddenReasoning = 'private trace'
    expect(validateAdversarialRunRecord(plan, fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('leaks participant identity'),
        expect.stringContaining('hidden chain-of-thought'),
      ]),
    )
  })

  it('rejects unequal compute, wrong judge order, and incomplete candidate coverage', () => {
    const fixture = record()
    fixture.accounting.baselineCalls -= 1
    fixture.judgments[1].order = fixture.judgments[0].order
    fixture.candidates.pop()
    expect(validateAdversarialRunRecord(plan, fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('compute budget'),
        expect.stringContaining('planned blinded order'),
        expect.stringContaining('every blinded candidate'),
      ]),
    )
  })

  it('rejects unaudited claims and silent deletion of a supported minority', () => {
    const fixture = record()
    fixture.evidenceAudit.pop()
    fixture.minorityFindings[0].evidenceStatus = 'supported'
    fixture.minorityFindings[0].disposition = 'rejected'
    fixture.synthesis.retainedFindingIds = []
    expect(validateAdversarialRunRecord(plan, fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('lacks an evidence audit'),
        expect.stringContaining('must be retained'),
      ]),
    )
  })

  it('rejects shared mutation before explicit revision-guarded human acceptance', () => {
    const fixture = record()
    fixture.humanDecision = { status: 'pending', reviewerId: null, notes: '' }
    fixture.sharedMutation.expectedRevision = null
    expect(validateAdversarialRunRecord(plan, fixture)).toContain(
      'shared mutation requires accepted human review, proposal identity, and revision guards',
    )
  })

  it('rejects duplicate audits, false retained IDs, and non-finite accounting', () => {
    const fixture = record()
    fixture.evidenceAudit.push({ ...fixture.evidenceAudit[0] })
    fixture.synthesis.retainedFindingIds.push('finding-invented')
    fixture.accounting.inputTokens = Number.NaN
    fixture.accounting.costUsd = Number.POSITIVE_INFINITY
    expect(validateAdversarialRunRecord(plan, fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('evidence audit entries must be unique'),
        expect.stringContaining('unknown or rejected finding'),
        expect.stringContaining('cost must be finite'),
      ]),
    )
  })
})
