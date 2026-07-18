import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { superviseLanAgent } from './lan-agent-supervisor.mjs'

function fakeAgent(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  return child
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for LAN agent supervisor state')
}

test('restarts an agent that exits and stops the active replacement exactly once', async () => {
  const agents = []
  const terminated = []
  const supervisor = superviseLanAgent({
    spawnAgent() {
      const child = fakeAgent(agents.length + 1)
      agents.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    terminateAgent(child) {
      terminated.push(child.pid)
      child.exitCode = 0
      child.emit('exit', 0, null)
    },
    restartDelaysMs: [1],
    stableAfterMs: 10,
  })

  await waitFor(() => agents.length === 1)
  agents[0].exitCode = 1
  agents[0].emit('exit', 1, null)
  await waitFor(() => agents.length === 2)

  supervisor.stop()
  supervisor.stop()
  assert.deepEqual(terminated, [2])
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(agents.length, 2)
})

test('uses bounded backoff and resets it after a stable agent', async () => {
  const agents = []
  const logs = []
  const supervisor = superviseLanAgent({
    spawnAgent() {
      const child = fakeAgent(agents.length + 10)
      agents.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    terminateAgent() {},
    log: (message) => logs.push(message),
    restartDelaysMs: [1, 3],
    stableAfterMs: 5,
  })

  agents[0].exitCode = 1
  agents[0].emit('exit', 1, null)
  await waitFor(() => agents.length === 2)
  agents[1].exitCode = 1
  agents[1].emit('exit', 1, null)
  await waitFor(() => agents.length === 3)
  await waitFor(() => logs.includes('local agent remained stable; restart backoff reset'))
  agents[2].exitCode = 1
  agents[2].emit('exit', 1, null)
  await waitFor(() => agents.length === 4)

  const restartLogs = logs.filter((message) => message.includes('restarting in'))
  assert.match(restartLogs[0], /restarting in 1ms/)
  assert.match(restartLogs[1], /restarting in 3ms/)
  assert.match(restartLogs[2], /restarting in 1ms/)
  supervisor.stop()
})
