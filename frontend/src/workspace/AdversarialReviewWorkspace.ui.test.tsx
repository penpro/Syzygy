import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createAdversarialRunPlan } from '../extensions/adversarialProtocol'
import type { NativeAdversarialPanelOutcome } from '../extensions/adversarialNativeExecutor'
import type { AdversarialRunnerRequest } from '../extensions/adversarialRunner'
import type { AutomationEditorSnapshot } from './editorAutomationRegistry'
import {
  AdversarialEvidenceView,
  AdversarialReviewAttributionStatus,
  AdversarialReviewWorkspace,
  adversarialRemoteCallCount,
  buildProductAdversarialJobParameters,
  defaultProductAdversarialDraft,
  eligibleAdversarialSourceIndexes,
} from './AdversarialReviewWorkspace'
import type { ResearchProjectManifest } from './schema'

const project: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-adversarial-ui',
  documentId: 'document-adversarial-ui',
  title: 'Adversarial product fixture',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}

const snapshot: AutomationEditorSnapshot = {
  projectId: project.id,
  revision: 'lexical-product-fixture-7-deadbeef',
  text: '# Heading\nEvidence one\n[spotlight:scenario-1]\nEvidence two',
  blocks: [
    { kind: 'heading1', text: 'Heading' },
    { kind: 'policy', text: 'Evidence one', policyId: 'policy-1', status: 'draft' },
    { kind: 'spotlight', text: '', scenarioId: 'scenario-1' },
    { kind: 'paragraph', text: 'Evidence two' },
  ],
  scenarioIds: ['scenario-1'],
}

const request: AdversarialRunnerRequest = {
  runId: 'adversarial-product-run',
  input: {
    question: 'Which conclusion survives?',
    seed: 'product-seed',
    participants: [
      { slotId: 'perspective-1', providerId: 'openai', modelId: 'model-a' },
      { slotId: 'perspective-2', providerId: 'anthropic', modelId: 'model-b' },
    ],
    judge: { slotId: 'judge', providerId: 'gemini', modelId: 'model-j' },
    baseline: { slotId: 'baseline', providerId: 'xai', modelId: 'model-base' },
  },
  sources: [
    { snapshotId: 'block-2-fixture', label: 'Document block 2 (policy)', excerpt: 'Evidence one' },
    { snapshotId: 'block-4-fixture', label: 'Document block 4 (paragraph)', excerpt: 'Evidence two' },
  ],
}

const outcome: NativeAdversarialPanelOutcome = {
  plan: createAdversarialRunPlan(request.input),
  record: {
    recordVersion: 1,
    runId: request.runId,
    protocolVersion: 1,
    sourceSnapshotIds: request.sources.map(({ snapshotId }) => snapshotId),
    candidates: [{
      candidateId: 'candidate-1',
      proposal: 'Independent proposal.',
      claims: [{ claimId: 'claim-1', text: 'A bounded claim.' }],
    }, {
      candidateId: 'candidate-2',
      proposal: 'Different independent proposal.',
      claims: [{ claimId: 'claim-2', text: 'A competing claim.' }],
    }],
    critiques: [{
      criticCandidateId: 'candidate-1',
      targetCandidateId: 'candidate-2',
      summary: 'The competing claim lacks direct support.',
    }],
    evidenceAudit: [{
      candidateId: 'candidate-1',
      claimId: 'claim-1',
      verdict: 'supported',
      sourceIds: ['block-2-fixture'],
    }],
    judgments: [
      { order: ['candidate-1', 'candidate-2'], ranking: ['candidate-1', 'candidate-2'] },
      { order: ['candidate-2', 'candidate-1'], ranking: ['candidate-1', 'candidate-2'] },
    ],
    minorityFindings: [{
      findingId: 'finding-1',
      candidateIds: ['candidate-2'],
      evidenceStatus: 'conflicted',
      disposition: 'retained',
      rationale: 'A retained disagreement.',
    }],
    synthesis: { text: 'A bounded synthesis for human review.', retainedFindingIds: ['finding-1'] },
    accounting: {
      adversarialCalls: 7,
      baselineCalls: 7,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: null,
    },
    humanDecision: { status: 'pending', reviewerId: null, notes: '' },
    sharedMutation: { applied: false, proposalId: null, expectedRevision: null, appliedRevision: null },
  },
  callLedger: [],
  baselineArtifacts: [{ callId: 'baseline-1', text: 'Compute-matched baseline output.' }],
  authorization: { scopeSha256: 'a'.repeat(64), totalRemoteCalls: 14 },
  providerRunRecords: [],
}

describe('adversarial product workflow', () => {
  it('builds exact revision-bound job parameters from explicit non-empty block selection', () => {
    const draft = defaultProductAdversarialDraft()
    draft.seed = 'fixed-seed'
    const params = buildProductAdversarialJobParameters(
      draft,
      [3, 1],
      snapshot,
      'adversarial-product-run',
    )

    expect(eligibleAdversarialSourceIndexes(snapshot)).toEqual([0, 1, 3])
    expect(params.expectedDocumentRevision).toBe(snapshot.revision)
    expect(params.sourceBlockIndexes).toEqual([1, 3])
    expect(params.participants).toHaveLength(2)
    expect(params.seed).toBe('fixed-seed')
    expect(adversarialRemoteCallCount(params.participants.length)).toBe(14)
    expect(adversarialRemoteCallCount(8)).toBe(38)
  })

  it('rejects empty evidence, oversized panels, and invalid call-count input before native authority', () => {
    const draft = defaultProductAdversarialDraft()
    expect(() => buildProductAdversarialJobParameters(draft, [2], snapshot, 'run-empty')).toThrow('empty or no longer available')
    expect(() => buildProductAdversarialJobParameters({
      ...draft,
      participants: Array.from({ length: 9 }, (_, index) => ({
        slotId: `slot-${index}`,
        providerId: 'openai' as const,
        modelId: 'fixture-model',
      })),
    }, [1], snapshot, 'run-large')).toThrow('between 2 and 8')
    expect(() => adversarialRemoteCallCount(1)).toThrow('At least two')
  })

  it('renders the installed-product safety boundary before any model or collaboration action', () => {
    const html = renderToStaticMarkup(<AdversarialReviewWorkspace project={project} />)

    expect(html).toContain('Independent perspectives, one inspectable record')
    expect(html).toContain('Agreement is not truth')
    expect(html).toContain('Nothing is sent until one native batch approval')
    expect(html).toContain('14 remote provider calls')
    expect(html).toContain('Review batch before sending')
    expect(html).toContain('Preparing shared project research data')
    expect(html).not.toContain('Apply to draft')
  })

  it('renders pending, signed-device, and explicit unsigned adversarial attribution states', () => {
    const pending = renderToStaticMarkup(
      <AdversarialReviewAttributionStatus pending attribution={null} />,
    )
    expect(pending).toContain('record committed')
    expect(pending).toContain('Checking registered-device attribution')

    const signed = renderToStaticMarkup(<AdversarialReviewAttributionStatus
      pending={false}
      attribution={{
        recordType: 'archive',
        result: {
          status: 'signed-device',
          keyId: 'ed25519-sha256:abcdefghijklmnopqrstuv0123456789ABCDEFG',
          eventKind: 'adversarial-review',
          eventId: 'a:run-1',
          eventSha256: 'a'.repeat(43),
          attestationCount: 1,
          authority: 'installation-device-not-human-identity',
        },
      }}
    />)
    expect(signed).toContain('Exact retained archive event signed by registered device key')
    expect(signed).toContain('installation-key possession, not a person or organization')

    const unsigned = renderToStaticMarkup(<AdversarialReviewAttributionStatus
      pending={false}
      attribution={{
        recordType: 'decision',
        result: {
          status: 'unsigned',
          reason: 'attestation-history-unhealthy',
          authority: 'installation-device-not-human-identity',
        },
      }}
    />)
    expect(unsigned).toContain('Exact retained decision event committed without a device signature')
    expect(unsigned).toContain('signed attribution history needs attention')
  })

  it('renders frozen evidence, minority artifacts, baselines, provenance, and no automatic mutation claim', () => {
    const html = renderToStaticMarkup(
      <AdversarialEvidenceView
        request={request}
        outcome={outcome}
        decision={null}
        sourceDocumentRevision={snapshot.revision}
        recordSha256={'b'.repeat(64)}
        initialOpenSections={['sources', 'minority', 'proposals', 'critiques', 'audit', 'baseline', 'provenance', 'decisions']}
      />,
    )

    expect(html).toContain('Which conclusion survives?')
    expect(html).toContain('A bounded synthesis for human review.')
    expect(html).toContain('A retained disagreement.')
    expect(html).toContain('Independent proposal.')
    expect(html).toContain('Compute-matched baseline output.')
    expect(html).toContain('Execution provenance · not shown to judges')
    expect(html).toContain('not truth, consensus, or an automatic policy edit')
    expect(html).toContain('No human decision has been recorded.')
  })

  it('keeps closed evidence out of markup and pages an opened near-limit artifact list', () => {
    const candidates = Array.from({ length: 51 }, (_, index) => ({
      candidateId: `candidate-${index + 1}`,
      proposal: `proposal-canary-${index + 1}`,
      claims: index === 0
        ? Array.from({ length: 51 }, (_, claimIndex) => ({
            claimId: `claim-${claimIndex + 1}`,
            text: `claim-canary-${claimIndex + 1}`,
          }))
        : [],
    }))
    const largeOutcome = {
      ...outcome,
      record: { ...outcome.record, candidates },
    }
    const closed = renderToStaticMarkup(
      <AdversarialEvidenceView
        request={request}
        outcome={largeOutcome}
        decision={null}
        sourceDocumentRevision={snapshot.revision}
      />,
    )
    expect(closed).toContain('Independent proposals · 51')
    expect(closed).not.toContain('proposal-canary-1')
    expect(closed).not.toContain('proposal-canary-51')

    const opened = renderToStaticMarkup(
      <AdversarialEvidenceView
        request={request}
        outcome={largeOutcome}
        decision={null}
        sourceDocumentRevision={snapshot.revision}
        initialOpenSections={['proposals']}
      />,
    )
    expect(opened).toContain('proposal-canary-1')
    expect(opened).toContain('proposal-canary-50')
    expect(opened).not.toContain('proposal-canary-51')
    expect(opened).toContain('claim-canary-1')
    expect(opened).toContain('claim-canary-50')
    expect(opened).not.toContain('claim-canary-51')
    expect(opened.match(/Show next 1 · 1 remaining/g)).toHaveLength(2)
  })
})
