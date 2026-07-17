import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { profiles, validateRunId } from './supervised-build.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const cli = join(scripts, 'supervised-build.mjs')

function environment(runRoot) {
  return {
    ...process.env,
    SYZYGY_DEV_RUNS_DIR: runRoot,
    SYZYGY_SUPERVISED_BUILD_FIXTURES: '1',
  }
}

function start(runRoot, profile) {
  const result = spawnSync(process.execPath, [cli, 'start', '--profile', profile], {
    cwd: dirname(scripts),
    env: environment(runRoot),
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function waitForState(runRoot, runId, terminal, timeout = 8_000) {
  const path = join(runRoot, runId, 'state.json')
  const deadline = Date.now() + timeout
  for (;;) {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (terminal.includes(state.status)) return state
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${runId}; last status ${state.status}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

test('production profiles keep every operation bounded and package the re-embedded executable', () => {
  const available = profiles()
  for (const name of ['check', 'package']) {
    assert.ok(available[name].totalDeadlineSeconds > 0)
    assert.ok(available[name].steps.every((step) => Number.isSafeInteger(step.timeoutSeconds) && step.timeoutSeconds > 0))
    assert.ok(available[name].steps.filter((step) => step.kind !== 'shutdown').every((step) => step.stallSeconds > 0 && step.stallSeconds <= 300))
  }
  const packageStep = available.package.steps.find((step) => step.id === 'tauri-package')
  assert.equal(packageStep.requiredOutput, 'Compiling app v')
  assert.ok(available.package.steps.some((step) => step.id === 'app-resource-shutdown'))
  assert.ok(available.package.steps.some((step) => step.id === 'packaged-mcp-smoke'))
  assert.throws(() => validateRunId('../outside'), /Invalid supervised-build run ID/)
})

test('a detached run survives its launcher and records atomic step completion', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'syzygy-supervised-success-'))
  try {
    const started = start(runRoot, 'fixture-success')
    assert.equal(started.detached, true)
    const state = waitForState(runRoot, started.runId, ['succeeded', 'failed', 'timed_out'])
    assert.equal(state.status, 'succeeded')
    assert.deepEqual(state.steps.map((step) => step.status), ['succeeded', 'succeeded'])
    const output = readFileSync(join(runRoot, started.runId, 'output.log'), 'utf8')
    assert.match(output, /fixture-one/)
    assert.match(output, /run complete status=succeeded/)
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
})

test('a failing step stops the plan and preserves the untouched checkpoint', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'syzygy-supervised-failure-'))
  try {
    const started = start(runRoot, 'fixture-failure')
    const state = waitForState(runRoot, started.runId, ['failed', 'timed_out'])
    assert.equal(state.status, 'failed')
    assert.equal(state.steps[0].status, 'failed')
    assert.equal(state.steps[0].exitCode, 7)
    assert.equal(state.steps[1].status, 'queued')
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
})

test('explicit cancellation terminates the detached worker tree and records a terminal checkpoint', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'syzygy-supervised-cancel-'))
  try {
    const started = start(runRoot, 'fixture-cancel')
    const cancel = spawnSync(process.execPath, [cli, 'cancel', started.runId], {
      cwd: dirname(scripts),
      env: environment(runRoot),
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    assert.equal(cancel.status, 0, cancel.stderr)
    const state = waitForState(runRoot, started.runId, ['cancelled'], 5_000)
    assert.equal(state.status, 'cancelled')
    assert.equal(state.steps[1].status, 'queued')
    assert.equal(state.failure, 'Cancelled by explicit build:cancel command.')
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
})

test('a child-output stall clamp terminates a heartbeat-only operation and does not advance', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'syzygy-supervised-stall-'))
  try {
    const started = start(runRoot, 'fixture-stall')
    const state = waitForState(runRoot, started.runId, ['failed', 'timed_out'], 8_000)
    assert.equal(state.status, 'failed')
    assert.equal(state.steps[0].exitCode, 125)
    assert.equal(state.steps[1].status, 'queued')
    const output = readFileSync(join(runRoot, started.runId, 'output.log'), 'utf8')
    assert.match(output, /stall clamp 2s/)
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
})

test('a step deadline terminates the hung tree and does not advance', () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'syzygy-supervised-timeout-'))
  try {
    const started = start(runRoot, 'fixture-timeout')
    const state = waitForState(runRoot, started.runId, ['failed', 'timed_out'], 8_000)
    assert.equal(state.status, 'timed_out')
    assert.equal(state.steps[0].status, 'timed_out')
    assert.equal(state.steps[0].exitCode, 124)
    assert.equal(state.steps[1].status, 'queued')
    const output = readFileSync(join(runRoot, started.runId, 'output.log'), 'utf8')
    assert.match(output, /timeout after 1s/)
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
  }
})
