import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const manifest = path.join(frontend, 'src-tauri', 'Cargo.toml')
const executable = path.join(
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
    id: 4,
    method: 'tools/call',
    params: { name: 'syzygy_status', arguments: {} },
  })
  child.stdin.end()

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (exitCode !== 0) throw new Error(`embedded MCP exited ${exitCode}: ${stderr}`)

  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(messages.map((message) => [message.id, message]))
  if (messages.length !== 4) throw new Error(`expected 4 MCP responses, received ${messages.length}`)
  if (byId.get(1)?.result?.protocolVersion !== '2025-11-25') throw new Error('MCP version negotiation failed')
  const tools = byId.get(2)?.result?.tools
  if (!Array.isArray(tools) || tools.length < 10) throw new Error('MCP tool discovery is incomplete')
  if (!tools.some((tool) => tool.name === 'workspace_walkthrough')) throw new Error('walkthrough tool is missing')
  if (JSON.stringify(byId.get(3)?.result) !== '{}') throw new Error('MCP ping failed')
  if (typeof byId.get(4)?.result?.isError !== 'boolean') throw new Error('live status tool result is malformed')

  return {
    protocolVersion: byId.get(1).result.protocolVersion,
    toolCount: tools.length,
    notificationProducedNoResponse: true,
    liveStatusResultWasTyped: true,
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
run('cargo', ['build', '--manifest-path', manifest, '--bin', 'app'], frontend)

const stdio = await proveStdioContract()
process.stdout.write(`${JSON.stringify({ passed: true, frontendEditorContract: true, rustBridgeContract: true, rustMcpRouting: true, stdio }, null, 2)}\n`)
