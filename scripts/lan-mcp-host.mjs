import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  assertNodeId,
  integerOption,
  option,
  parseCli,
  requiredOption,
} from './lan-bridge-protocol.mjs'
import { superviseLanAgent } from './lan-agent-supervisor.mjs'

const scripts = path.dirname(fileURLToPath(import.meta.url))
const options = parseCli(process.argv.slice(2))
const listen = requiredOption(options, '--listen')
const port = integerOption(options, '--port', DEFAULT_PORT, { max: 65_534 })
const controlPort = integerOption(options, '--control-port', port + 1, { min: 1, max: 65_535 })
const keyFile = path.resolve(requiredOption(options, '--key-file'))
const localExecutable = path.resolve(requiredOption(options, '--local-executable'))
const localNodeId = assertNodeId(option(options, '--local-node-id', 'office-primary'))

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  } else child.kill('SIGTERM')
}

function canConnect(host, targetPort, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: targetPort })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitForControl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect('127.0.0.1', controlPort)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

let coordinator = null
let agentSupervisor = null
if (!await canConnect('127.0.0.1', controlPort)) {
  coordinator = spawn(process.execPath, [
    path.join(scripts, 'lan-mcp-coordinator.mjs'),
    '--listen', listen,
    '--port', String(port),
    '--control-port', String(controlPort),
    '--key-file', keyFile,
  ], {
    stdio: ['pipe', 'ignore', 'inherit'],
    windowsHide: true,
  })
  coordinator.once('error', (error) => {
    process.stderr.write(`[syzygy-lan-host] coordinator failed: ${error.message}\n`)
  })
  if (!await waitForControl(5_000)) {
    terminate(coordinator)
    throw new Error('LAN coordinator did not open its authenticated control attachment within five seconds')
  }
  agentSupervisor = superviseLanAgent({
    spawnAgent: () => spawn(localExecutable, [
      '--lan-agent',
      '--node-id', localNodeId,
      '--coordinator', listen,
      '--port', String(port),
      '--key-file', keyFile,
    ], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    }),
    terminateAgent: terminate,
    log: (message) => process.stderr.write(`[syzygy-lan-host] ${message}\n`),
  })
} else {
  process.stderr.write('[syzygy-lan-host] attaching to the coordinator already owned by Syzygy developer mode\n')
}

const attachment = spawn(process.execPath, [
  path.join(scripts, 'lan-mcp-attach.mjs'),
  '--host', '127.0.0.1',
  '--control-port', String(controlPort),
  '--key-file', keyFile,
], {
  stdio: ['inherit', 'inherit', 'inherit'],
  windowsHide: true,
})

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  terminate(attachment)
  agentSupervisor?.stop()
  terminate(coordinator)
}
attachment.once('error', (error) => {
  process.stderr.write(`[syzygy-lan-host] control attachment failed: ${error.message}\n`)
  process.exitCode = 1
  stop()
})
attachment.once('exit', (code) => {
  process.exitCode = code ?? 1
  stop()
})
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
