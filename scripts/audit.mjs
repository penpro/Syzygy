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
const pluginManifestSchema = JSON.parse(text('docs/schemas/syzygy-research-plugin-v1.schema.json'))
const pluginProposalSchema = JSON.parse(text('docs/schemas/syzygy-plugin-proposal-v1.schema.json'))
const platformContractsSource = text('frontend/src-tauri/src/platform_contracts.rs')
const providerRuntimeSource = text('frontend/src-tauri/src/model_provider.rs')
const credentialVaultSource = text('frontend/src-tauri/src/credential_vault.rs')
const credentialHarnessSource = text('frontend/src-tauri/src/bin/credential-harness.rs')
const cargoManifestSource = text('frontend/src-tauri/Cargo.toml')
const cargoLockSource = text('frontend/src-tauri/Cargo.lock')
const rustWiringSource = text('frontend/src-tauri/src/lib.rs')
record(
  'research extension contracts',
  pluginManifestSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    pluginManifestSchema.additionalProperties === false &&
    pluginProposalSchema.additionalProperties === false &&
    platformContractsSource.includes('"pluginLoader": "contract-only"') &&
    platformContractsSource.includes('"automaticSharedMutation": false'),
  'strict v1 schemas, honest runtime status, and proposal-only shared mutation',
)
record(
  'remote provider boundary remains gated',
  providerRuntimeSource.includes('"store": false') &&
    providerRuntimeSource.includes('validate_for(RemoteProviderId::OpenAi)') &&
    providerRuntimeSource.includes('MAX_RESPONSE_BYTES') &&
    providerRuntimeSource.includes('endpoint.scheme() == "https"') &&
    platformContractsSource.includes('OPENAI_ADAPTER_STATUS') &&
    platformContractsSource.includes('"remoteProviderAdapters": "contract-only"') &&
    !rustWiringSource.includes('model_provider::execute_openai_response'),
  'storage-off, disclosure, TLS, bounded-response, truthful-status, and unwired-runtime gates present',
)
record(
  'provider credential vault remains isolated',
  (cargoManifestSource.match(/keyring = \{ version = "=3\.6\.3"/g) ?? []).length === 3 &&
    cargoLockSource.includes('name = "keyring"\nversion = "3.6.3"') &&
    cargoManifestSource.includes('zeroize = "1.8.1"') &&
    providerRuntimeSource.includes('impl Drop for ProviderSecret') &&
    providerRuntimeSource.includes('self.0.zeroize()') &&
    credentialVaultSource.includes('org.penumbra.syzygy.model-provider') &&
    credentialVaultSource.includes('keyring::Entry::new') &&
    credentialHarnessSource.includes('cleanupVerified') &&
    platformContractsSource.includes('"credentialVault": "implemented-unverified"') &&
    !rustWiringSource.includes('credential_vault::'),
  'exact keyring backends, zeroization, sanitized vault, cleanup harness, truthful status, and no Tauri command',
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
