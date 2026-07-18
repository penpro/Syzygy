import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = path.dirname(fileURLToPath(import.meta.url))
const coordinatorScript = path.join(scripts, 'lan-mcp-coordinator.mjs')
const attachScript = path.join(scripts, 'lan-mcp-attach.mjs')
const hostScript = path.join(scripts, 'lan-mcp-host.mjs')

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else child.kill('SIGTERM')
}

function spawnCaptured(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk })
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk })
  return child
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

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

class McpSession {
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
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Attached MCP ${method} timed out`))
      }, 5_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

test('developer coordinator authenticates its MCP attachment and releases both listeners', { timeout: 15_000 }, async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'syzygy-lan-dev-mode-'))
  const keyFile = path.join(temp, 'pairing.key')
  const wrongKeyFile = path.join(temp, 'wrong.key')
  writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
  writeFileSync(wrongKeyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
  const children = []
  try {
    const port = await reservePort()
    let controlPort = await reservePort()
    while (controlPort === port) controlPort = await reservePort()
    const coordinator = spawnCaptured(coordinatorScript, [
      '--listen', '127.0.0.1',
      '--port', String(port),
      '--control-port', String(controlPort),
      '--key-file', keyFile,
    ])
    children.push(coordinator)
    await waitFor(
      () => coordinator.output.stderr.includes(`control attachment listening on 127.0.0.1:${controlPort}`),
      5_000,
      'app-owned coordinator listeners',
    )

    const intruder = spawnCaptured(attachScript, [
      '--host', '127.0.0.1',
      '--control-port', String(controlPort),
      '--key-file', wrongKeyFile,
    ])
    children.push(intruder)
    await waitFor(() => intruder.exitCode !== null, 5_000, 'invalid attachment rejection')
    assert.notEqual(intruder.exitCode, 0)

    const attachment = spawnCaptured(hostScript, [
      '--listen', '127.0.0.1',
      '--port', String(port),
      '--control-port', String(controlPort),
      '--key-file', keyFile,
      '--local-executable', process.execPath,
      '--local-node-id', 'test-primary',
    ])
    children.push(attachment)
    const session = new McpSession(attachment)
    const initialized = await session.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'syzygy-lan-dev-mode-test', version: '1' },
    })
    const listed = await session.request('tools/list')
    assert.equal(initialized.serverInfo.name, 'syzygy-lan')
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'lan_nodes',
      'lan_node_tools',
      'lan_call',
      'lan_probe',
    ])

    attachment.stdin.end()
    await waitFor(() => attachment.exitCode !== null, 5_000, 'host attachment shutdown')
    assert.equal(coordinator.exitCode, null)
    assert.equal(await canConnect(port), true)
    assert.equal(await canConnect(controlPort), true)

    coordinator.stdin.end()
    await waitFor(() => coordinator.exitCode !== null, 5_000, 'coordinator shutdown')
    assert.equal(await canConnect(port), false)
    assert.equal(await canConnect(controlPort), false)
  } finally {
    for (const child of children) terminate(child)
    rmSync(temp, { recursive: true, force: true })
  }
})
