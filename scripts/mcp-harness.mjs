import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const manifest = path.join(frontend, 'src-tauri', 'Cargo.toml')
const executableFlag = process.argv.indexOf('--executable')
const suppliedExecutable = executableFlag >= 0 ? path.resolve(process.argv[executableFlag + 1]) : null
const executable = suppliedExecutable ?? path.join(
    frontend,
    'src-tauri',
    'target',
    'debug',
    process.platform === 'win32' ? 'app.exe' : 'app',
  )

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function writeMessage(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

async function proveStdioContract() {
  const child = spawn(executable, ['--mcp'], {
    cwd: frontend,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  writeMessage(child, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'syzygy-headless-harness', version: '1' },
    },
  })
  writeMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' })
  writeMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  writeMessage(child, { jsonrpc: '2.0', id: 3, method: 'ping', params: {} })
  writeMessage(child, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'syzygy_installation', arguments: {} },
  })
  writeMessage(child, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'syzygy_status', arguments: {} },
  })
  writeMessage(child, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'syzygy_platform_contracts', arguments: {} },
  })
  child.stdin.end()

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (exitCode !== 0) throw new Error(`embedded MCP exited ${exitCode}: ${stderr}`)

  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(messages.map((message) => [message.id, message]))
  if (messages.length !== 6) throw new Error(`expected 6 MCP responses, received ${messages.length}`)
  if (byId.get(1)?.result?.protocolVersion !== '2025-11-25') throw new Error('MCP version negotiation failed')
  const tools = byId.get(2)?.result?.tools
  if (!Array.isArray(tools) || tools.length < 12) throw new Error('MCP tool discovery is incomplete')
  if (!tools.some((tool) => tool.name === 'workspace_walkthrough')) throw new Error('walkthrough tool is missing')
  if (JSON.stringify(byId.get(3)?.result) !== '{}') throw new Error('MCP ping failed')
  if (typeof byId.get(4)?.result?.isError !== 'boolean') throw new Error('live status tool result is malformed')
  const installation = byId.get(5)?.result?.structuredContent
  if (byId.get(5)?.result?.isError !== false) throw new Error('installation tool failed without a live GUI')
  if (!path.isAbsolute(installation?.executablePath ?? '')) throw new Error('installation tool did not return an absolute executable path')
  if (!path.isAbsolute(installation?.installFolder ?? '')) throw new Error('installation tool did not return an absolute install folder')
  if (!installation?.genericJson?.includes('--mcp')) throw new Error('installation tool did not generate MCP configuration')
  if (!installation?.connectionPrompt?.includes(installation.executablePath)) throw new Error('connection prompt omitted the detected executable')
  const contracts = byId.get(6)?.result?.structuredContent
  if (byId.get(6)?.result?.isError !== false) throw new Error('platform contracts tool failed without a live GUI')
  if (contracts?.contractVersion !== 1) throw new Error('platform contract version is missing')
  if (contracts?.implementationStatus?.pluginLoader !== 'contract-only') throw new Error('plugin loader status is overstated')
  if (contracts?.pluginManifestSchema?.additionalProperties !== false) throw new Error('plugin manifest schema is not strict')
  if (contracts?.providerRunRecordSchema?.additionalProperties !== false) throw new Error('provider run schema is not strict')
  if (contracts?.implementationStatus?.providerRunRecordValidator !== 'implemented') throw new Error('provider run validator status is missing')
  if (contracts?.modelAdapterProfileSchema?.additionalProperties !== false) throw new Error('model adapter schema is not strict')
  if (contracts?.implementationStatus?.modelAdapterCertifier !== 'contract-certified-runner') throw new Error('model adapter certifier status is overstated')
  if (contracts?.implementationStatus?.providerTaskRuntime !== 'native-disclosure-command') throw new Error('provider task runtime status is inaccurate')
  if (contracts?.providerRunRecordSchema?.properties?.executionMode?.enum?.includes('loopback-conformance') !== true) throw new Error('provider run schema omits honest conformance mode')
  if (contracts?.implementationStatus?.remoteProviderAdapters !== 'native-disclosure-command-no-product-ui') throw new Error('aggregate provider status is inaccurate')
  if (contracts?.implementationStatus?.credentialVault !== 'tauri-command-ui-open') throw new Error('credential vault status is inaccurate')

  return {
    executable,
    protocolVersion: byId.get(1).result.protocolVersion,
    appVersion: installation.appVersion,
    toolCount: tools.length,
    notificationProducedNoResponse: true,
    liveStatusResultWasTyped: true,
    installationDetailsWereSelfDescribing: true,
    platformContractsWereSelfDescribing: true,
    stderrWasProtocolClean: stderr.trim().length === 0,
  }
}

run(process.execPath, [
  path.join(frontend, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  'src/workspace/editorAutomation.test.ts',
  '--reporter=verbose',
], frontend)
run('cargo', ['test', '--manifest-path', manifest, 'automation::tests'], frontend)
run('cargo', ['test', '--manifest-path', manifest, 'mcp::tests'], frontend)
run('cargo', ['test', '--manifest-path', manifest, 'platform_contracts::tests'], frontend)
if (!suppliedExecutable) run('cargo', ['build', '--manifest-path', manifest, '--bin', 'app'], frontend)

const stdio = await proveStdioContract()
process.stdout.write(`${JSON.stringify({ passed: true, frontendEditorContract: true, rustBridgeContract: true, rustMcpRouting: true, stdio }, null, 2)}\n`)
