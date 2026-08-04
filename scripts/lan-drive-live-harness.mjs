import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  integerOption,
  option,
  parseCli,
  requiredOption,
} from './lan-bridge-protocol.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseCli(process.argv.slice(2))
const listen = requiredOption(options, '--listen')
const port = integerOption(options, '--port', DEFAULT_PORT, { max: 65_535 })
const keyFile = path.resolve(requiredOption(options, '--key-file'))
const localExecutable = path.resolve(requiredOption(options, '--local-executable'))
const primaryNode = option(options, '--primary-node', 'office-primary')
const secondaryNode = option(options, '--secondary-node', 'office-secondary')
const mutate = options.has('--mutate')
const proofTitle = option(options, '--proof-title', 'Syzygy live collaboration proof')
const absoluteDeadline = Date.now() + 5 * 60_000

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  } else child.kill('SIGTERM')
}

function spawnCaptured(command, args) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.output = { stderr: '' }
  child.stderr.on('data', (chunk) => {
    child.output.stderr += chunk
    process.stderr.write(chunk)
  })
  return child
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
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
      }
    })
  }

  request(method, params = {}, timeoutMs = 20_000) {
    if (Date.now() >= absoluteDeadline) return Promise.reject(new Error('Live harness absolute deadline elapsed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LAN MCP ${method} timed out after ${timeoutMs}ms`))
      }, Math.min(timeoutMs, 60_000))
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  tool(name, args = {}, timeoutMs = 20_000) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }
}

async function waitFor(action, predicate, timeoutMs, label) {
  const deadline = Math.min(Date.now() + timeoutMs, absoluteDeadline)
  let nextHeartbeat = Date.now() + 15_000
  let last
  while (Date.now() < deadline) {
    last = await action()
    if (predicate(last)) return last
    if (Date.now() >= nextHeartbeat) {
      process.stderr.write(`[syzygy-lan-drive-live] waiting for ${label}\n`)
      nextHeartbeat = Date.now() + 15_000
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for ${label}${last ? '' : ' (no response)'}`)
}

function remoteResult(result, label) {
  if (result?.isError) throw new Error(`${label} failed at the LAN coordinator`)
  const remote = result?.structuredContent?.remote
  if (!remote || remote.isError) {
    const detail = remote?.structuredContent?.error ?? remote?.content?.[0]?.text ?? 'unknown remote failure'
    throw new Error(`${label} failed: ${detail}`)
  }
  return remote.structuredContent
}

async function lanCall(session, nodeId, name, args = {}, timeoutMs = 20_000) {
  return remoteResult(await session.tool('lan_call', {
    nodeId,
    name,
    arguments: args,
    timeoutMs,
  }, timeoutMs + 2_000), `${nodeId}:${name}`)
}

async function optionalLanCall(session, nodeId, name, args = {}, timeoutMs = 20_000) {
  try {
    return await lanCall(session, nodeId, name, args, timeoutMs)
  } catch {
    return null
  }
}

function driveProjects(list) {
  return list.projects.filter((project) => !project.archivedAt && project.transport?.kind === 'drive')
}

async function ensureProofProject(session) {
  let primaryList = await lanCall(session, primaryNode, 'list_projects')
  let project = primaryList.projects.find((candidate) => !candidate.archivedAt && candidate.title === proofTitle)
  if (!project) {
    const created = await lanCall(session, primaryNode, 'create_project', { title: proofTitle })
    project = created.project
  } else {
    await lanCall(session, primaryNode, 'open_project', { projectId: project.id })
  }

  let primaryRead = await lanCall(session, primaryNode, 'read_active_project')
  let descriptor
  if (project.transport.kind === 'local') {
    const shared = await lanCall(session, primaryNode, 'share_active_project', {
      expectedDocumentRevision: primaryRead.document.revision,
    }, 40_000)
    project = shared.project
    descriptor = shared.descriptor
  } else {
    const catalog = await lanCall(session, primaryNode, 'list_shared_projects', {}, 40_000)
    descriptor = catalog.catalog.projects.find((candidate) =>
      candidate.projectId === project.id && candidate.documentId === project.documentId)
    if (!descriptor) throw new Error('The proof project is Drive-bound locally but absent from the fresh catalog')
  }

  const secondaryList = await lanCall(session, secondaryNode, 'list_projects')
  const secondaryProject = secondaryList.projects.find((candidate) =>
    candidate.id === descriptor.projectId && candidate.documentId === descriptor.documentId)
  if (secondaryProject) {
    await lanCall(session, secondaryNode, 'open_project', { projectId: secondaryProject.id }, 40_000)
  } else {
    await lanCall(session, secondaryNode, 'join_shared_project', {
      projectId: descriptor.projectId,
      documentId: descriptor.documentId,
      workspaceId: descriptor.workspaceId,
    }, 60_000)
  }
  primaryRead = await lanCall(session, primaryNode, 'read_active_project')
  return { project, descriptor, primaryRead }
}

const host = spawnCaptured(process.execPath, [
  path.join(root, 'scripts', 'lan-mcp-host.mjs'),
  '--listen', listen,
  '--port', String(port),
  '--key-file', keyFile,
  '--local-executable', localExecutable,
  '--local-node-id', primaryNode,
])

const evidence = {
  passed: false,
  mode: mutate ? 'two-way-mutation' : 'read-only-probe',
  authenticatedNodes: 0,
  exactSharedIdentity: false,
  primaryToSecondary: false,
  secondaryToPrimary: false,
  concurrentMerge: false,
  staleRevisionRejected: false,
  scenarioPrimaryToSecondary: false,
  scenarioSiblingMerge: false,
  scenarioCurrentConverged: false,
  scenarioStaleRevisionRejected: false,
}

try {
  const session = new McpSession(host)
  await session.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'syzygy-lan-drive-live-harness', version: '1' },
  })

  const nodes = await waitFor(
    () => session.tool('lan_nodes'),
    (result) => {
      const ids = result.structuredContent.nodes.map((node) => node.nodeId)
      return ids.includes(primaryNode) && ids.includes(secondaryNode)
    },
    60_000,
    'both authenticated physical installations',
  )
  evidence.authenticatedNodes = nodes.structuredContent.nodes.length

  const probe = await session.tool('lan_probe', { timeoutMs: 20_000 }, 25_000)
  assert.equal(probe.isError, false)
  const selectedProbes = probe.structuredContent.probes.filter((item) =>
    item.nodeId === primaryNode || item.nodeId === secondaryNode)
  assert.equal(selectedProbes.length, 2)
  assert.equal(selectedProbes.every((item) => item.ok && item.toolCount >= 35), true)

  if (!mutate) {
    const [primary, secondary] = await Promise.all([
      lanCall(session, primaryNode, 'list_projects'),
      lanCall(session, secondaryNode, 'list_projects'),
    ])
    const secondaryKeys = new Set(driveProjects(secondary).map((project) => `${project.id}:${project.documentId}`))
    evidence.exactSharedIdentity = driveProjects(primary)
      .some((project) => secondaryKeys.has(`${project.id}:${project.documentId}`))
    evidence.passed = true
  } else {
    const { project, primaryRead } = await ensureProofProject(session)
    const runId = `run-${Date.now().toString(36)}`
    const baseline = `# Syzygy two-install collaboration proof\n\nBaseline ${runId}`
    const reset = await lanCall(session, primaryNode, 'replace_active_document', {
      expectedRevision: primaryRead.document.revision,
      content: baseline,
    })

    const secondaryBaseline = await waitFor(
      () => lanCall(session, secondaryNode, 'read_active_project'),
      (value) => value.project.id === project.id && value.document.text.includes(`Baseline ${runId}`),
      45_000,
      'primary edit on the secondary installation',
    )
    evidence.primaryToSecondary = true
    evidence.exactSharedIdentity = secondaryBaseline.project.id === project.id
      && secondaryBaseline.project.documentId === project.documentId

    const primaryAtBaseline = await lanCall(session, primaryNode, 'read_active_project')
    const markerA = `Primary contribution ${runId}`
    const markerB = `Secondary contribution ${runId}`
    const [primaryAppend, secondaryAppend] = await Promise.all([
      lanCall(session, primaryNode, 'append_active_document', {
        expectedRevision: primaryAtBaseline.document.revision,
        content: markerA,
      }),
      lanCall(session, secondaryNode, 'append_active_document', {
        expectedRevision: secondaryBaseline.document.revision,
        content: markerB,
      }),
    ])
    assert.ok(primaryAppend.document.revision)
    assert.ok(secondaryAppend.document.revision)

    const converged = await waitFor(
      async () => Promise.all([
        lanCall(session, primaryNode, 'read_active_project'),
        lanCall(session, secondaryNode, 'read_active_project'),
      ]),
      ([primary, secondary]) =>
        primary.document.text.includes(markerA)
        && primary.document.text.includes(markerB)
        && secondary.document.text.includes(markerA)
        && secondary.document.text.includes(markerB)
        && primary.document.text === secondary.document.text,
      60_000,
      'two-way Yjs convergence',
    )
    evidence.secondaryToPrimary = converged[0].document.text.includes(markerB)
    evidence.concurrentMerge = converged[0].document.text === converged[1].document.text

    try {
      await lanCall(session, primaryNode, 'append_active_document', {
        expectedRevision: reset.document.revision,
        content: `stale-write-must-not-land-${runId}`,
      })
    } catch {
      evidence.staleRevisionRejected = true
    }
    const finalRead = await lanCall(session, secondaryNode, 'read_active_project')
    assert.equal(finalRead.document.text.includes(`stale-write-must-not-land-${runId}`), false)
    const primaryResearch = await lanCall(session, primaryNode, 'inspect_research_state')
    const scenarioId = `lan-scenario-${runId}`
    const turnId = `lan-turn-${runId}`
    const baseTurnBody = `Shared base turn ${runId}`
    const createdScenario = await lanCall(session, primaryNode, 'create_scenario', {
      expectedResearchRevision: primaryResearch.researchState.revision,
      scenarioId,
      title: `LAN collaboration proof ${runId}`,
      background: 'Physical two-install scenario-turn convergence proof.',
      participantId: 'lan-primary',
    })
    const addedTurn = await lanCall(session, primaryNode, 'add_scenario_turn', {
      expectedResearchRevision: createdScenario.researchRevision,
      scenarioId,
      turnId,
      role: 'assistant',
      content: baseTurnBody,
      participantId: 'lan-primary',
    })
    const secondaryBase = await waitFor(
      () => optionalLanCall(session, secondaryNode, 'read_scenario_turn_revision', { scenarioId, turnId }),
      (value) => value?.revision?.content === baseTurnBody && value?.turn?.revisionCount === 1,
      60_000,
      'scenario turn from primary on the secondary installation',
    )
    evidence.scenarioPrimaryToSecondary = secondaryBase.revision.content === baseTurnBody

    const primaryBase = await lanCall(session, primaryNode, 'read_scenario_turn_revision', { scenarioId, turnId })
    const primaryBranchBody = `Primary scenario branch ${runId}`
    const secondaryBranchBody = `Secondary scenario branch ${runId}`
    const [primaryBranch, secondaryBranch] = await Promise.all([
      lanCall(session, primaryNode, 'revise_scenario_turn', {
        expectedResearchRevision: primaryBase.researchRevision, scenarioId, turnId,
        role: 'assistant', content: primaryBranchBody, participantId: 'lan-primary',
      }),
      lanCall(session, secondaryNode, 'revise_scenario_turn', {
        expectedResearchRevision: secondaryBase.researchRevision, scenarioId, turnId,
        role: 'assistant', content: secondaryBranchBody, participantId: 'lan-secondary',
      }),
    ])
    const primaryEditId = primaryBranch.turn.currentEditId
    const secondaryEditId = secondaryBranch.turn.currentEditId
    assert.notEqual(primaryEditId, secondaryEditId)

    const siblingReads = await waitFor(
      async () => Promise.all([
        optionalLanCall(session, primaryNode, 'read_scenario_turn_revision', { scenarioId, turnId, revisionEditId: primaryEditId }),
        optionalLanCall(session, primaryNode, 'read_scenario_turn_revision', { scenarioId, turnId, revisionEditId: secondaryEditId }),
        optionalLanCall(session, secondaryNode, 'read_scenario_turn_revision', { scenarioId, turnId, revisionEditId: primaryEditId }),
        optionalLanCall(session, secondaryNode, 'read_scenario_turn_revision', { scenarioId, turnId, revisionEditId: secondaryEditId }),
      ]),
      (values) => values.every(Boolean)
        && values[0].revision.content === primaryBranchBody
        && values[1].revision.content === secondaryBranchBody
        && values[2].revision.content === primaryBranchBody
        && values[3].revision.content === secondaryBranchBody
        && values.every((value) => value.turn.revisionCount === 3),
      60_000,
      'both scenario revision bodies on both installations',
    )
    evidence.scenarioSiblingMerge = siblingReads.every((value) => value.turn.revisionCount === 3)

    const currentTurns = await waitFor(
      async () => Promise.all([
        optionalLanCall(session, primaryNode, 'read_scenario_turn_revision', { scenarioId, turnId }),
        optionalLanCall(session, secondaryNode, 'read_scenario_turn_revision', { scenarioId, turnId }),
      ]),
      ([primary, secondary]) => Boolean(primary && secondary)
        && primary.turn.currentEditId === secondary.turn.currentEditId
        && primary.revision.editId === secondary.revision.editId
        && primary.revision.content === secondary.revision.content
        && primary.turn.revisionCount === 3 && secondary.turn.revisionCount === 3,
      60_000,
      'deterministic current scenario turn on both installations',
    )
    evidence.scenarioCurrentConverged = currentTurns[0].revision.editId === currentTurns[1].revision.editId

    try {
      await lanCall(session, primaryNode, 'revise_scenario_turn', {
        expectedResearchRevision: primaryBase.researchRevision, scenarioId, turnId,
        role: 'assistant', content: `stale-scenario-write-must-not-land-${runId}`, participantId: 'lan-stale',
      })
    } catch {
      evidence.scenarioStaleRevisionRejected = true
    }
    const afterStaleScenario = await Promise.all([
      lanCall(session, primaryNode, 'read_scenario_turn_revision', { scenarioId, turnId }),
      lanCall(session, secondaryNode, 'read_scenario_turn_revision', { scenarioId, turnId }),
    ])
    assert.equal(afterStaleScenario.every((value) => value.turn.revisionCount === 3), true)
    evidence.passed = evidence.exactSharedIdentity
      && evidence.primaryToSecondary
      && evidence.secondaryToPrimary
      && evidence.concurrentMerge
      && evidence.staleRevisionRejected
      && evidence.scenarioPrimaryToSecondary
      && evidence.scenarioSiblingMerge
      && evidence.scenarioCurrentConverged
      && evidence.scenarioStaleRevisionRejected
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} finally {
  host.stdin.end()
  terminate(host)
}
