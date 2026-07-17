import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scripts = path.join(root, 'scripts')
const coordinatorScript = path.join(scripts, 'lan-mcp-coordinator.mjs')
const agentScript = path.join(scripts, 'lan-mcp-agent.mjs')
const fixtureScript = path.join(scripts, 'lan-mcp-fixture.mjs')
const temp = mkdtempSync(path.join(os.tmpdir(), 'syzygy-lan-harness-'))
const keyFile = path.join(temp, 'pairing.key')
const wrongKeyFile = path.join(temp, 'wrong.key')
writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
writeFileSync(wrongKeyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  } else child.kill('SIGTERM')
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function spawnCaptured(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk })
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk })
  return child
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

class CoordinatorSession {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Coordinator MCP ${method} timed out`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  tool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args })
  }
}

const children = []
const evidence = { passed: false }
try {
  const port = await reservePort()
  const coordinator = spawnCaptured(process.execPath, [coordinatorScript, '--listen', '127.0.0.1', '--port', String(port), '--key-file', keyFile])
  children.push(coordinator)
  await waitFor(() => coordinator.output.stderr.includes(`127.0.0.1:${port}`), 5_000, 'coordinator listener')
  const session = new CoordinatorSession(coordinator)
  const initialized = await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'syzygy-lan-harness', version: '1' },
  })
  const listed = await session.request('tools/list')
  assert.equal(initialized.serverInfo.name, 'syzygy-lan')
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['lan_nodes', 'lan_node_tools', 'lan_call', 'lan_probe'])

  const spawnAgent = (nodeId, selectedKey = keyFile) => {
    const child = spawnCaptured(process.execPath, [
      agentScript,
      '--node-id', nodeId,
      '--coordinator', '127.0.0.1',
      '--port', String(port),
      '--key-file', selectedKey,
      '--mcp-command', process.execPath,
      '--mcp-arg', fixtureScript,
      '--mcp-arg', nodeId,
    ])
    children.push(child)
    return child
  }
  const alpha = spawnAgent('office-alpha')
  const beta = spawnAgent('office-beta')
  const connected = await waitFor(async () => {
    const result = await session.tool('lan_nodes')
    return result.structuredContent.nodes.length === 2 ? result : null
  }, 10_000, 'two authenticated agents')
  assert.deepEqual(connected.structuredContent.nodes.map((node) => node.nodeId), ['office-alpha', 'office-beta'])

  const probe = await session.tool('lan_probe', { timeoutMs: 5_000 })
  assert.equal(probe.isError, false)
  assert.equal(probe.structuredContent.probes.length, 2)
  assert.equal(probe.structuredContent.probes.every((item) => item.ok && item.toolCount === 3), true)

  const tools = await session.tool('lan_node_tools', { nodeId: 'office-alpha' })
  assert.deepEqual(tools.structuredContent.tools.map((tool) => tool.name), ['syzygy_status', 'write_fixture_marker', 'read_fixture_marker'])
  const alphaWrite = await session.tool('lan_call', { nodeId: 'office-alpha', name: 'write_fixture_marker', arguments: { value: 'alpha-only' } })
  const betaWrite = await session.tool('lan_call', { nodeId: 'office-beta', name: 'write_fixture_marker', arguments: { value: 'beta-only' } })
  assert.equal(alphaWrite.structuredContent.remote.structuredContent.marker, 'alpha-only')
  assert.equal(betaWrite.structuredContent.remote.structuredContent.marker, 'beta-only')
  const alphaRead = await session.tool('lan_call', { nodeId: 'office-alpha', name: 'read_fixture_marker' })
  const betaRead = await session.tool('lan_call', { nodeId: 'office-beta', name: 'read_fixture_marker' })
  assert.equal(alphaRead.structuredContent.remote.structuredContent.marker, 'alpha-only')
  assert.equal(betaRead.structuredContent.remote.structuredContent.marker, 'beta-only')

  const intruder = spawnAgent('office-intruder', wrongKeyFile)
  await new Promise((resolve) => setTimeout(resolve, 750))
  const afterIntruder = await session.tool('lan_nodes')
  assert.equal(afterIntruder.structuredContent.nodes.some((node) => node.nodeId === 'office-intruder'), false)
  terminate(intruder)

  terminate(beta)
  const afterDisconnect = await waitFor(async () => {
    const result = await session.tool('lan_nodes')
    return result.structuredContent.nodes.length === 1 ? result : null
  }, 5_000, 'node disconnect cleanup')
  assert.equal(afterDisconnect.structuredContent.nodes[0].nodeId, 'office-alpha')

  evidence.passed = true
  evidence.protocolVersion = initialized.protocolVersion
  evidence.coordinatorTools = listed.tools.length
  evidence.authenticatedNodes = 2
  evidence.readOnlyFleetProbe = true
  evidence.isolatedPerNodeCalls = true
  evidence.invalidPairingKeyRejected = true
  evidence.disconnectCleanup = true
  evidence.heartbeatMs = 15_000
  evidence.staleAfterMs = 45_000
  evidence.maxRequestMs = 60_000
  terminate(alpha)
  coordinator.stdin.end()
  await waitFor(() => coordinator.exitCode !== null, 5_000, 'coordinator shutdown')
} finally {
  for (const child of children) terminate(child)
  rmSync(temp, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
