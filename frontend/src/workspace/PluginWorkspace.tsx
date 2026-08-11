import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'
import { getAutomationEditorController } from './editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import {
  loadZeroAuthorityPluginPackage,
  PluginExecutionError,
} from '../extensions/pluginExecution'
import {
  pluginPackageRegistry,
  PluginPackageRegistryError,
  type LoadedPluginPackageSummary,
} from '../extensions/pluginPackageRegistry'
import {
  decidePluginReviewForProject,
  runLoadedPluginForProject,
} from '../extensions/pluginWorkspaceAutomation'
import {
  inspectPluginReviews,
  listPluginReviews,
  type CollaborativePluginReview,
  type PluginReviewDecision,
} from '../extensions/pluginReviewModel'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_COMPONENT_BYTES = 8 * 1024 * 1024

export interface PluginWorkspaceContentProps {
  packages: LoadedPluginPackageSummary[]
  reviews: CollaborativePluginReview[]
  healthy: boolean
  selectedPackageId: string
  selectedContributionId: string
  selectedReviewId: string
  busy: boolean
  status: string | null
  error: string | null
  manifestName: string | null
  componentName: string | null
  currentDocumentRevision: string | null
  onManifestFile: (file: File | null) => void
  onComponentFile: (file: File | null) => void
  onLoad: () => void
  onSelectPackage: (packageId: string) => void
  onSelectContribution: (contributionId: string) => void
  onRemovePackage: (packageId: string) => void
  onRun: () => void
  onSelectReview: (reviewId: string) => void
  onDecision: (decision: PluginReviewDecision) => void
}

export function PluginWorkspaceContent({
  packages, reviews, healthy, selectedPackageId, selectedContributionId, selectedReviewId,
  busy, status, error, manifestName, componentName, currentDocumentRevision,
  onManifestFile, onComponentFile, onLoad, onSelectPackage, onSelectContribution,
  onRemovePackage, onRun, onSelectReview, onDecision,
}: PluginWorkspaceContentProps) {
  const selectedPackage = packages.find((plugin) => plugin.packageId === selectedPackageId) ?? null
  const selectedReview = reviews.find((review) => review.id === selectedReviewId) ?? reviews[reviews.length - 1] ?? null
  const stale = Boolean(selectedReview && currentDocumentRevision &&
    selectedReview.proposal.expectedRevision !== currentDocumentRevision)
  const inactiveCapabilities = selectedPackage?.requestedCapabilities.filter(
    (capability) => capability !== 'project.read' && capability !== 'project.propose',
  ) ?? []

  return (
    <section className="plugin-workspace" aria-labelledby="plugin-workspace-title">
      <div className="workspace-panel-label mono">Open research extensions</div>
      <h2 id="plugin-workspace-title">Research plugins</h2>
      <p>
        Load one manifest and its exact component into memory. Runs use the zero-import sandbox;
        returned changes enter shared review and never edit the draft automatically.
      </p>

      <details className="plugin-load-panel">
        <summary>Load a component for this app session</summary>
        <div className="plugin-file-grid">
          <label>
            Plugin manifest
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => onManifestFile(event.target.files?.[0] ?? null)}
            />
            <span className="mono">{manifestName ?? 'Choose syzygy-plugin.json'}</span>
          </label>
          <label>
            WebAssembly component
            <input
              type="file"
              accept=".component,.wasm,application/wasm"
              onChange={(event) => onComponentFile(event.target.files?.[0] ?? null)}
            />
            <span className="mono">{componentName ?? 'Choose the exact manifest component'}</span>
          </label>
        </div>
        <button type="button" disabled={busy || !manifestName || !componentName} onClick={onLoad}>
          Verify and load in memory
        </button>
        <p className="plugin-scope-note">
          Nothing is installed or enabled on restart. Package signing, upgrades, and capability-bearing
          network, Drive, model, or filesystem worlds are not available yet.
        </p>
      </details>

      {packages.length === 0 ? (
        <div className="plugin-empty" role="status">No plugin component is loaded in this app session.</div>
      ) : (
        <div className="plugin-run-panel">
          <label>
            Loaded package
            <select value={selectedPackageId} onChange={(event) => onSelectPackage(event.target.value)}>
              {packages.map((plugin) => (
                <option key={plugin.packageId} value={plugin.packageId}>{plugin.name} · {plugin.version}</option>
              ))}
            </select>
          </label>
          {selectedPackage ? (
            <>
              <div className="plugin-package-meta mono">
                <span>{selectedPackage.pluginId}</span>
                <span>{selectedPackage.componentSha256.slice(0, 16)}… · {selectedPackage.componentByteLength.toLocaleString()} bytes</span>
              </div>
              <p>{selectedPackage.description}</p>
              <label>
                Contribution
                <select value={selectedContributionId} onChange={(event) => onSelectContribution(event.target.value)}>
                  {selectedPackage.contributions.map((contribution) => (
                    <option key={contribution.id} value={contribution.id}>{contribution.title}</option>
                  ))}
                </select>
              </label>
              <div className="plugin-authority-list" aria-label="Plugin authority for this run">
                <span className="mono">Requested: {selectedPackage.requestedCapabilities.join(', ') || 'none'}</span>
                <span className="mono">Active baseline: {
                  selectedPackage.requestedCapabilities.filter((capability) =>
                    capability === 'project.read' || capability === 'project.propose').join(', ') || 'none'
                }</span>
                {inactiveCapabilities.length > 0 ? (
                  <span className="plugin-warning">Inactive in this world: {inactiveCapabilities.join(', ')}</span>
                ) : null}
              </div>
              <div className="plugin-actions">
                <button type="button" disabled={busy || !healthy || !selectedContributionId} onClick={onRun}>
                  {busy ? 'Running bounded worker…' : 'Run in no-authority sandbox'}
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => onRemovePackage(selectedPackage.packageId)}>
                  Unload
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}

      {!healthy ? (
        <div className="plugin-error" role="alert">Shared plugin review history is invalid. Runs and decisions are paused.</div>
      ) : null}
      {error ? <div className="plugin-error" role="alert">{error}</div> : null}
      {status ? <div className="plugin-status" role="status">{status}</div> : null}

      <div className="plugin-review-heading">
        <h3>Shared plugin review</h3>
        <span className="mono">{reviews.length} retained · no automatic draft mutation</span>
      </div>
      {reviews.length === 0 ? (
        <div className="plugin-empty">No component has proposed a change.</div>
      ) : (
        <>
          <select
            className="plugin-review-select"
            aria-label="Plugin proposal to review"
            value={selectedReview?.id ?? ''}
            onChange={(event) => onSelectReview(event.target.value)}
          >
            {reviews.slice(-200).map((review) => (
              <option key={review.id} value={review.id}>{review.status} · {review.proposal.summary}</option>
            ))}
          </select>
          {selectedReview ? (
            <article className="plugin-review-card" data-status={selectedReview.status}>
              <div className="plugin-review-meta mono">
                <span>{selectedReview.proposal.pluginId} · {selectedReview.proposal.pluginVersion}</span>
                <span>{selectedReview.proposal.operation} · {selectedReview.status}</span>
              </div>
              <strong>{selectedReview.proposal.summary}</strong>
              <pre>{selectedReview.proposal.content}</pre>
              <p>
                Proposed by {selectedReview.proposal.runnerDisplayName}. Component {' '}
                <span className="mono">{selectedReview.proposal.componentSha256.slice(0, 16)}…</span>
              </p>
              {stale ? (
                <div className="plugin-warning" role="alert">
                  The live draft changed after this component ran. This proposal remains reviewable but is stale.
                </div>
              ) : null}
              {selectedReview.status === 'pending' ? (
                <div className="plugin-actions">
                  <button type="button" disabled={busy || !healthy} onClick={() => onDecision('accepted')}>Record accepted</button>
                  <button type="button" className="btn ghost" disabled={busy || !healthy} onClick={() => onDecision('rejected')}>Record rejected</button>
                </div>
              ) : null}
              <p className="plugin-scope-note">
                This decision is shared project history. It does not apply, append, or replace policy text.
              </p>
            </article>
          ) : null}
        </>
      )}
    </section>
  )
}

export function PluginWorkspace({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [revision, setRevision] = useState(0)
  const [registryRevision, setRegistryRevision] = useState(0)
  const [manifestFile, setManifestFile] = useState<File | null>(null)
  const [componentFile, setComponentFile] = useState<File | null>(null)
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [selectedContributionId, setSelectedContributionId] = useState('')
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => pluginPackageRegistry.subscribe(() => setRegistryRevision((value) => value + 1)), [])
  useEffect(() => {
    let active: Y.Doc | null = null
    const update = () => setRevision((value) => value + 1)
    const unsubscribe = subscribeAutomationProjectDocument(project.id, (next) => {
      active?.off('update', update)
      active = next
      setDoc(next)
      next?.on('update', update)
      update()
    })
    return () => { active?.off('update', update); unsubscribe() }
  }, [project.id])

  const packages = useMemo(() => pluginPackageRegistry.list(), [registryRevision])
  const shared = useMemo(() => doc ? getProjectSharedTypes(doc) : null, [doc, revision])
  const reviews = useMemo(() => shared ? listPluginReviews(shared.discussions) : [], [shared])
  const healthy = useMemo(() => shared ? inspectPluginReviews(shared.discussions).healthy : true, [shared])
  const selectedPackage = packages.find((plugin) => plugin.packageId === selectedPackageId) ?? packages[0] ?? null
  const effectivePackageId = selectedPackage?.packageId ?? ''
  const contribution = selectedPackage?.contributions.find((item) => item.id === selectedContributionId) ??
    selectedPackage?.contributions[0] ?? null
  const effectiveContributionId = contribution?.id ?? ''
  const effectiveReviewId = reviews.some((review) => review.id === selectedReviewId)
    ? selectedReviewId : reviews[reviews.length - 1]?.id ?? ''
  let currentDocumentRevision: string | null = null
  try { currentDocumentRevision = getAutomationEditorController(project.id).read().revision } catch { /* loading */ }

  const identity = () => {
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before running or reviewing a plugin')
    return { participantId: researcherId, displayName: researcherName.trim() }
  }
  const explain = (value: unknown) => {
    if (value instanceof PluginExecutionError || value instanceof PluginPackageRegistryError) return `${value.message} (${value.code})`
    return value instanceof Error ? value.message : String(value)
  }
  const load = async () => {
    setError(null); setStatus(null)
    if (!manifestFile || !componentFile) return
    if (manifestFile.name !== 'syzygy-plugin.json' || manifestFile.size < 1 || manifestFile.size > MAX_MANIFEST_BYTES ||
      componentFile.size < 1 || componentFile.size > MAX_COMPONENT_BYTES) {
      setError('Choose syzygy-plugin.json (up to 1 MiB) and its exact component (up to 8 MiB).')
      return
    }
    setBusy(true)
    try {
      const manifest = JSON.parse(await manifestFile.text()) as unknown
      const plugin = await loadZeroAuthorityPluginPackage(manifest, {
        name: componentFile.name,
        bytes: new Uint8Array(await componentFile.arrayBuffer()),
      })
      const summary = pluginPackageRegistry.register(plugin)
      setSelectedPackageId(summary.packageId)
      setSelectedContributionId(summary.contributions[0]?.id ?? '')
      setStatus(`${summary.name} ${summary.version} is loaded in memory for this app session.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const run = async () => {
    setError(null); setStatus(null)
    if (!doc || !currentDocumentRevision || !effectivePackageId || !effectiveContributionId) {
      setError('The live project, package, and contribution must be ready before running.')
      return
    }
    setBusy(true)
    try {
      const result = await runLoadedPluginForProject(doc, project.id, {
        packageId: effectivePackageId,
        contributionId: effectiveContributionId,
        expectedDocumentRevision: currentDocumentRevision,
        ...identity(),
      })
      if (result.outcome.status === 'no-change') setStatus(`Plugin completed with no proposal: ${result.outcome.reason}`)
      else {
        setSelectedReviewId(result.reviews[result.reviews.length - 1]?.id ?? '')
        setStatus(`${result.reviews.length} proposal${result.reviews.length === 1 ? '' : 's'} added to shared review. The draft was not changed.`)
      }
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const decide = (decision: PluginReviewDecision) => {
    setError(null); setStatus(null)
    if (!doc) return
    const review = reviews.find((candidate) => candidate.id === effectiveReviewId)
    if (!review) return
    setBusy(true)
    try {
      decidePluginReviewForProject(doc, project.id, {
        reviewId: review.id,
        expectedProposalEventId: review.proposal.eventId,
        expectedResearchRevision: projectStateFingerprint(doc),
        decision,
        ...identity(),
      })
      setStatus(`Review decision recorded as ${decision}. The draft was not changed.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }

  return <PluginWorkspaceContent
    packages={packages}
    reviews={reviews}
    healthy={healthy}
    selectedPackageId={effectivePackageId}
    selectedContributionId={effectiveContributionId}
    selectedReviewId={effectiveReviewId}
    busy={busy}
    status={status}
    error={error}
    manifestName={manifestFile?.name ?? null}
    componentName={componentFile?.name ?? null}
    currentDocumentRevision={currentDocumentRevision}
    onManifestFile={setManifestFile}
    onComponentFile={setComponentFile}
    onLoad={() => { void load() }}
    onSelectPackage={(packageId) => { setSelectedPackageId(packageId); setSelectedContributionId('') }}
    onSelectContribution={setSelectedContributionId}
    onRemovePackage={(packageId) => { pluginPackageRegistry.remove(packageId); setSelectedPackageId(''); setStatus('Plugin unloaded from this app session.') }}
    onRun={() => { void run() }}
    onSelectReview={setSelectedReviewId}
    onDecision={decide}
  />
}
