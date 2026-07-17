import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableFlag = process.argv.indexOf('--executable')
const executable = executableFlag >= 0
  ? path.resolve(process.argv[executableFlag + 1])
  : path.join(root, 'frontend', 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'app.exe' : 'app')
const coordinatorScript = path.join(root, 'scripts', 'lan-mcp-coordinator.mjs')
const temp = mkdtempSync(path.join(os.tmpdir(), 'syzygy-lan-packaged-'))
const keyFile = path.join(temp, 'pairing.key')
writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })

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

function captured(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.output = { stderr: '' }
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk })
  return child
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

class Session {
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
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Coordinator ${method} timed out`))
      }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  tool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args })
  }
}

const children = []
try {
  const port = await reservePort()
  const coordinator = captured(process.execPath, [coordinatorScript, '--listen', '127.0.0.1', '--port', String(port), '--key-file', keyFile])
  children.push(coordinator)
  await waitFor(() => coordinator.output.stderr.includes(`127.0.0.1:${port}`), 5_000, 'coordinator')
  const session = new Session(coordinator)
  await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'syzygy-packaged-lan-harness', version: '1' },
  })
  const agent = captured(executable, [
    '--lan-agent',
    '--node-id', 'packaged-office',
    '--coordinator', '127.0.0.1',
    '--port', String(port),
    '--key-file', keyFile,
  ])
  children.push(agent)
  const nodes = await waitFor(async () => {
    const result = await session.tool('lan_nodes')
    return result.structuredContent.nodes.length === 1 ? result : null
  }, 15_000, 'packaged agent connection')
  assert.equal(nodes.structuredContent.nodes[0].nodeId, 'packaged-office')
  assert.equal(nodes.structuredContent.nodes[0].metadata.packagedAgent, true)
  const tools = await session.tool('lan_node_tools', { nodeId: 'packaged-office', timeoutMs: 10_000 })
  assert.equal(tools.isError, false)
  assert.equal(tools.structuredContent.tools.length >= 25, true)
  const installation = await session.tool('lan_call', {
    nodeId: 'packaged-office',
    name: 'syzygy_installation',
    arguments: {},
    timeoutMs: 10_000,
  })
  assert.equal(installation.isError, false)
  assert.equal(path.isAbsolute(installation.structuredContent.remote.structuredContent.executablePath), true)
  process.stdout.write(`${JSON.stringify({
    passed: true,
    executable,
    packagedAgentAuthenticated: true,
    crossLanguageEncryption: true,
    toolCount: tools.structuredContent.tools.length,
    installationSelfDescription: true,
  }, null, 2)}\n`)
  terminate(agent)
  coordinator.stdin.end()
  await waitFor(() => coordinator.exitCode !== null, 5_000, 'coordinator shutdown')
} finally {
  for (const child of children) terminate(child)
  rmSync(temp, { recursive: true, force: true })
}
