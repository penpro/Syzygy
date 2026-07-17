import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(`${name}: ${detail}`)
}
const text = (path) => readFileSync(join(root, path), 'utf8')

function filesBelow(path, extensions) {
  const base = join(root, path)
  const out = []
  for (const name of readdirSync(base)) {
    const full = join(base, name)
    if (statSync(full).isDirectory()) out.push(...filesBelow(relative(root, full), extensions))
    else if (extensions.includes(extname(name))) out.push(full)
  }
  return out
}

const lock = JSON.parse(text('frontend/package-lock.json'))
const frontendPackage = JSON.parse(text('frontend/package.json'))
const packageNames = Object.keys(lock.packages ?? {}).map((key) => key.replace(/^node_modules\//, ''))
const forbiddenPackages = packageNames.filter((name) => /(^|\/)(@?tiptap|firebase|policy-?pad)(\/|$)/i.test(name))
record('forbidden dependencies', forbiddenPackages.length === 0, forbiddenPackages.join(', ') || 'none')

const expectedEditorDependencies = {
  lexical: '0.47.0',
  '@lexical/react': '0.47.0',
  '@lexical/rich-text': '0.47.0',
  '@lexical/selection': '0.47.0',
  '@lexical/yjs': '0.47.0',
  yjs: '13.6.31',
  'y-indexeddb': '9.0.12',
  'y-protocols': '1.0.7',
}
const rootPackage = lock.packages?.[''] ?? {}
const editorDependencyMismatches = Object.entries(expectedEditorDependencies).filter(
  ([name, version]) => rootPackage.dependencies?.[name] !== version || lock.packages?.[`node_modules/${name}`]?.version !== version,
)
record(
  'editor dependencies exact',
  editorDependencyMismatches.length === 0,
  editorDependencyMismatches.map(([name, version]) => `${name} != ${version}`).join(', ') || 'all approved versions pinned',
)

const sourceFiles = [
  ...filesBelow('frontend/src', ['.ts', '.tsx']),
  ...filesBelow('frontend/src-tauri/src', ['.rs']),
]
const forbiddenImports = sourceFiles
  .filter((path) => /(?:from\s+['"](?:@tiptap|firebase)|use\s+(?:tiptap|firebase)|extern\s+crate\s+(?:tiptap|firebase))/i.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('forbidden source imports', forbiddenImports.length === 0, forbiddenImports.join(', ') || 'none')

const invokeViolations = filesBelow('frontend/src', ['.ts', '.tsx'])
  .filter((path) => !path.endsWith(`${join('src', 'tauri.ts')}`))
  .filter((path) => /\binvoke\s*\(/.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('single invoke boundary', invokeViolations.length === 0, invokeViolations.join(', ') || 'tauri.ts only')

const colorViolations = filesBelow('frontend/src/components', ['.ts', '.tsx'])
  .filter((path) => /#[0-9a-f]{3,8}\b/i.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('component theme tokens', colorViolations.length === 0, colorViolations.join(', ') || 'no hard-coded hex colors')

const installerText = `${text('frontend/src-tauri/installer/English.nsh')}\n${text('frontend/src-tauri/installer-hooks.nsh')}`
record('installer identity', !/Aphelion|com\.localllm\.studio/i.test(installerText), 'Syzygy names and data path')
record('icon source', existsSync(join(root, 'frontend/src-tauri/syzygy-icon.svg')), 'syzygy-icon.svg exists')

const watchdogSource = text('scripts/run-with-heartbeat.mjs')
const watchdogTestSource = text('scripts/run-with-heartbeat.test.mjs')
record(
  'development operations remain deadline-bounded with at-most-one-minute heartbeats',
  frontendPackage.scripts?.['test:watchdog'] === 'node --test ../scripts/run-with-heartbeat.test.mjs' &&
    watchdogSource.includes('DEFAULT_HEARTBEAT_SECONDS = 30') &&
    watchdogSource.includes('MAX_HEARTBEAT_SECONDS = 60') &&
    watchdogSource.includes('TIMEOUT_EXIT_CODE = 124') &&
    watchdogSource.includes("spawnSync('taskkill'") &&
    watchdogSource.includes("throw new Error('--timeout-seconds is required')") &&
    watchdogTestSource.includes('rejects heartbeat intervals over one minute') &&
    watchdogTestSource.includes('terminates a hung process tree at the deadline') &&
    watchdogTestSource.includes('assert.equal(result.status, 124)'),
  'mandatory deadlines, 30-second default/60-second maximum heartbeat, Windows process-tree cleanup, and executable timeout fixtures are present',
)

const provenance = text('docs/audits/EDITOR-PROVENANCE.md')
const workspaceSources = filesBelow('frontend/src/workspace', ['.ts', '.tsx'])
  .filter((path) => !path.endsWith('.test.ts'))
  .map((path) => relative(root, path).replaceAll('\\', '/'))
const missingWorkspaceProvenance = workspaceSources.filter((path) => !provenance.includes(path))
record(
  'workspace provenance ledger',
  missingWorkspaceProvenance.length === 0,
  missingWorkspaceProvenance.join(', ') || `${workspaceSources.length} source files registered`,
)

const projectArchiveSource = text('frontend/src/workspace/projectArchive.ts')
const projectArchiveTestSource = text('frontend/src/workspace/projectArchive.test.ts')
const projectArchiveUiSource = text('frontend/src/workspace/ProjectArchiveControls.tsx')
const projectArchiveUiTestSource = text('frontend/src/workspace/ProjectArchiveControls.ui.test.ts')
const projectStoreSource = text('frontend/src/store.ts')
record(
  'portable project archives remain bounded, identity-safe, engine-free, and evidence-honest',
  projectArchiveSource.includes("PROJECT_ARCHIVE_FORMAT = 'syzygy-project-archive'") &&
    projectArchiveSource.includes('PROJECT_ARCHIVE_MAX_FILE_BYTES = 36_000_000') &&
    projectArchiveSource.includes("globalThis.crypto.subtle.digest('SHA-256', ownedBytes.buffer)") &&
    projectArchiveSource.includes('assertDocumentIdentity(doc, manifest)') &&
    projectArchiveSource.includes('Project archive manifest contains unsupported fields') &&
    projectArchiveSource.includes("transport: { kind: 'local' }") &&
    projectArchiveSource.includes('project.id === manifest.id || project.documentId === manifest.documentId') &&
    projectArchiveSource.includes('Local storage already contains different state for this project') &&
    projectArchiveTestSource.includes('round-trips every shared collection with stable identity and a local import binding') &&
    projectArchiveTestSource.includes('persists an imported archive and reopens it from IndexedDB without a network provider') &&
    projectArchiveTestSource.includes('refuses to merge an archive with different orphaned local state') &&
    projectArchiveUiSource.includes('subscribeAutomationProjectDocument(project.id') &&
    projectArchiveUiSource.includes('assertProjectArchiveImportAvailable(decoded.manifest, useStore.getState().projects)') &&
    projectArchiveUiSource.includes('if (file.size > PROJECT_ARCHIVE_MAX_FILE_BYTES)') &&
    projectArchiveUiTestSource.includes('keeps import available without an existing project') &&
    projectStoreSource.includes('addImportedProject: (value) =>') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "S-04", "phase": 3, "status": "implemented_unverified"') &&
    existsSync(join(root, 'docs/audits/runs/PORTABLE-ARCHIVE-2026-07-16.json')),
  'checksummed exact-state envelope, bounded input, fail-closed manifest/document identity, local rebinding, collision/orphan refusal, offline IndexedDB reopen, accessible product controls, and truthful S-04 status are present',
)

const editorStructureSource = text('frontend/src/workspace/editorStructure.ts')
const editorStructureTestSource = text('frontend/src/workspace/editorStructure.test.ts')
const editorFormattingTestSource = text('frontend/src/workspace/ResearchEditorFormatting.test.ts')
const editorOutlineSource = text('frontend/src/workspace/ResearchTableOfContents.tsx')
const editorOutlineTestSource = text('frontend/src/workspace/ResearchTableOfContents.ui.test.ts')
const policyBlockTestSource = text('frontend/src/workspace/nodes/PolicyBlockNode.test.ts')
const editorLedgerSource = text('docs/audits/CAPABILITIES.json')
record(
  'editor formatting, live outline, and bounded local reorder stay evidence honest',
  editorStructureSource.includes("createCommand<PolicyMoveDirection>('syzygy-move-policy-block')") &&
    editorStructureSource.includes('KEY_ARROW_UP_COMMAND') &&
    editorStructureSource.includes('KEY_ARROW_DOWN_COMMAND') &&
    editorStructureSource.includes('$isHeadingNode(node)') &&
    editorStructureTestSource.includes('uses one command for pointer controls and guarded keyboard reorder') &&
    editorFormattingTestSource.includes('round-trips headings, paragraphs, quotes, policy identity, Unicode, and supported marks') &&
    editorOutlineSource.includes('readResearchHeadings(editorState)') &&
    editorOutlineSource.includes('aria-label="Document outline"') &&
    editorOutlineTestSource.includes('renders an honest empty state and substitutes an untitled label') &&
    policyBlockTestSource.includes("it.fails('preserves a concurrent text edit when that policy block moves during a partition'") &&
    editorLedgerSource.includes('"id": "P-09", "phase": 2, "status": "implemented_unverified"') &&
    editorLedgerSource.includes('"id": "P-10", "phase": 2, "status": "implemented_unverified"') &&
    editorLedgerSource.includes('"id": "P-34", "phase": 2, "status": "implemented_unverified"'),
  'shared pointer/keyboard command, live heading projection, formatting and UI fixtures, explicit remote-safety expected failure, and truthful P-09/P-10/P-34 statuses are present',
)

const heuristicsModelSource = text('frontend/src/workspace/heuristicsModel.ts')
const heuristicsModelTestSource = text('frontend/src/workspace/heuristicsModel.test.ts')
record(
  'collaborative heuristics remain typed, attributed, replay-safe, and convergent',
  heuristicsModelSource.includes('HEURISTIC_SCHEMA_VERSION = 1') &&
    heuristicsModelSource.includes('new Y.Map<HeuristicEdit>()') &&
    heuristicsModelSource.includes('MAX_EDIT_HISTORY = 10_000') &&
    heuristicsModelSource.includes('editStorageKey') &&
    heuristicsModelSource.includes('Heuristic edit ID was reused') &&
    heuristicsModelSource.includes("collection.doc.transact(operation, 'syzygy-heuristics')") &&
    heuristicsModelSource.includes('collection.delete(id)') &&
    heuristicsModelSource.includes('validStoredEdit') &&
    heuristicsModelSource.includes('changes: { ...edit.changes }') &&
    (heuristicsModelTestSource.match(/seed <= 40/g) ?? []).length === 2 &&
    heuristicsModelTestSource.includes('delete-versus-edit without resurrection') &&
    heuristicsModelTestSource.includes('disconnected peers independently reuse one edit ID') &&
    heuristicsModelTestSource.includes('Mutated plugin copy') &&
    heuristicsModelTestSource.includes('peer supplies malformed edit fields') &&
    heuristicsModelTestSource.includes("toThrow('Heuristic edit ID was reused')") &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-04", "phase": 2, "status": "implemented_unverified"'),
  'nested field/edit CRDT maps, detached bounded reads, hostile-input and peer-collision fail-closed attribution, 80 seeded merge orders, delete-without-resurrection, and truthful P-04 status are present',
)

const scenarioModelSource = text('frontend/src/workspace/scenarioModel.ts')
const scenarioModelTestSource = text('frontend/src/workspace/scenarioModel.test.ts')
record(
  'collaborative scenarios remain ordered, attributed, collision-safe, and convergent',
  scenarioModelSource.includes('SCENARIO_SCHEMA_VERSION = 1') &&
    scenarioModelSource.includes('new Y.Array<string>()') &&
    scenarioModelSource.includes('new Y.Map<ScenarioTurnRevision>()') &&
    scenarioModelSource.includes('scenarioEntries') &&
    scenarioModelSource.includes("collection.doc.transact(operation, 'syzygy-scenarios')") &&
    scenarioModelSource.includes('inspectScenarioGraph') &&
    scenarioModelTestSource.includes('lifecycle CRUD, attributed multi-turn revisions, and branch lineage') &&
    (scenarioModelTestSource.match(/seed <= 40/g) ?? []).length === 2 &&
    scenarioModelTestSource.includes('one public turn identity') &&
    scenarioModelTestSource.includes('one public scenario identity') &&
    scenarioModelTestSource.includes('top-level deletion authoritative') &&
    scenarioModelTestSource.includes('malformed turn order') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-14", "phase": 6, "status": "implemented_unverified"') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-15", "phase": 6, "status": "implemented_unverified"'),
  'nested ordered turn/revision/edit CRDTs, peer-collision fail-closed IDs, branch inspection, lifecycle/multi-turn CRUD, 80 delivery orders, delete authority, malformed-input tests, and truthful P-14/P-15 statuses are present',
)

const scenarioVoteSource = text('frontend/src/workspace/scenarioVoteModel.ts')
const scenarioWorkspaceSource = text('frontend/src/workspace/ScenarioWorkspace.tsx')
const scenarioWorkspaceTestSource = text('frontend/src/workspace/ScenarioWorkspace.ui.test.ts')
record(
  'scenario product workspace remains live, engine-free, stale-safe, and integrity-read-only',
  scenarioWorkspaceSource.includes('subscribeAutomationProjectDocument(project.id') &&
    scenarioWorkspaceSource.includes('scenarioDetailsRevision(current) !== editingHead') &&
    scenarioWorkspaceSource.includes('if (!graph.healthy)') &&
    scenarioWorkspaceSource.includes('createScenario(writableShared().scenarios') &&
    scenarioWorkspaceSource.includes('addScenarioTurn(writableShared().scenarios') &&
    scenarioWorkspaceSource.includes('castScenarioVote(types.discussions, types.scenarios') &&
    scenarioWorkspaceSource.includes('identity is not authenticated') &&
    scenarioWorkspaceTestSource.includes('offers engine-free creation from an honest empty state') &&
    scenarioWorkspaceTestSource.includes('reports loading, integrity, and mutation failures accessibly') &&
    scenarioWorkspaceTestSource.includes('changes the stale-edit revision when any scenario edit identity appears') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-14", "phase": 6, "status": "implemented_unverified"') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-15", "phase": 6, "status": "implemented_unverified"') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-19", "phase": 6, "status": "implemented_unverified"') &&
    existsSync(join(root, 'docs/audits/runs/SCENARIO-WORKSPACE-2026-07-16.json')),
  'live Y.Doc subscription, scenario CRUD/status, ordered turn add, vote/withdraw, stale-detail guard, graph-integrity write denial, accessible states, and truthful P-14/P-15/P-19 statuses are present',
)

const scenarioVoteTestSource = text('frontend/src/workspace/scenarioVoteModel.test.ts')
record(
  'collaborative scenario votes remain idempotent, attributed, namespaced, and convergent',
  scenarioVoteSource.includes('SCENARIO_VOTE_SCHEMA_VERSION = 1') &&
    scenarioVoteSource.includes("VOTE_BUCKET_PREFIX = 'scenario-votes:v1:'") &&
    scenarioVoteSource.includes("collection.doc.transact(operation, 'syzygy-scenario-votes')") &&
    scenarioVoteSource.includes('Scenario vote event ID was reused') &&
    scenarioVoteSource.includes('inspectScenarioVotes') &&
    scenarioVoteTestSource.includes('supports idempotent voting, attributed revoting, abstention, and withdrawal') &&
    (scenarioVoteTestSource.match(/seed <= 40/g) ?? []).length === 2 &&
    scenarioVoteTestSource.includes('disconnected first votes without losing either participant') &&
    scenarioVoteTestSource.includes('concurrent revotes by one participant') &&
    scenarioVoteTestSource.includes('reuse one event identity with different votes') &&
    scenarioVoteTestSource.includes('future-discussion-type') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-19", "phase": 6, "status": "implemented_unverified"'),
  'versioned discussion namespace, immutable attributed events, replay/revote/withdrawal behavior, 80 delivery orders, collision/orphan/malformed gates, and truthful P-19 status are present',
)

const scenarioAnnotationSource = text('frontend/src/workspace/scenarioAnnotationModel.ts')
const scenarioAnnotationTestSource = text('frontend/src/workspace/scenarioAnnotationModel.test.ts')
record(
  'collaborative scenario annotations remain revision-guarded, attributed, branched, and convergent',
  scenarioAnnotationSource.includes('SCENARIO_ANNOTATION_SCHEMA_VERSION = 1') &&
    scenarioAnnotationSource.includes("ANNOTATION_BUCKET_PREFIX = 'scenario-annotations:v1:'") &&
    scenarioAnnotationSource.includes("collection.doc.transact(operation, 'syzygy-scenario-annotations')") &&
    scenarioAnnotationSource.includes('Scenario annotation revision conflict') &&
    scenarioAnnotationSource.includes('inspectScenarioAnnotations') &&
    scenarioAnnotationTestSource.includes('retains note edits plus flag resolve and reopen lifecycle attribution') &&
    (scenarioAnnotationTestSource.match(/seed <= 40/g) ?? []).length === 2 &&
    scenarioAnnotationTestSource.includes('disconnected first notes without namespace replacement') &&
    scenarioAnnotationTestSource.includes('concurrent edit and resolve branches') &&
    scenarioAnnotationTestSource.includes('colliding annotation identity') &&
    scenarioAnnotationTestSource.includes('future-discussion-type') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-20", "phase": 6, "status": "implemented_unverified"'),
  'separate versioned namespace, immutable parent-linked lifecycle, exact-current guards, 80 delivery orders, collision/orphan gates, and truthful P-20 status are present',
)

const scenarioLabelSource = text('frontend/src/workspace/scenarioLabelModel.ts')
const scenarioLabelTestSource = text('frontend/src/workspace/scenarioLabelModel.test.ts')
record(
  'collaborative scenario labels remain revision-guarded, attributed, filterable, and convergent',
  scenarioLabelSource.includes('SCENARIO_LABEL_SCHEMA_VERSION = 1') &&
    scenarioLabelSource.includes("LABEL_PREFIX = 'scenario-labels:v1:'") &&
    scenarioLabelSource.includes("ASSIGNMENT_PREFIX = 'scenario-label-assignments:v1:'") &&
    scenarioLabelSource.includes("collection.doc.transact(operation, 'syzygy-scenario-labels')") &&
    scenarioLabelSource.includes('Scenario label revision conflict') &&
    scenarioLabelSource.includes('Scenario label assignment revision conflict') &&
    scenarioLabelSource.includes('Scenario label event ID was reused') &&
    scenarioLabelSource.includes('listScenarioIdsForLabel') &&
    scenarioLabelSource.includes('inspectScenarioLabels') &&
    scenarioLabelTestSource.includes('retains concurrent renames and selects one deterministic current name') &&
    scenarioLabelTestSource.includes('converges disconnected assignments and filters every matching scenario') &&
    scenarioLabelTestSource.includes('length: 40') &&
    scenarioLabelTestSource.includes('rejects stale rename and assignment events without changing history') &&
    scenarioLabelTestSource.includes('disconnected label identity collisions and reports orphan assignments') &&
    scenarioLabelTestSource.includes("scenario-labels:v1:malformed") &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-21", "phase": 6, "status": "implemented_unverified"'),
  'separate label/assignment namespaces, immutable replay-safe exact-parent events, 80 delivery orders, deterministic filtering, stale/collision/orphan/malformed gates, and truthful P-21 status are present',
)

const policyVersionSource = text('frontend/src/workspace/policyVersionModel.ts')
const policyVersionTestSource = text('frontend/src/workspace/policyVersionModel.test.ts')
record(
  'policy versions remain immutable, content-addressed, attributed, and convergent',
  policyVersionSource.includes('POLICY_VERSION_SCHEMA_VERSION = 1') &&
    policyVersionSource.includes("globalThis.crypto.subtle.digest('SHA-256'") &&
    policyVersionSource.includes("collection.doc.transact(operation, 'syzygy-policy-version')") &&
    policyVersionSource.includes('canonical !== stored || await sha256(canonical) !== versionId') &&
    policyVersionSource.includes('Parent policy version belongs to another project') &&
    policyVersionSource.includes('blocks: payload.policy.blocks.map((block) => ({ ...block }))') &&
    policyVersionTestSource.includes('Mutated caller copy') &&
    policyVersionTestSource.includes('Tampered policy') &&
    policyVersionTestSource.includes('later changes display name') &&
    policyVersionTestSource.includes('seed <= 40') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-23", "phase": 3, "status": "implemented_unverified"') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-27", "phase": 3, "status": "implemented_unverified"'),
  'canonical SHA-256 envelopes, detached verified reads, lineage/project guards, historical attribution, tamper rejection, 40 branch delivery orders, and truthful P-23/P-27 statuses are present',
)

const policyVersionHistorySource = text('frontend/src/workspace/policyVersionHistory.ts')
const policyVersionHistoryTestSource = text('frontend/src/workspace/policyVersionHistory.test.ts')
record(
  'policy restore and diffs remain history-preserving, revision-guarded, and engine-free',
  policyVersionSource.includes('POLICY_VERSION_HEAD_KEY') &&
    policyVersionSource.includes("collection.doc.transact(operation, 'syzygy-policy-version-head')") &&
    policyVersionSource.includes('Policy version head conflict') &&
    policyVersionSource.includes('Parent policy version changed during commit') &&
    policyVersionSource.includes('if (existing === undefined) collection.delete(prepared.versionId)') &&
    policyVersionTestSource.includes('preserves a canonical version that appears during commit preparation') &&
    policyVersionSource.includes('export async function readPolicyVersionLineage') &&
    policyVersionHistorySource.includes('return commitPolicyVersion(versions, metadata, commit)') &&
    policyVersionHistorySource.includes('export function diffPolicyVersions') &&
    policyVersionHistorySource.includes('export function deterministicChangeNote') &&
    !/ollama|model_provider|fetch\s*\(/.test(policyVersionHistorySource) &&
    policyVersionHistoryTestSource.includes('without rewriting history') &&
    policyVersionHistoryTestSource.includes('rejects stale commits without creating an orphan') &&
    policyVersionHistoryTestSource.includes('seed <= 40') &&
    policyVersionHistoryTestSource.includes('immutable ancestor is missing') &&
    policyVersionHistoryTestSource.includes('produces a stable engine-free structured diff and change note') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-28", "phase": 3, "status": "implemented_unverified"') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-29", "phase": 3, "status": "implemented_unverified"'),
  'exact-head atomic commit, rollback preserves a version inserted during preparation, bounded lineage verification, restore-as-new-child, retained concurrent branches, 40 delivery orders, pure deterministic diff/note, and truthful P-28/P-29 statuses are present',
)

const policyVersionRailSource = text('frontend/src/workspace/PolicyVersionRail.tsx')
const localProjectProviderSource = text('frontend/src/workspace/localProvider.ts')
const localProjectProviderTestSource = text('frontend/src/workspace/localProvider.test.ts')
const policyVersionRailTestSource = text('frontend/src/workspace/PolicyVersionRail.ui.test.ts')
const restoreAutomationSource = text('frontend/src/workspace/versionAutomation.ts')
const restoreAutomationTestSource = text('frontend/src/workspace/versionAutomation.test.ts')
const restoreIntegrationTestSource = text('frontend/src/workspace/versionRestoreIntegration.test.ts')
const editorAutomationSource = text('frontend/src/workspace/editorAutomation.ts')
const editorAutomationTestSource = text('frontend/src/workspace/editorAutomation.test.ts')
const migrationSource = text('frontend/src/migrations.ts')
record(
  'product version rail remains live-document scoped, exact-revision guarded, and restore-honest',
  policyVersionRailSource.includes('subscribeAutomationProjectDocument(project.id, setDoc)') &&
    policyVersionRailSource.includes('readAutomationEditor(project.id)') &&
    policyVersionRailSource.includes('expectedDocumentRevision: snapshot.revision') &&
    policyVersionRailSource.includes('expectedHeadVersionId: readPolicyVersionHead(metadata)') &&
    policyVersionRailSource.includes('historyValid && automationEditorReady(project.id)') &&
    policyVersionRailSource.includes('assertVersionRailHistory(nextVersions, versionMap.size, nextHead)') &&
    policyVersionRailSource.includes('restoreAutomationPolicyVersion(doc, project.id') &&
    policyVersionRailSource.includes('Existing versions stay unchanged') &&
    policyVersionRailSource.includes('Prepare restore') &&
    policyVersionRailTestSource.includes('renders accessible save controls') &&
    policyVersionRailTestSource.includes('renders a two-step restore that keeps immutable history explicit') &&
    restoreAutomationSource.includes('expectedDocumentRevision: string') &&
    restoreAutomationSource.includes('editor.replaceBlocks(input.expectedDocumentRevision, targetBlocks)') &&
    restoreAutomationSource.includes('editor.replaceBlocks(current.revision, before.blocks)') &&
    policyVersionSource.includes('transactionMutation?.apply()') &&
    policyVersionSource.includes('transactionMutation.rollback()') &&
    restoreAutomationTestSource.includes('restores the live semantic draft and creates its new immutable head in one Yjs transaction') &&
    restoreAutomationTestSource.includes('rolls the live draft and shared head back inside the same transaction') &&
    restoreAutomationTestSource.includes('rejects stale restore input before invoking the editor mutation') &&
    restoreIntegrationTestSource.includes('changedTypes.has(rightBinding.root)') &&
    restoreIntegrationTestSource.includes('changedTypes.has(metadata)') &&
    restoreIntegrationTestSource.includes('changedTypes.has(versions)') &&
    restoreIntegrationTestSource.includes('expect(readBlocks(right)).toEqual(rootBlocks)') &&
    editorAutomationSource.includes('replaceBlocks: (expectedRevision, blocks)') &&
    editorAutomationSource.includes('MAX_SEMANTIC_BLOCK_CONTENT = 500_000') &&
    editorAutomationTestSource.includes('without interpreting paragraph text as markup') &&
    text('docs/audits/CAPABILITIES.json').includes('"id": "P-28", "phase": 3, "status": "implemented_unverified"') &&
    policyVersionRailTestSource.includes("toThrow('invalid checkpoint')") &&
    policyVersionRailTestSource.includes("toThrow('head is missing')") &&
    policyVersionRailTestSource.includes("toThrow('missing parent')") &&
    localProjectProviderSource.includes('void this.persistence.whenSynced.then') &&
    localProjectProviderSource.indexOf('void this.persistence.whenSynced.then') <
      localProjectProviderSource.indexOf(
        'this.unregisterAutomation = registerAutomationProjectDocument(this.projectId, this.doc)',
      ) &&
    localProjectProviderTestSource.includes("expect(automationProjectDocumentReady('document-1')).toBe(false)") &&
    localProjectProviderTestSource.includes("expect(automationProjectDocumentReady('document-1')).toBe(true)") &&
    migrationSource.includes('PERSISTED_STORE_VERSION = 3') &&
    migrationSource.includes('storedVersion > PERSISTED_STORE_VERSION'),
  'post-IndexedDB publication, exact draft/head guards, rollback-aware semantic replacement, two-step UI, one-update two-peer Yjs proof, durable attribution, and truthful P-28 status are present',
)

const tauriConfig = JSON.parse(text('frontend/src-tauri/tauri.conf.json'))
record(
  'bundle identity',
  tauriConfig.productName === 'Syzygy' && tauriConfig.mainBinaryName === 'Syzygy',
  `${tauriConfig.productName}/${tauriConfig.mainBinaryName}`,
)

const mcpSource = text('frontend/src-tauri/src/mcp.rs')
const automationSource = text('frontend/src-tauri/src/automation.rs')
const mainSource = text('frontend/src-tauri/src/main.rs')
const advertisedMcpTools = [
  'syzygy_status',
  'launch_syzygy',
  'workspace_walkthrough',
  'list_projects',
  'create_project',
  'open_project',
  'rename_project',
  'read_active_project',
  'inspect_research_state',
  'create_scenario',
  'add_scenario_turn',
  'revise_scenario_turn',
  'cast_scenario_vote',
  'create_scenario_annotation',
  'update_scenario_annotation',
  'set_scenario_annotation_resolution',
  'create_scenario_label',
  'rename_scenario_label',
  'set_scenario_label_assignment',
  'save_active_policy_version',
  'restore_active_policy_version',
  'replace_active_document',
  'append_active_document',
  'syzygy_installation',
  'syzygy_platform_contracts',
]
record(
  'embedded MCP entry and tools',
  mainSource.includes('"--mcp"') && advertisedMcpTools.every((name) => mcpSource.includes(`"${name}"`)),
  `${advertisedMcpTools.filter((name) => mcpSource.includes(`"${name}"`)).length}/${advertisedMcpTools.length} semantic tools registered`,
)
const researchInspectionSource = text('frontend/src/workspace/researchStateInspection.ts')
const researchInspectionTestSource = text('frontend/src/workspace/researchStateInspection.test.ts')
const automationRegistrySource = text('frontend/src/workspace/workspaceAutomationRegistry.ts')
record(
  'MCP research-state inspection remains live, bounded, content-minimized, and read-only',
  automationRegistrySource.includes('if (documents.get(projectId) !== doc) return') &&
    automationRegistrySource.includes('documents.delete(projectId)') &&
    automationRegistrySource.includes('notify(projectId, null)') &&
    text('frontend/src/workspace/workspaceAutomationRegistry.test.ts')
      .includes('notifies product subscribers across registration, replacement, and final cleanup') &&
    text('frontend/src/workspace/localProvider.ts').includes('registerAutomationProjectDocument(this.projectId, this.doc)') &&
    text('frontend/src/automationBridge.ts').includes("case 'project.readResearchState'") &&
    researchInspectionSource.includes('MAX_RETURNED_ITEMS = 200') &&
    researchInspectionSource.includes('readPolicyVersionLineage') &&
    researchInspectionSource.includes('countInvalidLineages') &&
    researchInspectionSource.includes('inspectScenarioGraph') &&
    researchInspectionSource.includes('inspectScenarioAnnotations') &&
    researchInspectionSource.includes('inspectScenarioVotes') &&
    researchInspectionSource.includes('inspectScenarioLabels') &&
    researchInspectionSource.includes('listScenarioIdsForLabel') &&
    researchInspectionSource.includes('turnRevisionCount') &&
    researchInspectionSource.includes('scenario background/turn content/revision bodies') &&
    researchInspectionTestSource.includes('Secret guidance is omitted') &&
    researchInspectionTestSource.includes("not.toContain('Secret policy text')") &&
    researchInspectionTestSource.includes("not.toContain('Secret scenario turn')") &&
    researchInspectionTestSource.includes("not.toContain('Secret annotation body')") &&
    researchInspectionTestSource.includes("not.toContain('Secret annotator display name')") &&
    researchInspectionTestSource.includes("not.toContain('Secret voter display name')") &&
    researchInspectionTestSource.includes("labelCount: 1, assignmentCount: 1") &&
    researchInspectionTestSource.includes('reports invalid scenario branch ancestry') &&
    researchInspectionTestSource.includes('reports a tampered version and invalid head lineage') &&
    researchInspectionTestSource.includes('content-valid non-head record whose ancestor is missing') &&
    mcpSource.includes('"inspect_research_state" => live("project.readResearchState"') &&
    text('scripts/mcp-live-harness.mjs').includes('researchStateHealthy: true'),
  'identity-safe live Y.Doc registry, 200-item metadata caps, scenario graph/vote/annotation/label plus version-lineage self-checks, secret-body canaries, read-only MCP routing, and packaged-live assertion are present',
)
const versionAutomationSource = text('frontend/src/workspace/versionAutomation.ts')
const versionAutomationTestSource = text('frontend/src/workspace/versionAutomation.test.ts')
record(
  'MCP policy checkpoints remain dual-revision guarded and append-only',
  policyVersionSource.includes('assertCurrentState?.()') &&
    versionAutomationSource.includes("throw new Error('Document revision conflict')") &&
    versionAutomationSource.includes('expectedHeadVersionId: input.expectedHeadVersionId') &&
    versionAutomationSource.includes('snapshot.blocks.map(versionBlock)') &&
    text('frontend/src/automationBridge.ts').includes("case 'project.savePolicyVersion'") &&
    versionAutomationTestSource.includes('rejects a stale document revision before hashing or mutation') &&
    versionAutomationTestSource.includes('inside the head transaction after asynchronous hashing') &&
    versionAutomationTestSource.includes('requires the exact immutable head') &&
    mcpSource.includes('"save_active_policy_version" => live("project.savePolicyVersion"') &&
    text('scripts/mcp-live-harness.mjs').includes('dualRevisionCheckpoint: true'),
  'pre-hash and in-transaction document guards, exact head/parent checks, semantic block mapping, stale/mid-hash zero-write tests, fourteenth MCP route, and packaged-live assertion are present',
)
record(
  'MCP policy restore remains target/document/head guarded, history-preserving, and rollback-safe',
  versionAutomationSource.includes('targetVersionId: string') &&
    versionAutomationSource.includes('readPolicyVersionLineage(versions, input.targetVersionId)') &&
    versionAutomationSource.includes('readPolicyVersionHead(metadata) !== input.expectedHeadVersionId') &&
    versionAutomationSource.includes('editor.replaceBlocks(input.expectedDocumentRevision, targetBlocks)') &&
    versionAutomationSource.includes('editor.replaceBlocks(current.revision, before.blocks)') &&
    text('frontend/src/automationBridge.ts').includes("case 'project.restorePolicyVersion'") &&
    versionAutomationTestSource.includes('restores the live semantic draft and creates its new immutable head in one Yjs transaction') &&
    versionAutomationTestSource.includes('rolls the live draft and shared head back inside the same transaction when replacement fails') &&
    versionAutomationTestSource.includes('rejects stale restore input before invoking the editor mutation') &&
    mcpSource.includes('"restore_active_policy_version" => live("project.restorePolicyVersion"') &&
    text('scripts/mcp-harness.mjs').includes("tool.name === 'restore_active_policy_version'") &&
    text('scripts/mcp-live-harness.mjs').includes('policyRestoreRevisionGuarded: true') &&
    text('scripts/mcp-live-harness.mjs').includes('staleRestoreDocumentRejected: true') &&
    text('scripts/mcp-live-harness.mjs').includes('staleRestoreHeadRejected: true') &&
    text('scripts/mcp-live-harness.mjs').includes('restoredReadbackMatchedCheckpoint: true'),
  'exact target/document/head guards, atomic restore-as-new-head, rollback proof, twenty-fifth MCP route, stale zero-write assertions, and packaged readback are present',
)
const scenarioAutomationSource = text('frontend/src/workspace/scenarioAutomation.ts')
const scenarioAutomationTestSource = text('frontend/src/workspace/scenarioAutomation.test.ts')
record(
  'MCP scenario creation remains research-revision guarded and live-document scoped',
  researchInspectionSource.includes('startingRevision = projectStateFingerprint(doc)') &&
    researchInspectionSource.includes('Research state changed during inspection; inspect again') &&
    scenarioAutomationSource.includes("throw new Error('Research state revision conflict')") &&
    scenarioAutomationSource.includes('createScenario(scenarios') &&
    scenarioAutomationSource.includes('addScenarioTurn(scenarios') &&
    scenarioAutomationSource.includes('updateScenarioTurn(scenarios') &&
    scenarioAutomationSource.includes('castScenarioVote(discussions, scenarios') &&
    scenarioAutomationSource.includes('createScenarioAnnotation(discussions, scenarios') &&
    scenarioAutomationSource.includes('updateScenarioAnnotation(discussions, scenarios') &&
    scenarioAutomationSource.includes('setScenarioAnnotationResolution(discussions, scenarios') &&
    scenarioAutomationSource.includes('createScenarioLabel(settings') &&
    scenarioAutomationSource.includes('renameScenarioLabel(settings') &&
    scenarioAutomationSource.includes('setScenarioLabelAssignment(settings, scenarios') &&
    scenarioAutomationTestSource.includes('creates one scenario against the exact monotonic research revision') &&
    scenarioAutomationTestSource.includes('rejects a stale revision without mutating scenario state') &&
    scenarioAutomationTestSource.includes('adds and revises a turn through successive exact research revisions') &&
    scenarioAutomationTestSource.includes('rejects stale turn add and revision without changing turn history') &&
    scenarioAutomationTestSource.includes('casts, revises, and withdraws one participant vote through chained revisions') &&
    scenarioAutomationTestSource.includes('rejects a stale vote without adding a vote event') &&
    scenarioAutomationTestSource.includes('creates, edits, resolves, and reopens an annotation through dual revision guards') &&
    scenarioAutomationTestSource.includes('rejects stale research and annotation revisions without adding lifecycle events') &&
    scenarioAutomationTestSource.includes('creates, renames, assigns, and removes a label through chained research revisions') &&
    scenarioAutomationTestSource.includes('rejects stale research and label parents without adding label events') &&
    text('frontend/src/automationBridge.ts').includes("case 'project.createScenario'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.addScenarioTurn'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.reviseScenarioTurn'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.castScenarioVote'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.createScenarioAnnotation'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.updateScenarioAnnotation'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.setScenarioAnnotationResolution'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.createScenarioLabel'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.renameScenarioLabel'") &&
    text('frontend/src/automationBridge.ts').includes("case 'project.setScenarioLabelAssignment'") &&
    mcpSource.includes('"create_scenario" => live("project.createScenario"') &&
    mcpSource.includes('"add_scenario_turn" => live("project.addScenarioTurn"') &&
    mcpSource.includes('"revise_scenario_turn" => live("project.reviseScenarioTurn"') &&
    mcpSource.includes('"cast_scenario_vote" => live("project.castScenarioVote"') &&
    mcpSource.includes('"create_scenario_annotation" => live("project.createScenarioAnnotation"') &&
    mcpSource.includes('"update_scenario_annotation" => live("project.updateScenarioAnnotation"') &&
    mcpSource.includes('"set_scenario_annotation_resolution"') &&
    mcpSource.includes('live("project.setScenarioAnnotationResolution", arguments)') &&
    mcpSource.includes('"create_scenario_label" => live("project.createScenarioLabel"') &&
    mcpSource.includes('"rename_scenario_label" => live("project.renameScenarioLabel"') &&
    mcpSource.includes('"set_scenario_label_assignment"') &&
    mcpSource.includes('live("project.setScenarioLabelAssignment", arguments)') &&
    text('scripts/mcp-live-harness.mjs').includes('staleScenarioCreateRejected: true') &&
    text('scripts/mcp-live-harness.mjs').includes('scenarioTurnAddAndRevisionGuarded: true') &&
    text('scripts/mcp-live-harness.mjs').includes('scenarioVoteRevisionGuarded: true') &&
    text('scripts/mcp-live-harness.mjs').includes('staleScenarioVoteRejected: true') &&
    text('scripts/mcp-live-harness.mjs').includes('scenarioAnnotationLifecycleGuarded: true') &&
    text('scripts/mcp-live-harness.mjs').includes('staleScenarioAnnotationRejected: true') &&
    text('scripts/mcp-live-harness.mjs').includes('scenarioLabelLifecycleGuarded: true') &&
    text('scripts/mcp-live-harness.mjs').includes('staleScenarioLabelRejected: true'),
  'stable inspection revision, zero-write stale rejection, live Y.Doc scenario/turn/vote/annotation/label routes, twenty-fourth MCP tool set, and packaged-live assertions are present',
)
const pluginManifestSchema = JSON.parse(text('docs/schemas/syzygy-research-plugin-v1.schema.json'))
const pluginProposalSchema = JSON.parse(text('docs/schemas/syzygy-plugin-proposal-v1.schema.json'))
const pluginCertificationSchema = JSON.parse(text('docs/schemas/syzygy-plugin-certification-v1.schema.json'))
const adversarialRunSchema = JSON.parse(text('docs/schemas/syzygy-adversarial-run-v1.schema.json'))
const providerRunSchema = JSON.parse(text('docs/schemas/syzygy-provider-run-v1.schema.json'))
const modelAdapterSchema = JSON.parse(text('docs/schemas/syzygy-model-adapter-v1.schema.json'))
const modelAdapterCertificationSchema = JSON.parse(text('docs/schemas/syzygy-model-adapter-certification-v1.schema.json'))
const platformContractsSource = text('frontend/src-tauri/src/platform_contracts.rs')
const providerRuntimeSource = text('frontend/src-tauri/src/model_provider.rs')
const providerTaskRuntimeSource = text('frontend/src-tauri/src/provider_runtime.rs')
const providerStreamSource = text('frontend/src-tauri/src/provider_stream.rs')
const credentialVaultSource = text('frontend/src-tauri/src/credential_vault.rs')
const providerSettingsSource = text('frontend/src/components/RemoteProviderSettings.tsx')
const tauriSource = text('frontend/src/tauri.ts')
const providerResearchRequestSource = tauriSource.slice(
  tauriSource.indexOf('export interface ProviderResearchTaskRequest'),
  tauriSource.indexOf('export interface ProviderNormalizedUsage'),
)
const credentialHarnessSource = text('frontend/src-tauri/src/bin/credential-harness.rs')
const cargoManifestSource = text('frontend/src-tauri/Cargo.toml')
const cargoLockSource = text('frontend/src-tauri/Cargo.lock')
const rustWiringSource = text('frontend/src-tauri/src/lib.rs')
record(
  'research extension contracts',
  pluginManifestSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    pluginManifestSchema.additionalProperties === false &&
    pluginProposalSchema.additionalProperties === false &&
    pluginCertificationSchema.additionalProperties === false &&
    platformContractsSource.includes('"pluginLoader": "contract-only"') &&
    platformContractsSource.includes('"pluginCertifier": "contract-certified-runner"') &&
    platformContractsSource.includes('"automaticSharedMutation": false'),
  'strict v1 schemas, honest runtime status, and proposal-only shared mutation',
)
const pluginCertifierSource = text('scripts/plugin-certifier.mjs')
const pluginAuthorityBrokerSource = text('frontend/src/extensions/pluginAuthorityBroker.ts')
const pluginAuthorityBrokerTestSource = text('frontend/src/extensions/pluginAuthorityBroker.test.ts')
const pluginWasiContractSource = text('frontend/src/extensions/pluginWasiContract.ts')
const pluginWasiContractTestSource = text('frontend/src/extensions/pluginWasiContract.test.ts')
const pluginWitSource = text('docs/wit/syzygy-research-plugin-v1.wit')
record(
  'plugin package certification remains non-executing',
  rootPackage.devDependencies?.ajv === '8.20.0' &&
    lock.packages?.['node_modules/ajv']?.version === '8.20.0' &&
    pluginCertifierSource.includes("frontendRequire('ajv/dist/2020')") &&
    pluginCertifierSource.includes('realpathSync') &&
    pluginCertifierSource.includes('expected-valid and one expected-invalid') &&
    pluginCertifierSource.includes('at least one denied-authority probe') &&
    !/child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/.test(pluginCertifierSource) &&
    text('examples/plugins/citation-auditor/citation-auditor.component').includes('NOT AN EXECUTABLE'),
  'exact Draft 2020 validator, real-path and adversarial-fixture gates, no process execution, interface-only example',
)
record(
  'plugin host authority broker remains least-authority and non-executing',
  pluginAuthorityBrokerSource.includes('class ResearchPluginAuthorityBroker') &&
    pluginAuthorityBrokerSource.includes("status: 'pending-human-review'") &&
    pluginAuthorityBrokerSource.includes("throw new PluginHostError('stale-revision')") &&
    pluginAuthorityBrokerSource.includes('requiresPublicAddressRecheck: true') &&
    pluginAuthorityBrokerSource.includes('requiresProviderDisclosure: provider !== \'local\'') &&
    pluginAuthorityBrokerSource.includes('requiresProviderRunRecord: true') &&
    pluginAuthorityBrokerSource.includes('requiresTargetRecheck: true') &&
    pluginAuthorityBrokerSource.includes('SESSION_LIFETIME_MS') &&
    pluginAuthorityBrokerSource.includes('structuredClone') &&
    !/\bfetch\s*\(|providerGenerate|rawInvoke|\binvoke\s*\(/.test(pluginAuthorityBrokerSource) &&
    pluginAuthorityBrokerTestSource.includes('mutated plugin copy') &&
    pluginAuthorityBrokerTestSource.includes('permission-denied') &&
    frontendPackage.scripts?.['test:plugin-host']?.includes('pluginAuthorityBroker.test.ts') &&
    platformContractsSource.includes('"pluginAuthorityBroker": "implemented-non-executing"') &&
    platformContractsSource.includes('"pluginLoader": "contract-only"'),
  'short-lived explicit grants, detached snapshots, pending revision-guarded proposals, target-only decisions, sanitized denial, and no runtime/network/model execution',
)
record(
  'plugin WIT contract is versioned, bounded, proposal-only, and zero-import',
  pluginWitSource.includes('package syzygy:research@1.0.0;') &&
    pluginWitSource.includes('world plugin') &&
    pluginWitSource.includes('export research-plugin;') &&
    !/^\s*import\s/m.test(pluginWitSource) &&
    pluginWasiContractSource.includes("RESEARCH_PLUGIN_WIT_WORLD") &&
    pluginWasiContractSource.includes('MAX_INVOCATION_BYTES') &&
    pluginWasiContractSource.includes('validatePluginChangeProposal') &&
    pluginWasiContractSource.includes("kind: 'no-change'") &&
    pluginWasiContractSource.includes("kind: 'proposals'") &&
    pluginWasiContractTestSource.includes('rejects ambient fields') &&
    pluginWasiContractTestSource.includes('directly mutating plugin output') &&
    cargoManifestSource.includes('wit-parser = "=0.223.1"') &&
    platformContractsSource.includes('plugin_wit_parses_as_one_zero_import_world') &&
    platformContractsSource.includes('world.imports.is_empty()') &&
    platformContractsSource.includes('"pluginWitContract": "published-zero-imports-no-runtime"') &&
    platformContractsSource.includes('"pluginWitWorld": "syzygy:research/plugin@1.0.0"'),
  'pinned upstream parser resolves one zero-import world; typed envelopes cap snapshots/output and accept only no-change or schema-validated revision-guarded proposals; no runtime is claimed',
)
const adversarialRecordSource = text('frontend/src/extensions/adversarialRunRecord.ts')
const adversarialRunnerSource = text('frontend/src/extensions/adversarialRunner.ts')
const adversarialRunnerTestSource = text('frontend/src/extensions/adversarialRunner.test.ts')
record(
  'adversarial records remain evidence-gated',
  adversarialRecordSource.includes('leaks participant identity') &&
    adversarialRecordSource.includes('lacks an evidence audit') &&
    adversarialRecordSource.includes('supported minority finding') &&
    adversarialRecordSource.includes('planned equal compute budget') &&
    adversarialRecordSource.includes('shared mutation requires accepted human review') &&
    adversarialRecordSource.includes('hidden chain-of-thought fields are prohibited') &&
    adversarialRunSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    adversarialRunSchema.additionalProperties === false &&
    adversarialRunSchema.properties?.recordVersion?.const === 1 &&
    platformContractsSource.includes('"adversarialRunRecordSchema"') &&
    platformContractsSource.includes('"adversarialRecordValidator": "implemented"') &&
    platformContractsSource.includes('"adversarialRunner": "injected-runner-no-product-executor"'),
  'public strict schema plus identity blinding, evidence, minority, equal-budget, human-mutation, and no-hidden-reasoning gates present',
)
record(
  'adversarial runner remains injected, bounded, blinded, and non-mutating',
    adversarialRunnerSource.includes('Promise.allSettled') &&
    adversarialRunnerSource.includes('computeMatchedBaselineCallBudget') &&
    adversarialRunnerSource.includes('result.entries.length > 10_000') &&
    adversarialRunnerSource.includes('result.synthesis.text.length > 4 * 1024 * 1024') &&
    adversarialRunnerSource.includes("humanDecision: { status: 'pending'") &&
    adversarialRunnerSource.includes("sharedMutation: { applied: false") &&
    adversarialRunnerSource.includes("throw new AdversarialRunnerError('invalid-run-record'") &&
    adversarialRunnerSource.includes("typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)") &&
    !adversarialRunnerSource.includes('providerGenerate') &&
    adversarialRunnerTestSource.includes('keeps candidate/provider routing outside judge-visible and baseline payloads') &&
    adversarialRunnerTestSource.includes('provider-body-secret-canary') &&
    frontendPackage.scripts?.['test:adversarial']?.includes('adversarialRunner.test.ts') &&
    platformContractsSource.includes('"adversarialRunner": "injected-runner-no-product-executor"'),
  'injected executor only; phased all-settled calls, bounded intermediates, equal baseline budget, blinded payloads, sanitized failure, semantic record gate, pending human decision, and no product provider import',
)
const providerRunRecordSource = text('frontend/src/extensions/providerRunRecord.ts')
const providerRuntimeInteropSource = text('scripts/provider-runtime-interop.mjs')
record(
  'provider run records remain disclosure and provenance gated',
  providerRunSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    providerRunSchema.additionalProperties === false &&
    providerRunSchema.properties?.recordVersion?.const === 1 &&
    providerRunRecordSource.includes('remote execution requires recorded human disclosure approval') &&
    providerRunRecordSource.includes('remote product execution destination must use HTTPS') &&
    providerRunRecordSource.includes('attested zero retention requires a true typed attestation') &&
    providerRunRecordSource.includes('totalTokens must equal inputTokens plus outputTokens') &&
    providerRunRecordSource.includes('must not contain prompts, outputs, credentials, or raw payloads') &&
    providerRunSchema.properties?.executionMode?.enum?.includes('loopback-conformance') &&
    providerRunRecordSource.includes('loopback conformance destination must use literal loopback') &&
    providerRuntimeInteropSource.includes('SYZYGY_PROVIDER_RUN_RECORD') &&
    platformContractsSource.includes('"providerRunRecordSchema"') &&
    platformContractsSource.includes('"providerRunRecordValidator": "implemented"'),
  'strict public schema plus product/conformance endpoint honesty, disclosure, retention, accounting, content-exclusion, cross-language harness, and MCP gates present',
)
const modelAdapterProfileSource = text('frontend/src/extensions/modelAdapterProfile.ts')
const modelAdapterCertifierSource = text('scripts/model-adapter-certifier.mjs')
record(
  'custom model adapters remain declarative and endpoint pinned',
  modelAdapterSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    modelAdapterSchema.additionalProperties === false &&
    modelAdapterCertificationSchema.additionalProperties === false &&
    modelAdapterProfileSource.includes('custom adapter ID must not shadow a built-in provider') &&
    modelAdapterProfileSource.includes('endpoint path must match the declared compatibility protocol') &&
    modelAdapterProfileSource.includes('remote adapter must use HTTPS') &&
    modelAdapterProfileSource.includes('target.origin === expected.origin') &&
    modelAdapterCertifierSource.includes('contract certification does not execute the adapter') &&
    modelAdapterCertifierSource.includes('safePackagePath') &&
    !/child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/.test(modelAdapterCertifierSource) &&
    platformContractsSource.includes('"modelAdapterProfileSchema"') &&
    platformContractsSource.includes('"modelAdapterCertifier": "contract-certified-runner"'),
  'strict profile/certification schemas, loopback/TLS/policy semantics, exact origin-route probes, non-executing runner, and truthful MCP status',
)
record(
  'remote provider boundary remains gated',
  providerRuntimeSource.includes('"store": false') &&
    providerRuntimeSource.includes('validate_for(RemoteProviderId::OpenAi)') &&
    providerRuntimeSource.includes('MAX_RESPONSE_BYTES') &&
    providerRuntimeSource.includes('endpoint.scheme() == "https"') &&
    providerRuntimeSource.includes('ProviderError::Timeout') &&
    providerRuntimeSource.includes('ProviderError::Cancelled') &&
    providerRuntimeSource.includes('execute_openai_stream_controlled') &&
    providerRuntimeSource.includes('execute_anthropic_response_controlled') &&
    providerRuntimeSource.includes('anthropic-version') &&
    providerRuntimeSource.includes('2023-06-01') &&
    providerRuntimeSource.includes('"x-api-key"') &&
    providerRuntimeSource.includes('execute_gemini_response_controlled') &&
    providerRuntimeSource.includes('"x-goog-api-key"') &&
    providerRuntimeSource.includes('"thinking_summaries": "none"') &&
    providerRuntimeSource.includes('"background": false') &&
    providerRuntimeSource.includes('execute_xai_response_controlled') &&
    providerRuntimeSource.includes('x-zero-data-retention') &&
    providerRuntimeSource.includes('zero_data_retention') &&
    providerRuntimeSource.includes('MAX_STREAM_BYTES') &&
    providerRuntimeSource.includes('text/event-stream') &&
    providerRuntimeSource.includes('Abortable::new') &&
    providerRuntimeSource.includes('.timeout(execution.timeout)') &&
    providerStreamSource.includes('MAX_PENDING_BYTES') &&
    providerStreamSource.includes('ProviderWarning') &&
    providerStreamSource.includes('provider-error-body-canary') &&
    platformContractsSource.includes('request-and-stream-control-conformance') &&
    platformContractsSource.includes('ANTHROPIC_ADAPTER_STATUS') &&
    platformContractsSource.includes('GEMINI_ADAPTER_STATUS') &&
    platformContractsSource.includes('XAI_ADAPTER_STATUS') &&
    platformContractsSource.includes('OPENAI_ADAPTER_STATUS') &&
    !rustWiringSource.includes('model_provider::execute_openai_response') &&
    !rustWiringSource.includes('model_provider::execute_openai_stream_controlled') &&
    !rustWiringSource.includes('model_provider::execute_anthropic_response') &&
    !rustWiringSource.includes('model_provider::execute_gemini_response') &&
    rustWiringSource.includes('provider_runtime::provider_generate') &&
    rustWiringSource.includes('provider_runtime::provider_cancel') &&
    rustWiringSource.includes('provider_runtime::provider_adversarial_authorize') &&
    rustWiringSource.includes('provider_runtime::provider_adversarial_revoke') &&
    rustWiringSource.includes('provider_runtime::provider_adversarial_authorization_status') &&
    providerTaskRuntimeSource.includes('execute_openai_response_controlled') &&
    providerTaskRuntimeSource.includes('execute_anthropic_response_controlled') &&
    providerTaskRuntimeSource.includes('execute_gemini_response_controlled') &&
    providerTaskRuntimeSource.includes('execute_xai_response_controlled') &&
    providerTaskRuntimeSource.includes('run_record(') &&
    providerTaskRuntimeSource.includes('MessageDialogButtons::OkCancelCustom') &&
    providerTaskRuntimeSource.includes('.blocking_show()') &&
    providerTaskRuntimeSource.includes('spawn_blocking') &&
    !providerTaskRuntimeSource.includes('pub disclosure_accepted') &&
    platformContractsSource.includes('"remoteProviderAdapters": "native-disclosure-single-review-ui-no-live-proof"') &&
    platformContractsSource.includes('"providerTaskRuntime": "native-disclosure-research-envelope"') &&
    providerTaskRuntimeSource.includes('"executionMode": execution_mode') &&
    text('frontend/src/tauri.ts').includes("invoke('provider_generate'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_cancel'") &&
    text('frontend/src/workspace/RemoteResearchReview.tsx').includes('providerGenerate(request)') &&
    text('frontend/src/workspace/RemoteResearchReview.tsx').includes('providerCancel(activeCallId)') &&
    text('frontend/src/workspace/RemoteResearchReview.tsx').includes('getAutomationEditorController(project.id).read()') &&
    text('frontend/src/workspace/remoteResearchTask.ts').includes("taskType: 'research.remote-review'") &&
    text('frontend/src/workspace/remoteResearchTask.ts').includes("crypto.subtle.digest('SHA-256'") &&
    text('frontend/src/workspace/remoteResearchTask.test.ts').includes('without forging disclosure or provenance fields') &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_authorize'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_revoke'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_authorization_status'") &&
    !text('frontend/src/tauri.ts').includes('disclosureAccepted') &&
    text('frontend/src-tauri/src/bin/provider-runtime-harness.rs').includes('interop-secret-canary'),
  'OpenAI request/stream plus Anthropic, Gemini, and xAI request wire contracts, content-free task runtime, native non-forgeable disclosure, cancellation, exact-draft product caller, and truthful no-live-proof status present',
)
record(
  'adversarial batch authorization is native, scoped, expiring, and non-executing',
  providerTaskRuntimeSource.includes('ProviderAdversarialAuthorizationRequest') &&
    providerTaskRuntimeSource.includes('summed_calls != Some(request.total_remote_calls)') &&
    providerTaskRuntimeSource.includes('BATCH_AUTHORIZATION_LIFETIME') &&
    providerTaskRuntimeSource.includes('MAX_BATCH_AUTHORIZATIONS') &&
    providerTaskRuntimeSource.includes('remote model outputs and review artifacts') &&
    providerTaskRuntimeSource.includes('No credential is read until an authorized call begins') &&
    providerTaskRuntimeSource.includes('random_authorization_id()') &&
    providerTaskRuntimeSource.includes('authorization_id: None') &&
    providerTaskRuntimeSource.includes('revoke_batch_with(&state, &authorization_id)') &&
    platformContractsSource.includes('"providerBatchAuthorization": "native-scoped-authorizer-no-product-executor"'),
  'native dialog derives a bounded route/source/call scope, denial stores nothing, approval expires, explicit revocation exists, and no authorized executor is claimed',
)
record(
  'adversarial batch reservations are atomic, scoped, and still non-executing',
  providerTaskRuntimeSource.includes('fn reserve_batch_call(') &&
    providerTaskRuntimeSource.includes('used_call_ids: HashSet<String>') &&
    providerTaskRuntimeSource.includes('authorization.used_call_ids.contains(&scope.call_id)') &&
    providerTaskRuntimeSource.includes('authorization.remaining_calls -= 1') &&
    providerTaskRuntimeSource.includes('route.remaining_calls -= 1') &&
    providerTaskRuntimeSource.includes('ProviderBatchReservationError::Expired') &&
    providerTaskRuntimeSource.includes('adversarial_batch_reservations_atomically_enforce_scope_ids_and_budgets') &&
    providerTaskRuntimeSource.includes('adversarial_batch_reservation_removes_expired_authority_without_consuming') &&
    platformContractsSource.includes('"providerBatchReservation": "internal-atomic-reservation-no-executor"') &&
    !tauriSource.includes("invoke('provider_adversarial_reserve'") &&
    !providerTaskRuntimeSource.includes('pub async fn provider_adversarial_reserve'),
  'one Rust mutex atomically checks exact run/source/route/call scope, rejects reuse and expiry, decrements route and total budgets, and exposes no public executor command',
)
record(
  'provider research task derives disclosure and provenance',
  providerTaskRuntimeSource.includes('pub struct ProviderResearchTaskRequest') &&
    providerTaskRuntimeSource.includes('pub struct ProviderResearchSource') &&
    providerTaskRuntimeSource.includes('fn build_research_task(') &&
    providerTaskRuntimeSource.includes('"research question".to_owned()') &&
    providerTaskRuntimeSource.includes('"selected source excerpts and labels".to_owned()') &&
    providerTaskRuntimeSource.includes('source_snapshot_ids: Vec<_>') &&
    providerTaskRuntimeSource.includes('source_snapshot_ids.iter().collect::<HashSet<_>>()') &&
    providerTaskRuntimeSource.includes('let request = build_research_task(request)?') &&
    providerResearchRequestSource.includes('export interface ProviderResearchTaskRequest') &&
    tauriSource.includes('export interface ProviderResearchSource') &&
    !providerResearchRequestSource.includes('contentCategories:') &&
    !providerResearchRequestSource.includes('sourceSnapshotIds:') &&
    !providerResearchRequestSource.includes('disclosureAccepted:'),
  'public calls provide structured question/source payloads while Rust derives categories and unique provenance IDs before native disclosure',
)
record(
  'provider credential vault remains isolated',
  (cargoManifestSource.match(/keyring = \{ version = "=3\.6\.3"/g) ?? []).length === 3 &&
    cargoLockSource.includes('name = "keyring"\nversion = "3.6.3"') &&
    cargoManifestSource.includes('zeroize = "1.8.1"') &&
    providerRuntimeSource.includes('impl Drop for ProviderSecret') &&
    providerRuntimeSource.includes('self.0.zeroize()') &&
    credentialVaultSource.includes('org.penumbra.syzygy.model-provider') &&
    credentialVaultSource.includes('RemoteProviderId::Anthropic => "anthropic"') &&
    credentialVaultSource.includes('RemoteProviderId::Gemini => "gemini"') &&
    credentialVaultSource.includes('RemoteProviderId::Xai => "xai"') &&
    credentialVaultSource.includes('keyring::Entry::new') &&
    credentialHarnessSource.includes('cleanupVerified') &&
    platformContractsSource.includes('"credentialVault": "settings-vault-ui"') &&
    rustWiringSource.includes('provider_runtime::provider_credential_set') &&
    rustWiringSource.includes('provider_runtime::provider_credential_status') &&
    rustWiringSource.includes('provider_runtime::provider_credential_delete') &&
    text('frontend/src/tauri.ts').includes("invoke('provider_credential_set'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_generate'"),
  'exact keyring backends, zeroization, sanitized vault, cleanup harness, and typed credential plus native-gated generation commands',
)
record(
  'remote provider settings remain vault-only and non-transmitting',
  text('frontend/src/components/SettingsPanel.tsx').includes('<RemoteProviderSettings />') &&
    providerSettingsSource.includes("{ id: 'openai'") &&
    providerSettingsSource.includes("{ id: 'anthropic'") &&
    providerSettingsSource.includes("{ id: 'gemini'") &&
    providerSettingsSource.includes("{ id: 'xai'") &&
    providerSettingsSource.includes('type="password"') &&
    providerSettingsSource.includes('autoComplete="new-password"') &&
    providerSettingsSource.includes("input.value = ''") &&
    providerSettingsSource.includes('providerCredentialStatus') &&
    providerSettingsSource.includes('providerCredentialSet') &&
    providerSettingsSource.includes('providerCredentialDelete') &&
    providerSettingsSource.includes('desktopRuntimeAvailable') &&
    !providerSettingsSource.includes('providerGenerate') &&
    !providerSettingsSource.includes('localStorage') &&
    !providerSettingsSource.includes('useStore') &&
    !providerSettingsSource.includes('console.'),
  'collapsed settings UI supports four OS-vault credentials, clears password fields, stores no app state, and has no generation authority',
)
const mcpSetupSource = text('frontend/src/components/McpSetupModal.tsx')
record(
  'in-app MCP setup is executable-derived',
  mcpSetupSource.includes('mcpConnectionInfo()') &&
    mcpSetupSource.includes('info.executablePath') &&
    mcpSetupSource.includes('info.connectionPrompt') &&
    text('frontend/src-tauri/src/lib.rs').includes('mcp_setup::mcp_connection_info'),
  'Settings guide uses the typed Rust-generated path, config, and prompt',
)
record(
  'MCP loopback security boundary',
  automationSource.includes('TcpListener::bind(("127.0.0.1", 0))') &&
    automationSource.includes('let mut bytes = [0_u8; 32]') &&
    automationSource.includes('Browser-origin automation requests are not accepted') &&
    automationSource.includes('MAX_BODY_BYTES'),
  'ephemeral IPv4 loopback, 256-bit bearer, origin rejection, bounded body',
)

const lanAgentSource = text('frontend/src-tauri/src/lan_agent.rs')
const lanCoordinatorSource = text('scripts/lan-mcp-coordinator.mjs')
record(
  'LAN MCP control plane remains outbound, authenticated, encrypted, replay-safe, and bounded',
  text('frontend/src-tauri/src/main.rs').includes('"--lan-agent"') &&
    lanAgentSource.includes('.arg("--mcp")') &&
    lanAgentSource.includes('Aes256Gcm') &&
    lanAgentSource.includes('Hkdf::<Sha256>') &&
    lanAgentSource.includes('HmacSha256') &&
    lanAgentSource.includes('MAX_REQUEST_MS: u64 = 60_000') &&
    lanCoordinatorSource.includes("option(options, '--listen', '127.0.0.1')") &&
    lanCoordinatorSource.includes('isPrivateListenAddress') &&
    lanCoordinatorSource.includes('verifyAgentProof') &&
    lanCoordinatorSource.includes('STALE_AFTER_MS') &&
    lanCoordinatorSource.includes("name: 'lan_probe'") &&
    existsSync(join(root, 'scripts/lan-mcp-host.mjs')) &&
    existsSync(join(root, 'scripts/lan-mcp-harness.mjs')) &&
    existsSync(join(root, 'scripts/lan-packaged-agent-harness.mjs')) &&
    existsSync(join(root, 'docs/audits/runs/LAN-MCP-CONTROL-PLANE-2026-07-16.json')),
  'packaged outbound agent preserves loopback GUI ownership; HMAC/HKDF/AES-GCM, replay counters, deadlines, heartbeats, two-node routing, and packaged interoperability evidence are present',
)
const ledger = JSON.parse(text('docs/audits/CAPABILITIES.json'))
const expectedIds = [
  ...Array.from({ length: 35 }, (_, index) => `P-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`),
]
const actualIds = ledger.capabilities.map((item) => item.id)
const uniqueIds = new Set(actualIds)
const allowedStatuses = new Set(['planned', 'implemented_unverified', 'verified', 'blocked_external', 'out_of_scope'])
record(
  'capability ledger coverage',
  expectedIds.every((id) => uniqueIds.has(id)) && uniqueIds.size === actualIds.length,
  `${uniqueIds.size}/${expectedIds.length} unique expected capabilities`,
)
record(
  'capability ledger statuses',
  ledger.capabilities.every((item) => allowedStatuses.has(item.status) && Array.isArray(item.evidence)),
  'statuses and evidence arrays are valid',
)

console.log(JSON.stringify({ passed: failures.length === 0, checks, failures }, null, 2))
if (failures.length) process.exit(1)
