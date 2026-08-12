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
import type { PluginContributionKind } from '../extensions/pluginManifest'
import {
  pluginPackageRegistry,
  PluginPackageRegistryError,
  type LoadedPluginPackageSummary,
} from '../extensions/pluginPackageRegistry'
import {
  pluginInstallationCatalog,
  pluginInstallationStore,
  PluginInstallationError,
  type InstalledPluginSummary,
} from '../extensions/pluginInstallationStore'
import {
  applyPluginReviewForProject,
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
const MAX_SIGNATURE_BYTES = 64 * 1024

const CONTRIBUTION_KIND_LABELS: Record<PluginContributionKind, string> = {
  tool: 'Tool',
  evaluator: 'Evaluator',
  importer: 'Importer',
  exporter: 'Exporter',
}

export interface PluginWorkspaceContentProps {
  packages: LoadedPluginPackageSummary[]
  installedPackages: InstalledPluginSummary[]
  reviews: CollaborativePluginReview[]
  healthy: boolean
  selectedPackageId: string
  selectedContributionId: string
  selectedReviewId: string
  armedReplaceReviewId: string
  busy: boolean
  status: string | null
  error: string | null
  manifestName: string | null
  componentName: string | null
  signatureName: string | null
  rotationName: string | null
  currentDocumentRevision: string | null
  onManifestFile: (file: File | null) => void
  onComponentFile: (file: File | null) => void
  onSignatureFile: (file: File | null) => void
  onRotationFile: (file: File | null) => void
  onLoad: () => void
  onInstall: () => void
  onSelectPackage: (packageId: string) => void
  onSelectContribution: (contributionId: string) => void
  onRemovePackage: (packageId: string) => void
  onActivateInstalled: (packageId: string) => void
  onDisableInstalled: (packageId: string) => void
  onRollbackInstalled: (pluginId: string, packageId: string) => void
  onRemoveInstalled: (packageId: string) => void
  onRun: () => void
  onSelectReview: (reviewId: string) => void
  onDecision: (decision: PluginReviewDecision) => void
  onApplyReview: (reviewId: string) => void
  onCancelReplace: () => void
}

export function PluginWorkspaceContent({
  packages, installedPackages, reviews, healthy, selectedPackageId, selectedContributionId, selectedReviewId,
  armedReplaceReviewId,
  busy, status, error, manifestName, componentName, signatureName, rotationName, currentDocumentRevision,
  onManifestFile, onComponentFile, onSignatureFile, onRotationFile, onLoad, onSelectPackage, onSelectContribution,
  onInstall, onRemovePackage, onActivateInstalled, onDisableInstalled, onRollbackInstalled,
  onRemoveInstalled, onRun, onSelectReview, onDecision, onApplyReview, onCancelReplace,
}: PluginWorkspaceContentProps) {
  const selectedPackage = packages.find((plugin) => plugin.packageId === selectedPackageId) ?? null
  const selectedReview = reviews.find((review) => review.id === selectedReviewId) ?? reviews[reviews.length - 1] ?? null
  const stale = Boolean(selectedReview && currentDocumentRevision &&
    selectedReview.proposal.expectedRevision !== currentDocumentRevision)
  const acceptedDecision = selectedReview?.status === 'accepted'
    ? selectedReview.decisions.find((decision) => decision.decision === 'accepted') ?? null : null
  const inactiveCapabilities = selectedPackage?.requestedCapabilities.filter(
    (capability) => capability !== 'project.read' && capability !== 'project.propose',
  ) ?? []
  const selectedContribution = selectedPackage?.contributions.find(
    (contribution) => contribution.id === selectedContributionId,
  ) ?? null

  return (
    <section className="plugin-workspace" aria-labelledby="plugin-workspace-title">
      <div className="workspace-panel-label mono">Open research extensions</div>
      <h2 id="plugin-workspace-title">Research plugins</h2>
      <p>
        Load an unsigned development component for this session, or install a publisher-signed
        package locally with retained rollback. Runs use the zero-import sandbox; returned changes
        enter shared review and never edit the draft automatically.
      </p>

      <details className="plugin-load-panel">
        <summary>Load or install a zero-authority component</summary>
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
          <label>
            Publisher signature for installation
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => onSignatureFile(event.target.files?.[0] ?? null)}
            />
            <span className="mono">{signatureName ?? 'Optional for session load; required to install'}</span>
          </label>
          <label>
            Publisher key-rotation certificate
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => onRotationFile(event.target.files?.[0] ?? null)}
            />
            <span className="mono">{rotationName ?? 'Required only when an established plugin changes signing keys'}</span>
          </label>
        </div>
        <div className="plugin-actions">
          <button type="button" disabled={busy || !manifestName || !componentName} onClick={onLoad}>
            Load unsigned for this session
          </button>
          <button type="button" disabled={busy || !manifestName || !componentName || !signatureName} onClick={onInstall}>
            Verify signature and install locally
          </button>
        </div>
        <p className="plugin-scope-note">
          A publisher key proves continuity of the signed package bytes, not the publisher's legal or
          human identity. Installed versions are rechecked before enable, upgrade, rollback, and run.
          A key change requires one plugin/version/sequence-bound certificate signed by both the old
          and new keys; it does not create external publisher identity or reputation.
          Capability-bearing network, Drive, model, or filesystem worlds remain unavailable.
        </p>
      </details>

      <div className="plugin-review-heading">
        <h3>Installed signed packages</h3>
        <span className="mono">{installedPackages.length} local version{installedPackages.length === 1 ? '' : 's'}</span>
      </div>
      {installedPackages.length === 0 ? (
        <div className="plugin-empty">No publisher-signed package is installed locally.</div>
      ) : installedPackages.map((installed) => {
        const loaded = packages.some((candidate) => candidate.packageId === installed.packageId)
        return (
          <article className="plugin-review-card" key={installed.packageId}>
            <div className="plugin-review-meta mono">
              <span>{installed.name} · {installed.version}</span>
              <span>{installed.enabled ? loaded ? 'Enabled · verified this session' : 'Enabled · not active this session' : 'Disabled'}</span>
            </div>
            <p>{installed.description}</p>
            <div className="plugin-package-meta mono">
              <span>Publisher key {installed.publisherKeyId.replace('ed25519-sha256:', '').slice(0, 16)}…</span>
              <span>{installed.componentSha256.slice(0, 16)}… · {installed.componentByteLength.toLocaleString()} bytes</span>
              <span>{installed.contributions.length} declared contribution{installed.contributions.length === 1 ? '' : 's'} · {
                Array.from(new Set(installed.contributions.map((contribution) =>
                  CONTRIBUTION_KIND_LABELS[contribution.kind]))).join(', ')
              }</span>
            </div>
            <p className="plugin-scope-note">Self-described publisher: {installed.publisherName}. This signature does not authenticate an organization or person.</p>
            <div className="plugin-actions">
              {installed.enabled ? (
                <button type="button" className="btn ghost" disabled={busy} onClick={() => onDisableInstalled(installed.packageId)}>Disable</button>
              ) : installed.activationAction === 'rollback' ? (
                <button type="button" disabled={busy} onClick={() => onRollbackInstalled(installed.pluginId, installed.packageId)}>Roll back to this signed version</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => onActivateInstalled(installed.packageId)}>
                  {installed.activationAction === 'upgrade' ? 'Upgrade to this stored version' : 'Enable signed version'}
                </button>
              )}
              {!installed.enabled ? (
                <button type="button" className="btn ghost" disabled={busy} onClick={() => onRemoveInstalled(installed.packageId)}>Remove stored version</button>
              ) : null}
            </div>
          </article>
        )
      })}

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
                    <option key={contribution.id} value={contribution.id}>
                      {CONTRIBUTION_KIND_LABELS[contribution.kind]} · {contribution.title}
                    </option>
                  ))}
                </select>
              </label>
              {selectedContribution ? (
                <div className="plugin-contribution-card" data-kind={selectedContribution.kind}>
                  <span className="mono">{CONTRIBUTION_KIND_LABELS[selectedContribution.kind]} · host-rendered manifest metadata</span>
                  <strong>{selectedContribution.title}</strong>
                  <p>{selectedContribution.description}</p>
                  <small>No plugin HTML, script, CSS, or active link is rendered here.</small>
                </div>
              ) : null}
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
                  {busy ? 'Running bounded worker…' : 'Run selected contribution in no-authority sandbox'}
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
              <option key={review.id} value={review.id}>{review.applications.length ? 'applied' : review.status} · {review.proposal.summary}</option>
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
              {selectedReview.applications[0] ? (
                <p className="plugin-scope-note" role="status">
                  Applied by {selectedReview.applications[0].applierDisplayName}. Exact application
                  event retained from revision <span className="mono">{selectedReview.applications[0].sourceDocumentRevision}</span>{' '}
                  to <span className="mono">{selectedReview.applications[0].resultDocumentRevision}</span>.
                  Device attribution identifies an installation key, not a verified person.
                </p>
              ) : null}
              {selectedReview.status === 'pending' ? (
                <div className="plugin-actions">
                  <button type="button" disabled={busy || !healthy} onClick={() => onDecision('accepted')}>Record accepted</button>
                  <button type="button" className="btn ghost" disabled={busy || !healthy} onClick={() => onDecision('rejected')}>Record rejected</button>
                </div>
              ) : null}
              {selectedReview.status === 'accepted' && acceptedDecision && selectedReview.applications.length === 0 ? (
                selectedReview.proposal.operation === 'replace' && armedReplaceReviewId !== selectedReview.id ? (
                  <div className="plugin-actions">
                    <button
                      type="button"
                      disabled={busy || !healthy || stale || !currentDocumentRevision}
                      onClick={() => onApplyReview(selectedReview.id)}
                    >
                      Review replacement of entire draft
                    </button>
                  </div>
                ) : selectedReview.proposal.operation === 'replace' ? (
                  <div className="plugin-apply-confirmation" role="alert">
                    <strong>This will replace every current draft block.</strong>
                    <p>The accepted proposal becomes one linked policy block in review status. Shared review history remains intact.</p>
                    <div className="plugin-actions">
                      <button
                        type="button"
                        disabled={busy || !healthy || stale || !currentDocumentRevision}
                        onClick={() => onApplyReview(selectedReview.id)}
                      >
                        Confirm replace entire draft
                      </button>
                      <button type="button" className="btn ghost" disabled={busy} onClick={onCancelReplace}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="plugin-actions">
                    <button
                      type="button"
                      disabled={busy || !healthy || stale || !currentDocumentRevision}
                      onClick={() => onApplyReview(selectedReview.id)}
                    >
                      Apply accepted proposal to draft
                    </button>
                  </div>
                )
              ) : null}
              <p className="plugin-scope-note">
                A review decision only records shared history. Apply is a separate action guarded by
                this exact proposal, accepted decision, research revision, and live document revision.
                The plugin never receives draft mutation authority.
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
  const [installationRevision, setInstallationRevision] = useState(0)
  const [manifestFile, setManifestFile] = useState<File | null>(null)
  const [componentFile, setComponentFile] = useState<File | null>(null)
  const [signatureFile, setSignatureFile] = useState<File | null>(null)
  const [rotationFile, setRotationFile] = useState<File | null>(null)
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [selectedContributionId, setSelectedContributionId] = useState('')
  const [selectedReviewId, setSelectedReviewId] = useState('')
  const [armedReplaceReviewId, setArmedReplaceReviewId] = useState('')
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => pluginPackageRegistry.subscribe(() => setRegistryRevision((value) => value + 1)), [])
  useEffect(() => pluginInstallationCatalog.subscribe(() => setInstallationRevision((value) => value + 1)), [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await pluginInstallationStore.refreshCatalog()
        const restored = await pluginInstallationStore.restoreEnabled()
        if (cancelled) return
        for (const plugin of restored.packages) {
          pluginPackageRegistry.list().filter((candidate) =>
            candidate.pluginId === plugin.manifest.id && candidate.packageId !== plugin.packageId)
            .forEach((candidate) => pluginPackageRegistry.remove(candidate.packageId))
          pluginPackageRegistry.register(plugin)
        }
        if (restored.failures.length > 0) {
          setStatus(`${restored.failures.length} enabled signed package${restored.failures.length === 1 ? '' : 's'} failed integrity or signature recheck and was not loaded.`)
        }
      } catch (value) {
        if (!cancelled) setError(value instanceof Error ? value.message : String(value))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [])
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
  const installedPackages = useMemo(() => pluginInstallationCatalog.list(), [installationRevision])
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
    if (!researcherId || !researcherName.trim()) throw new Error('Set a researcher name in Settings before running, reviewing, or applying a plugin proposal')
    return { participantId: researcherId, displayName: researcherName.trim() }
  }
  const explain = (value: unknown) => {
    if (value instanceof PluginExecutionError || value instanceof PluginPackageRegistryError ||
      value instanceof PluginInstallationError) return `${value.message} (${value.code})`
    return value instanceof Error ? value.message : String(value)
  }
  const readSelectedPackage = async () => {
    if (!manifestFile || !componentFile) return
    if (manifestFile.name !== 'syzygy-plugin.json' || manifestFile.size < 1 || manifestFile.size > MAX_MANIFEST_BYTES ||
      componentFile.size < 1 || componentFile.size > MAX_COMPONENT_BYTES) {
      throw new Error('Choose syzygy-plugin.json (up to 1 MiB) and its exact component (up to 8 MiB).')
    }
    const manifest = JSON.parse(await manifestFile.text()) as unknown
    return loadZeroAuthorityPluginPackage(manifest, {
      name: componentFile.name,
      bytes: new Uint8Array(await componentFile.arrayBuffer()),
    })
  }
  const load = async () => {
    setError(null); setStatus(null)
    setBusy(true)
    try {
      const plugin = await readSelectedPackage()
      if (!plugin) return
      const summary = pluginPackageRegistry.register(plugin)
      setSelectedPackageId(summary.packageId)
      setSelectedContributionId(summary.contributions[0]?.id ?? '')
      setStatus(`${summary.name} ${summary.version} is loaded in memory for this app session.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const install = async () => {
    setError(null); setStatus(null)
    if (!signatureFile || signatureFile.size < 1 || signatureFile.size > MAX_SIGNATURE_BYTES) {
      setError('Choose the package publisher signature JSON (up to 64 KiB).')
      return
    }
    if (rotationFile && (rotationFile.size < 1 || rotationFile.size > MAX_SIGNATURE_BYTES)) {
      setError('Choose a publisher key-rotation certificate JSON up to 64 KiB, or clear it.')
      return
    }
    setBusy(true)
    try {
      const plugin = await readSelectedPackage()
      if (!plugin) return
      const signature = JSON.parse(await signatureFile.text()) as unknown
      const rotation = rotationFile ? JSON.parse(await rotationFile.text()) as unknown : undefined
      const result = await pluginInstallationStore.installSigned(plugin, signature, rotation)
      if (result.replacedPackageId) pluginPackageRegistry.remove(result.replacedPackageId)
      pluginPackageRegistry.list().filter((candidate) =>
        candidate.pluginId === plugin.manifest.id && candidate.packageId !== plugin.packageId)
        .forEach((candidate) => pluginPackageRegistry.remove(candidate.packageId))
      const summary = pluginPackageRegistry.register(plugin)
      setSelectedPackageId(summary.packageId)
      setSelectedContributionId(summary.contributions[0]?.id ?? '')
      setStatus(`${summary.name} ${summary.version} was ${result.action === 'upgraded' ? 'installed as a signed upgrade' : result.action === 'already-installed' ? 'reverified and enabled' : 'installed and enabled'}. ${result.publisherKeyRotated ? `Dual-signed publisher-key rotation sequence ${result.publisherRotationSequence} was retained. ` : ''}Publisher-key continuity was verified; publisher identity was not.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const disableInstalled = async (packageId: string) => {
    setError(null); setStatus(null); setBusy(true)
    try {
      const summary = await pluginInstallationStore.disable(packageId)
      pluginPackageRegistry.remove(packageId)
      setStatus(`${summary.name} ${summary.version} is disabled locally. Its signed version remains available for rollback or removal.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const activateInstalled = async (packageId: string) => {
    setError(null); setStatus(null); setBusy(true)
    try {
      const plugin = await pluginInstallationStore.getVerified(packageId)
      const summary = await pluginInstallationStore.activate(packageId)
      pluginPackageRegistry.list().filter((candidate) =>
        candidate.pluginId === summary.pluginId && candidate.packageId !== packageId)
        .forEach((candidate) => pluginPackageRegistry.remove(candidate.packageId))
      pluginPackageRegistry.register(plugin)
      setSelectedPackageId(packageId)
      setSelectedContributionId(plugin.manifest.contributions[0]?.id ?? '')
      setStatus(`${summary.name} ${summary.version} is enabled after component and publisher-signature recheck.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const rollbackInstalled = async (pluginId: string, packageId: string) => {
    setError(null); setStatus(null); setBusy(true)
    try {
      const plugin = await pluginInstallationStore.getVerified(packageId)
      const summary = await pluginInstallationStore.rollback(pluginId, packageId)
      pluginPackageRegistry.list().filter((candidate) => candidate.pluginId === pluginId)
        .forEach((candidate) => pluginPackageRegistry.remove(candidate.packageId))
      pluginPackageRegistry.register(plugin)
      setSelectedPackageId(packageId)
      setSelectedContributionId(plugin.manifest.contributions[0]?.id ?? '')
      setStatus(`Rolled back to ${summary.name} ${summary.version} after exact component and publisher-signature recheck.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const removeInstalled = async (packageId: string) => {
    setError(null); setStatus(null); setBusy(true)
    try {
      await pluginInstallationStore.remove(packageId)
      pluginPackageRegistry.remove(packageId)
      setStatus('Disabled signed package version removed from local storage. Shared review history was not changed.')
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
        const signed = result.attributions.filter((value) => value.status === 'signed-device').length
        setStatus(`${result.reviews.length} proposal${result.reviews.length === 1 ? '' : 's'} added to shared review. ${signed} received registered-device attribution; ${result.attributions.length - signed} remain explicitly unsigned. The draft was not changed.`)
      }
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const decide = async (decision: PluginReviewDecision) => {
    setError(null); setStatus(null)
    if (!doc) return
    const review = reviews.find((candidate) => candidate.id === effectiveReviewId)
    if (!review) return
    setBusy(true)
    try {
      const result = await decidePluginReviewForProject(doc, project.id, {
        reviewId: review.id,
        expectedProposalEventId: review.proposal.eventId,
        expectedResearchRevision: projectStateFingerprint(doc),
        decision,
        ...identity(),
      })
      setStatus(`Review decision recorded as ${decision} with ${result.attribution.status === 'signed-device' ? 'registered-device attribution' : 'explicit unsigned attribution'}. Device attribution does not verify a human identity. The draft was not changed.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }
  const applyReview = async (reviewId: string) => {
    setError(null); setStatus(null)
    if (!doc || !currentDocumentRevision) return
    const review = reviews.find((candidate) => candidate.id === reviewId)
    const acceptedDecision = review?.status === 'accepted'
      ? review.decisions.find((decision) => decision.decision === 'accepted') : null
    if (!review || !acceptedDecision) return
    if (review.proposal.operation === 'replace' && armedReplaceReviewId !== review.id) {
      setArmedReplaceReviewId(review.id)
      setStatus('Full-draft replacement is armed. Confirm only after reviewing the exact accepted proposal and current draft.')
      return
    }
    setBusy(true)
    try {
      const result = await applyPluginReviewForProject(doc, project.id, {
        reviewId: review.id,
        expectedProposalEventId: review.proposal.eventId,
        expectedDecisionEventId: acceptedDecision.eventId,
        expectedDocumentRevision: currentDocumentRevision,
        expectedResearchRevision: projectStateFingerprint(doc),
        confirmFullReplacement: review.proposal.operation === 'replace',
        ...identity(),
      })
      setArmedReplaceReviewId('')
      const attribution = result.attribution.status === 'signed-device'
        ? 'registered-device attribution'
        : 'explicit unsigned attribution'
      setStatus(result.operation === 'append'
        ? `Applied the exact accepted proposal as one linked review-policy block with ${attribution}. The plugin received no mutation authority.`
        : `Replaced the draft with the exact accepted proposal as one linked review-policy block with ${attribution}. Shared review history was retained.`)
    } catch (value) { setError(explain(value)) } finally { setBusy(false) }
  }

  return <PluginWorkspaceContent
    packages={packages}
    installedPackages={installedPackages}
    reviews={reviews}
    healthy={healthy}
    selectedPackageId={effectivePackageId}
    selectedContributionId={effectiveContributionId}
    selectedReviewId={effectiveReviewId}
    armedReplaceReviewId={armedReplaceReviewId}
    busy={busy}
    status={status}
    error={error}
    manifestName={manifestFile?.name ?? null}
    componentName={componentFile?.name ?? null}
    signatureName={signatureFile?.name ?? null}
    rotationName={rotationFile?.name ?? null}
    currentDocumentRevision={currentDocumentRevision}
    onManifestFile={setManifestFile}
    onComponentFile={setComponentFile}
    onSignatureFile={setSignatureFile}
    onRotationFile={setRotationFile}
    onLoad={() => { void load() }}
    onInstall={() => { void install() }}
    onSelectPackage={(packageId) => { setSelectedPackageId(packageId); setSelectedContributionId('') }}
    onSelectContribution={setSelectedContributionId}
    onRemovePackage={(packageId) => { pluginPackageRegistry.remove(packageId); setSelectedPackageId(''); setStatus('Plugin unloaded from this app session.') }}
    onActivateInstalled={(packageId) => { void activateInstalled(packageId) }}
    onDisableInstalled={(packageId) => { void disableInstalled(packageId) }}
    onRollbackInstalled={(pluginId, packageId) => { void rollbackInstalled(pluginId, packageId) }}
    onRemoveInstalled={(packageId) => { void removeInstalled(packageId) }}
    onRun={() => { void run() }}
    onSelectReview={(reviewId) => { setSelectedReviewId(reviewId); setArmedReplaceReviewId('') }}
    onDecision={(decision) => { void decide(decision) }}
    onApplyReview={applyReview}
    onCancelReplace={() => { setArmedReplaceReviewId(''); setStatus(null) }}
  />
}
