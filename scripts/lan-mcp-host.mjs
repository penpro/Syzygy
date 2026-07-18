import { spawn, spawnSync } from 'node:child_process'
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
const port = integerOption(options, '--port', DEFAULT_PORT, { max: 65_535 })
const keyFile = path.resolve(requiredOption(options, '--key-file'))
const localExecutable = path.resolve(requiredOption(options, '--local-executable'))
const localNodeId = assertNodeId(option(options, '--local-node-id', 'office-primary'))

const coordinator = spawn(process.execPath, [
  path.join(scripts, 'lan-mcp-coordinator.mjs'),
  '--listen', listen,
  '--port', String(port),
  '--key-file', keyFile,
], {
  stdio: ['inherit', 'inherit', 'inherit'],
  windowsHide: true,
})

function terminate(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  } else child.kill('SIGTERM')
}

const agentSupervisor = superviseLanAgent({
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

coordinator.once('error', (error) => {
  process.stderr.write(`[syzygy-lan-host] coordinator failed: ${error.message}\n`)
  agentSupervisor.stop()
  process.exitCode = 1
})
coordinator.once('exit', (code) => {
  agentSupervisor.stop()
  process.exitCode = code ?? 1
})

const stop = () => {
  agentSupervisor.stop()
  terminate(coordinator)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
