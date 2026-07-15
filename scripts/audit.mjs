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
  'exact-head atomic commit, bounded lineage verification, restore-as-new-child, retained concurrent branches, 40 delivery orders, pure deterministic diff/note, and truthful P-28/P-29 statuses are present',
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
  'save_active_policy_version',
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
  automationRegistrySource.includes('if (documents.get(projectId) === doc) documents.delete(projectId)') &&
    text('frontend/src/workspace/localProvider.ts').includes('registerAutomationProjectDocument(this.projectId, this.doc)') &&
    text('frontend/src/automationBridge.ts').includes("case 'project.readResearchState'") &&
    researchInspectionSource.includes('MAX_RETURNED_ITEMS = 200') &&
    researchInspectionSource.includes('readPolicyVersionLineage') &&
    researchInspectionSource.includes('countInvalidLineages') &&
    researchInspectionSource.includes('policy text, heuristic guidance, edit values, and notes are omitted') &&
    researchInspectionTestSource.includes('Secret guidance is omitted') &&
    researchInspectionTestSource.includes("not.toContain('Secret policy text')") &&
    researchInspectionTestSource.includes('reports a tampered version and invalid head lineage') &&
    researchInspectionTestSource.includes('content-valid non-head record whose ancestor is missing') &&
    mcpSource.includes('"inspect_research_state" => live("project.readResearchState"') &&
    text('scripts/mcp-live-harness.mjs').includes('researchStateHealthy: true'),
  'identity-safe live Y.Doc registry, 200-item metadata caps, secret-body canaries, tamper/head/lineage self-checks, read-only MCP routing, and packaged-live assertion are present',
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
    platformContractsSource.includes('"remoteProviderAdapters": "native-disclosure-command-no-product-ui"') &&
    platformContractsSource.includes('"providerTaskRuntime": "native-disclosure-research-envelope"') &&
    providerTaskRuntimeSource.includes('"executionMode": execution_mode') &&
    text('frontend/src/tauri.ts').includes("invoke('provider_generate'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_cancel'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_authorize'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_revoke'") &&
    text('frontend/src/tauri.ts').includes("invoke('provider_adversarial_authorization_status'") &&
    !text('frontend/src/tauri.ts').includes('disclosureAccepted') &&
    text('frontend/src-tauri/src/bin/provider-runtime-harness.rs').includes('interop-secret-canary'),
  'OpenAI request/stream plus Anthropic, Gemini, and xAI request wire contracts, content-free task runtime, native non-forgeable disclosure, cancellation, typed command wiring, and truthful no-product-UI status present',
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

const ledger = JSON.parse(text('docs/audits/CAPABILITIES.json'))
const expectedIds = [
  ...Array.from({ length: 35 }, (_, index) => `P-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`),
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
