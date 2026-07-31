import { useState, type ReactNode } from 'react'
import type { AdversarialReviewDecisionSummary } from '../extensions/adversarialHistory'
import type { NativeAdversarialPanelOutcome } from '../extensions/adversarialNativeExecutor'
import type { AdversarialRunnerRequest } from '../extensions/adversarialRunner'
import { REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'

export const ADVERSARIAL_EVIDENCE_PAGE_SIZE = 50

export type AdversarialEvidenceSectionId =
  | 'sources'
  | 'minority'
  | 'proposals'
  | 'critiques'
  | 'audit'
  | 'baseline'
  | 'provenance'
  | 'decisions'

function providerName(providerId: string): string {
  return REMOTE_REVIEW_PROVIDERS.find(({ id }) => id === providerId)?.name ?? providerId
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}…` : value
}

function LazyEvidenceSection({
  sectionId,
  summary,
  initiallyOpen,
  children,
}: {
  sectionId: AdversarialEvidenceSectionId
  summary: ReactNode
  initiallyOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details
      open={open}
      data-evidence-section={sectionId}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open ? children : null}
    </details>
  )
}

export function ProgressiveArtifactList<T>({
  items,
  keyFor,
  render,
  label,
}: {
  items: ReadonlyArray<T>
  keyFor: (item: T, index: number) => string
  render: (item: T, index: number) => ReactNode
  label: string
}) {
  const [limit, setLimit] = useState(ADVERSARIAL_EVIDENCE_PAGE_SIZE)
  const visibleCount = Math.min(limit, items.length)
  const remaining = items.length - visibleCount
  const nextCount = Math.min(ADVERSARIAL_EVIDENCE_PAGE_SIZE, remaining)
  return (
    <>
      <ol className="adversarial-artifact-list" aria-label={label}>
        {items.slice(0, visibleCount).map((item, index) => (
          <li key={keyFor(item, index)}>{render(item, index)}</li>
        ))}
      </ol>
      {remaining > 0 && (
        <button
          className="btn sm adversarial-artifact-more"
          type="button"
          onClick={() => setLimit((current) => current + ADVERSARIAL_EVIDENCE_PAGE_SIZE)}
        >
          Show next {nextCount} · {remaining} remaining
        </button>
      )}
    </>
  )
}

export function AdversarialEvidenceView({
  request,
  outcome,
  decision,
  sourceDocumentRevision,
  recordSha256,
  initialOpenSections = [],
}: {
  request: AdversarialRunnerRequest
  outcome: NativeAdversarialPanelOutcome
  decision: AdversarialReviewDecisionSummary | null
  sourceDocumentRevision: string
  recordSha256?: string
  initialOpenSections?: ReadonlyArray<AdversarialEvidenceSectionId>
}) {
  const record = outcome.record
  const initiallyOpen = new Set(initialOpenSections)
  const routes = [
    ...request.input.participants.map((entry) => ({ role: entry.slotId, ...entry })),
    { role: 'judge', ...request.input.judge },
    { role: 'compute-matched baseline', ...request.input.baseline },
  ]
  return (
    <div className="adversarial-evidence">
      <div className="adversarial-evidence-meta mono">
        Run {request.runId} · source {shortId(sourceDocumentRevision)}
        {recordSha256 ? ` · archive ${recordSha256.slice(0, 12)}` : ''}
      </div>
      <section>
        <h3>Research question</h3>
        <p className="adversarial-body">{request.input.question}</p>
      </section>
      <section>
        <h3>Synthesis pending human review</h3>
        <p className="adversarial-body">{record.synthesis.text}</p>
        <p className="adversarial-safety-note">
          This is model-produced research evidence, not truth, consensus, or an automatic policy edit.
        </p>
      </section>
      <LazyEvidenceSection
        sectionId="sources"
        summary={<>Selected evidence · {request.sources.length} block{request.sources.length === 1 ? '' : 's'}</>}
        initiallyOpen={initiallyOpen.has('sources')}
      >
        <ProgressiveArtifactList
          items={request.sources}
          label="Selected evidence blocks"
          keyFor={(source) => source.snapshotId}
          render={(source) => <>
            <strong>{source.label}</strong>
            <p className="adversarial-body">{source.excerpt}</p>
            <span className="mono">{source.snapshotId}</span>
          </>}
        />
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="minority"
        summary={<>Minority findings · {record.minorityFindings.length}</>}
        initiallyOpen={initiallyOpen.has('minority')}
      >
        {record.minorityFindings.length === 0
          ? <p className="scenario-state">No minority findings were returned.</p>
          : <ProgressiveArtifactList
              items={record.minorityFindings}
              label="Minority findings"
              keyFor={(finding) => finding.findingId}
              render={(finding) => <>
                <div className="adversarial-artifact-meta mono">
                  {finding.evidenceStatus} · {finding.disposition} · {finding.candidateIds.join(', ')}
                </div>
                <p className="adversarial-body">{finding.rationale}</p>
              </>}
            />}
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="proposals"
        summary={<>Independent proposals · {record.candidates.length}</>}
        initiallyOpen={initiallyOpen.has('proposals')}
      >
        <ProgressiveArtifactList
          items={record.candidates}
          label="Independent proposals"
          keyFor={(candidate) => candidate.candidateId}
          render={(candidate) => <>
            <strong>{candidate.candidateId}</strong>
            <p className="adversarial-body">{candidate.proposal}</p>
            {candidate.claims.length > 0 && <ProgressiveArtifactList
              items={candidate.claims}
              label={`Claims from ${candidate.candidateId}`}
              keyFor={(claim) => claim.claimId}
              render={(claim) => <><span className="mono">{claim.claimId}</span> {claim.text}</>}
            />}
          </>}
        />
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="critiques"
        summary={<>Cross-critiques · {record.critiques.length}</>}
        initiallyOpen={initiallyOpen.has('critiques')}
      >
        <ProgressiveArtifactList
          items={record.critiques}
          label="Cross-critiques"
          keyFor={(critique, index) => `${critique.criticCandidateId}-${critique.targetCandidateId}-${index}`}
          render={(critique) => <>
            <div className="adversarial-artifact-meta mono">{critique.criticCandidateId} → {critique.targetCandidateId}</div>
            <p className="adversarial-body">{critique.summary}</p>
          </>}
        />
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="audit"
        summary={<>Evidence audit · {record.evidenceAudit.length} claim{record.evidenceAudit.length === 1 ? '' : 's'}</>}
        initiallyOpen={initiallyOpen.has('audit')}
      >
        <ProgressiveArtifactList
          items={record.evidenceAudit}
          label="Claim-level evidence audit"
          keyFor={(entry) => `${entry.candidateId}-${entry.claimId}`}
          render={(entry) => <>
            <span className="mono">{entry.candidateId} · {entry.claimId} · {entry.verdict}</span>
            <div>{entry.sourceIds.length ? `Sources: ${entry.sourceIds.join(', ')}` : 'No supporting source identified'}</div>
          </>}
        />
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="baseline"
        summary={<>Compute-matched baseline · {outcome.baselineArtifacts.length} output{outcome.baselineArtifacts.length === 1 ? '' : 's'}</>}
        initiallyOpen={initiallyOpen.has('baseline')}
      >
        <ProgressiveArtifactList
          items={outcome.baselineArtifacts}
          label="Compute-matched baseline outputs"
          keyFor={(artifact) => artifact.callId}
          render={(artifact) => <>
            <span className="mono">{artifact.callId}</span>
            <p className="adversarial-body">{artifact.text}</p>
          </>}
        />
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="provenance"
        summary="Execution provenance · not shown to judges"
        initiallyOpen={initiallyOpen.has('provenance')}
      >
        <ul className="adversarial-route-summary">
          {routes.map((entry) => <li key={entry.role}>
            <strong>{entry.role}</strong>
            <span>{providerName(entry.providerId)} · {entry.modelId}</span>
          </li>)}
        </ul>
        <div className="adversarial-accounting mono">
          {record.accounting.adversarialCalls} panel calls · {record.accounting.baselineCalls} baseline calls ·{' '}
          {record.accounting.inputTokens.toLocaleString()} input tokens · {record.accounting.outputTokens.toLocaleString()} output tokens ·{' '}
          {record.accounting.costUsd === null ? 'provider cost unavailable' : `$${record.accounting.costUsd.toFixed(4)}`}
        </div>
      </LazyEvidenceSection>
      <LazyEvidenceSection
        sectionId="decisions"
        summary={<>Human decision history · {decision?.history.length ?? 0}</>}
        initiallyOpen={initiallyOpen.has('decisions')}
      >
        {!decision
          ? <p className="scenario-state">No human decision has been recorded.</p>
          : <ProgressiveArtifactList
              items={decision.history}
              label="Human decision history"
              keyFor={(event) => event.eventId}
              render={(event) => <>
                <div className="adversarial-artifact-meta mono">
                  {event.decision} · {event.displayName} · {formatTimestamp(event.timestamp)}
                </div>
                {event.notes && <p className="adversarial-body">{event.notes}</p>}
              </>}
            />}
      </LazyEvidenceSection>
    </div>
  )
}
