import { spawn, spawnSync } from 'node:child_process'

function terminateProcessTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child.kill('SIGTERM')
  }
}

export class LocalMcpSession {
  constructor(command, args, { requestTimeoutMs = 20_000 } = {}) {
    this.requestTimeoutMs = requestTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.buffer = ''
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_192) })
    this.child.stdout.on('data', (chunk) => this.consume(chunk))
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('exit', (code, signal) => {
        const error = new Error(`local Syzygy MCP exited (${code ?? signal ?? 'unknown'})`)
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer)
          waiter.reject(error)
        }
        this.pending.clear()
        resolve({ code, signal })
      })
    })
  }

  consume(chunk) {
    this.buffer += chunk
    if (this.buffer.length > 12 * 1024 * 1024) {
      this.failAll(new Error('local Syzygy MCP response exceeded the size limit'))
      terminateProcessTree(this.child)
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.failAll(new Error('local Syzygy MCP emitted invalid JSON'))
        terminateProcessTree(this.child)
        return
      }
      const waiter = this.pending.get(message.id)
      if (!waiter) continue
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'local MCP request failed'))
      else waiter.resolve(message.result)
    }
  }

  failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.child.exitCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(new Error('local Syzygy MCP is not running'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`local Syzygy MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method, params = {}) {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    }
  }

  async initialize(clientName) {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    })
    this.notify('notifications/initialized')
    return result
  }

  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    const graceful = await Promise.race([
      this.closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ])
    if (!graceful) terminateProcessTree(this.child)
    await this.closed
  }
}
