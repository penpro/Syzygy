import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const watchdog = path.join(scriptsDir, 'run-with-heartbeat.mjs')

function run(args, timeout = 10_000) {
  return spawnSync(process.execPath, [watchdog, ...args], {
    cwd: path.dirname(scriptsDir),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
}

test('forwards output and preserves a successful exit', () => {
  const result = run([
    '--timeout-seconds', '5', '--heartbeat-seconds', '1', '--',
    process.execPath, '-e', "process.stdout.write('watchdog-ok')",
  ])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /watchdog-ok/)
  assert.match(result.stderr, /finished exit=0/)
})

test('preserves a failing command exit code', () => {
  const result = run([
    '--timeout-seconds', '5', '--heartbeat-seconds', '1', '--',
    process.execPath, '-e', 'process.exit(7)',
  ])
  assert.equal(result.status, 7)
  assert.match(result.stderr, /finished exit=7/)
})


test('runs npm through its JavaScript CLI without enabling a shell', () => {
  const result = run([
    '--timeout-seconds', '5', '--heartbeat-seconds', '1', '--',
    'npm', '--version',
  ])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\d+\.\d+\.\d+/)
})
test('emits a heartbeat while a silent command is still running', () => {
  const result = run([
    '--timeout-seconds', '5', '--heartbeat-seconds', '1', '--',
    process.execPath, '-e', 'setTimeout(() => {}, 1400)',
  ])
  assert.equal(result.status, 0)
  assert.match(result.stderr, /heartbeat elapsed=1s/)
})

test('rejects heartbeat intervals over one minute', () => {
  const result = run([
    '--timeout-seconds', '5', '--heartbeat-seconds', '61', '--',
    process.execPath, '-e', '',
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /cannot exceed 60/)
})

test('terminates a hung process tree at the deadline', () => {
  const result = run([
    '--timeout-seconds', '1', '--heartbeat-seconds', '1', '--',
    process.execPath, '-e', 'setInterval(() => {}, 1000)',
  ])
  assert.equal(result.status, 124)
  assert.match(result.stderr, /timeout after 1s/)
  assert.match(result.stderr, /finished timeout/)
})
