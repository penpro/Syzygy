import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const writeProof = process.argv.includes('--write-proof')
const executableFlag = process.argv.indexOf('--executable')
const executable = executableFlag >= 0
  ? path.resolve(process.argv[executableFlag + 1])
  : path.join(frontend, 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'Syzygy.exe' : 'Syzygy')

if (!existsSync(executable)) {
  throw new Error(`Syzygy executable not found at ${executable}. Build it first or pass --executable <path>.`)
}

class McpSession {
  constructor(command) {
    this.child = spawn(command, ['--mcp'], {
      cwd: path.dirname(command),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.buffer = ''
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('exit', resolve)
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.child.once('exit', (code) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`Syzygy MCP exited ${code}: ${this.stderr}`))
      }
      this.pending.clear()
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (!waiter) throw new Error(`Unexpected MCP response ID ${message.id}`)
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async tool(name, args = {}, allowError = false) {
    const result = await this.request('tools/call', { name, arguments: args })
    if (result.isError && !allowError) {
      throw new Error(result.structuredContent?.error ?? `${name} failed`)
    }
    return result
  }

  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    const code = await this.closed
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    if (code !== 0) throw new Error(`Syzygy MCP exited ${code}: ${this.stderr}`)
  }
}

const session = new McpSession(executable)
const evidence = { passed: false, executable, writeProof }
try {
  const initialized = await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'syzygy-live-harness', version: '1' },
  })
  session.notify('notifications/initialized')
  evidence.protocolVersion = initialized.protocolVersion

  let status = await session.tool('syzygy_status', {}, true)
  if (status.isError) {
    await session.tool('launch_syzygy')
    status = await session.tool('syzygy_status')
  }
  evidence.appVersion = status.structuredContent.version
  evidence.editorReadyBefore = status.structuredContent.editorReady

  const walkthrough = await session.tool('workspace_walkthrough')
  const projects = await session.tool('list_projects')
  evidence.walkthroughSteps = walkthrough.structuredContent.steps.length
  evidence.projectCountBefore = projects.structuredContent.projects.length

  if (writeProof) {
    const proofTitle = 'MCP pilot — revision-safe policy walkthrough'
    const existing = projects.structuredContent.projects.find((project) => !project.archivedAt && project.title === proofTitle)
    const created = existing
      ? await session.tool('open_project', { projectId: existing.id })
      : await session.tool('create_project', { title: proofTitle })
    const projectId = created.structuredContent.project.id
    const starterRevision = created.structuredContent.document.revision
    const replaced = await session.tool('replace_active_document', {
      expectedRevision: starterRevision,
      content: [
        '# Community research access policy',
        '## Rule',
        'Research materials may be edited by collaborators who record the purpose of each change.',
        '## Rationale',
        'A visible reason makes review easier without requiring a hosted editor service.',
        '> Proposed changes remain reviewable evidence until a person accepts them.',
      ].join('\n'),
    })
    const replacedRevision = replaced.structuredContent.document.revision
    const appended = await session.tool('append_active_document', {
      expectedRevision: replacedRevision,
      content: '## Testable example\nA collaborator adds a source and records why it changes the draft.',
    })
    const staleWrite = await session.tool('replace_active_document', {
      expectedRevision: starterRevision,
      content: 'This stale write must not land.',
    }, true)
    if (!staleWrite.isError || !/Revision conflict/.test(staleWrite.structuredContent?.error ?? '')) {
      throw new Error('The live app did not reject the stale MCP write')
    }
    const readback = await session.tool('read_active_project')
    if (readback.structuredContent.project.id !== projectId) throw new Error('Live project identity changed')
    if (!readback.structuredContent.document.text.includes('Testable example')) throw new Error('Live append was not readable')
    if (readback.structuredContent.document.text.includes('stale write')) throw new Error('Stale write reached the live draft')
    evidence.write = {
      projectId,
      reusedProject: !!existing,
      starterRevision,
      replacedRevision,
      finalRevision: appended.structuredContent.document.revision,
      finalBlockCount: readback.structuredContent.document.blocks.length,
      staleWriteRejected: true,
    }
  }
  evidence.passed = true
} finally {
  await session.close()
}

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
