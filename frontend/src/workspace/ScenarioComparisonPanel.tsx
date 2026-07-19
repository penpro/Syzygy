import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { saveTextFile } from '../tauri'
import {
  createScenarioComparison,
  exportScenarioComparison,
  type ScenarioComparisonArtifact,
} from './scenarioComparison'
import { readPolicyVersion } from './policyVersionModel'
import { getProjectSharedTypes } from './projectModel'
import type { ScenarioRerunJob } from './scenarioRerunQueue'
import type { ResearchProjectManifest } from './schema'

interface ScenarioComparisonPanelContentProps {
  jobs: ScenarioRerunJob[]
  baselineId: string
  candidateId: string
  artifact: ScenarioComparisonArtifact | null
  busy: boolean
  message: string
  error: string
  onBaseline: (jobId: string) => void
  onCandidate: (jobId: string) => void
  onCompare: () => void
  onExport: () => void
}

const jobLabel = (job: ScenarioRerunJob) =>
  `${job.definition.policyVersionId.slice(0, 12)}… · ${job.definition.providerId}/${job.definition.requestedModelId} · ${job.definition.jobId}`

export function ScenarioComparisonPanelContent({
  jobs, baselineId, candidateId, artifact, busy, message, error,
  onBaseline, onCandidate, onCompare, onExport,
}: ScenarioComparisonPanelContentProps) {
  const outcomes = ['handled', 'unhandled', 'uncertain'] as const
  return (
    <section className="scenario-generator" aria-label="Stable scenario baseline comparison">
      <div className="scenario-section-heading">
        <h3>Baseline comparison</h3>
        <span className="mono">{jobs.length} completed queue{jobs.length === 1 ? '' : 's'}</span>
      </div>
      <p className="scenario-generation-intro">
        Compare two completed queues only when they contain the same exact scenario revisions and prompt version.
        Outcomes are shown as changes, not scored as better or worse.
      </p>
      {jobs.length < 2 ? <p className="scenario-state">Complete two compatible rerun queues to compare them.</p> : <>
        <label>Baseline queue<select value={baselineId} disabled={busy} onChange={(event) => onBaseline(event.target.value)}>
          <option value="">Choose a completed queue</option>
          {jobs.map((job) => <option key={job.definition.jobId} value={job.definition.jobId}>{jobLabel(job)}</option>)}
        </select></label>
        <label>Candidate queue<select value={candidateId} disabled={busy} onChange={(event) => onCandidate(event.target.value)}>
          <option value="">Choose a different completed queue</option>
          {jobs.map((job) => <option key={job.definition.jobId} value={job.definition.jobId}>{jobLabel(job)}</option>)}
        </select></label>
        <div className="scenario-actions">
          <button className="btn sm" type="button" disabled={busy || !baselineId || !candidateId || baselineId === candidateId} onClick={onCompare}>
            Compare exact runs
          </button>
          <button className="btn ghost sm" type="button" disabled={busy || !artifact} onClick={onExport}>
            Export verifiable JSON
          </button>
        </div>
      </>}
      {message && !error && <div className="scenario-generation-status complete" role="status">{message}</div>}
      {error && <div className="scenario-state error" role="alert">{error}</div>}
      {artifact && <>
        <div className="scenario-turn-meta mono">
          {artifact.summary.scenarioCount} exact scenario{artifact.summary.scenarioCount === 1 ? '' : 's'} · {artifact.summary.changedOutcomeCount} outcome change{artifact.summary.changedOutcomeCount === 1 ? '' : 's'} · checksum {artifact.artifactSha256.slice(0, 16)}…
        </div>
        <table className="scenario-comparison-matrix">
          <caption>Outcome transition counts; baseline outcomes are rows and candidate outcomes are columns.</caption>
          <thead><tr><th scope="col">Baseline \ candidate</th>{outcomes.map((outcome) => <th key={outcome} scope="col">{outcome}</th>)}</tr></thead>
          <tbody>{outcomes.map((baseline) => <tr key={baseline}>
            <th scope="row">{baseline}</th>
            {outcomes.map((candidate) => <td key={candidate}>{artifact.summary.outcomeMatrix[baseline][candidate]}</td>)}
          </tr>)}</tbody>
        </table>
        <ol className="scenario-responses" aria-label="Side-by-side exact scenario comparison">
          {artifact.rows.map((row) => <li key={row.scenarioId}>
            <div className="scenario-turn-meta mono">Scenario {row.scenarioId} · revision {row.scenarioRevisionSha256.slice(0, 12)}… · {row.outcomeChanged ? 'OUTCOME CHANGED' : 'SAME OUTCOME'}</div>
            <div className="scenario-comparison-sides">
              <section aria-label={`Baseline result for ${row.scenarioId}`}>
                <h4>Baseline · {row.baseline.outcome}</h4>
                <p><strong>Response:</strong> {row.baseline.response}</p>
                <p><strong>Rationale:</strong> {row.baseline.rationale}</p>
                <p><strong>Uncertainty:</strong> {row.baseline.uncertainty}</p>
                <div className="scenario-turn-meta mono">{row.baseline.executedModelId} · run {row.baseline.runId}</div>
              </section>
              <section aria-label={`Candidate result for ${row.scenarioId}`}>
                <h4>Candidate · {row.candidate.outcome}</h4>
                <p><strong>Response:</strong> {row.candidate.response}</p>
                <p><strong>Rationale:</strong> {row.candidate.rationale}</p>
                <p><strong>Uncertainty:</strong> {row.candidate.uncertainty}</p>
                <div className="scenario-turn-meta mono">{row.candidate.executedModelId} · run {row.candidate.runId}</div>
              </section>
            </div>
          </li>)}
        </ol>
        <p className="scenario-identity-note">
          Export writes both verified policy snapshots, exact scenario revisions, all response/rationale/uncertainty bodies,
          model/run attribution, explicit missing seed/sampler/model-hash fields, and a SHA-256 checksum. Review the destination before sharing.
        </p>
      </>}
    </section>
  )
}

const safeFilename = (title: string) => {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 70)
  return `${safe || 'syzygy-project'}-scenario-comparison.syzygy-scenario-comparison.json`
}

export function ScenarioComparisonPanel({
  project, doc, jobs,
}: { project: ResearchProjectManifest; doc: Y.Doc; jobs: ScenarioRerunJob[] }) {
  const complete = useMemo(() => jobs.filter((job) => job.status === 'complete'), [jobs])
  const [baselineId, setBaselineId] = useState('')
  const [candidateId, setCandidateId] = useState('')
  const [artifact, setArtifact] = useState<ScenarioComparisonArtifact | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const fingerprint = complete.map((job) => `${job.definition.jobId}:${job.items.map(({ result }) => result?.resultId ?? '').join(',')}`).join('|')

  useEffect(() => {
    setBaselineId((current) => complete.some((job) => job.definition.jobId === current) ? current : complete[0]?.definition.jobId ?? '')
    setCandidateId((current) => complete.some((job) => job.definition.jobId === current) ? current : complete[1]?.definition.jobId ?? '')
    setArtifact(null)
    setMessage('')
    setError('')
  }, [fingerprint])

  const build = async () => {
    const baselineJob = complete.find((job) => job.definition.jobId === baselineId)
    const candidateJob = complete.find((job) => job.definition.jobId === candidateId)
    if (!baselineJob || !candidateJob) throw new Error('Choose two completed queues first.')
    const { versions } = getProjectSharedTypes(doc)
    const [baselineVersion, candidateVersion] = await Promise.all([
      readPolicyVersion(versions, baselineJob.definition.policyVersionId),
      readPolicyVersion(versions, candidateJob.definition.policyVersionId),
    ])
    if (!baselineVersion || !candidateVersion || baselineVersion.projectId !== project.id || candidateVersion.projectId !== project.id) {
      throw new Error('A comparison policy snapshot is missing, corrupt, or belongs to another project.')
    }
    return createScenarioComparison({ baselineJob, candidateJob, baselineVersion, candidateVersion })
  }

  const compare = async () => {
    setBusy(true); setMessage(''); setError(''); setArtifact(null)
    try {
      const next = await build()
      setArtifact(next)
      setMessage(`Compared ${next.summary.scenarioCount} exact scenario revisions; ${next.summary.changedOutcomeCount} outcome labels changed.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not compare these queues.')
    } finally { setBusy(false) }
  }

  const exportArtifact = async () => {
    if (!artifact) return
    setBusy(true); setMessage(''); setError('')
    try {
      const saved = await saveTextFile(safeFilename(project.title), await exportScenarioComparison(artifact), 'application/json')
      setMessage(saved ? 'Verifiable scenario comparison saved.' : 'Export cancelled.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not export the scenario comparison.')
    } finally { setBusy(false) }
  }

  return <ScenarioComparisonPanelContent
    jobs={complete} baselineId={baselineId} candidateId={candidateId} artifact={artifact}
    busy={busy} message={message} error={error}
    onBaseline={(id) => { setBaselineId(id); setArtifact(null); setMessage(''); setError('') }}
    onCandidate={(id) => { setCandidateId(id); setArtifact(null); setMessage(''); setError('') }}
    onCompare={() => void compare()} onExport={() => void exportArtifact()}
  />
}
