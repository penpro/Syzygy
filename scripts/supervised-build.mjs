import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SCRIPT_PATH), '..')
const FRONTEND = join(ROOT, 'frontend')
const WATCHDOG = join(ROOT, 'scripts', 'run-with-heartbeat.mjs')
const HEARTBEAT_SECONDS = 30
const STATE_SCHEMA_VERSION = 1
const STALL_EXIT_CODE = 125
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'])
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{6}$/

function cargoCommand() {
  const configured = process.env.CARGO
  if (configured) return configured
  const home = process.env.USERPROFILE ?? process.env.HOME
  const candidate = home ? join(home, '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo') : null
  return candidate && existsSync(candidate) ? candidate : 'cargo'
}

function packagedExecutable() {
  const name = process.platform === 'win32' ? 'Syzygy.exe' : 'Syzygy'
  return join(FRONTEND, 'src-tauri', 'target', 'release', name)
}

const productionProfiles = {
  check: {
    totalDeadlineSeconds: 1_800,
    closeApp: false,
    steps: [
      { id: 'frontend-tests', cwd: FRONTEND, timeoutSeconds: 600, stallSeconds: 120, command: 'npm', args: ['test', '--', '--run'] },
      { id: 'frontend-build', cwd: FRONTEND, timeoutSeconds: 600, stallSeconds: 120, command: 'npm', args: ['run', 'build'] },
      { id: 'repository-audit', cwd: FRONTEND, timeoutSeconds: 300, stallSeconds: 60, command: 'npm', args: ['run', 'audit'] },
      { id: 'rust-check', cwd: ROOT, timeoutSeconds: 1_200, stallSeconds: 300, command: cargoCommand(), args: ['check', '--manifest-path', join(FRONTEND, 'src-tauri', 'Cargo.toml'), '--locked'] },
    ],
  },
  package: {
    totalDeadlineSeconds: 2_400,
    closeApp: true,
    steps: [
      { id: 'frontend-tests', cwd: FRONTEND, timeoutSeconds: 600, stallSeconds: 120, command: 'npm', args: ['test', '--', '--run'] },
      { id: 'repository-audit', cwd: FRONTEND, timeoutSeconds: 300, stallSeconds: 60, command: 'npm', args: ['run', 'audit'] },
      { id: 'rust-check', cwd: ROOT, timeoutSeconds: 1_200, stallSeconds: 300, command: cargoCommand(), args: ['check', '--manifest-path', join(FRONTEND, 'src-tauri', 'Cargo.toml'), '--locked'] },
      { id: 'app-resource-shutdown', kind: 'shutdown', timeoutSeconds: 90 },
      { id: 'tauri-package', cwd: FRONTEND, timeoutSeconds: 900, stallSeconds: 300, command: 'npm', args: ['run', 'tauri', 'build'], requiredOutput: 'Compiling app v' },
      { id: 'packaged-mcp-smoke', cwd: ROOT, timeoutSeconds: 300, stallSeconds: 180, command: process.execPath, args: [join(ROOT, 'scripts', 'mcp-harness.mjs'), '--executable', packagedExecutable()] },
    ],
  },
}

function fixtureProfiles() {
  if (process.env.SYZYGY_SUPERVISED_BUILD_FIXTURES !== '1') return {}
  return {
    'fixture-success': {
      totalDeadlineSeconds: 10,
      closeApp: false,
      steps: [
        { id: 'one', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "setTimeout(() => console.log('fixture-one'), 80)"] },
        { id: 'two', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "console.log('fixture-two')"] },
      ],
    },
    'fixture-failure': {
      totalDeadlineSeconds: 10,
      closeApp: false,
      steps: [
        { id: 'fails', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', 'process.exit(7)'] },
        { id: 'must-not-run', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "console.log('unexpected')"] },
      ],
    },
    'fixture-cancel': {
      totalDeadlineSeconds: 30,
      closeApp: false,
      steps: [
        { id: 'waits', cwd: ROOT, timeoutSeconds: 20, heartbeatSeconds: 1, stallSeconds: 15, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { id: 'must-not-run', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "console.log('unexpected')"] },
      ],
    },
    'fixture-stall': {
      totalDeadlineSeconds: 10,
      closeApp: false,
      steps: [
        { id: 'stalls', cwd: ROOT, timeoutSeconds: 8, heartbeatSeconds: 1, stallSeconds: 2, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { id: 'must-not-run', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "console.log('unexpected')"] },
      ],
    },
    'fixture-timeout': {
      totalDeadlineSeconds: 10,
      closeApp: false,
      steps: [
        { id: 'times-out', cwd: ROOT, timeoutSeconds: 1, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        { id: 'must-not-run', cwd: ROOT, timeoutSeconds: 4, command: process.execPath, args: ['-e', "console.log('unexpected')"] },
      ],
    },
  }
}

export function profiles() {
  return { ...productionProfiles, ...fixtureProfiles() }
}

function runsRoot() {
  return resolve(process.env.SYZYGY_DEV_RUNS_DIR ?? join(ROOT, '.syzygy-dev-runs'))
}

function runDirectory(runId) {
  validateRunId(runId)
  return join(runsRoot(), runId)
}

function statePath(runId) {
  return join(runDirectory(runId), 'state.json')
}

function outputPath(runId) {
  return join(runDirectory(runId), 'output.log')
}

export function validateRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId ?? '')) throw new Error('Invalid supervised-build run ID')
  return runId
}

function nowIso() {
  return new Date().toISOString()
}

function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readState(runId) {
  return readJson(statePath(runId))
}

function latestRunId() {
  const path = join(runsRoot(), 'latest.json')
  if (!existsSync(path)) throw new Error('No supervised build has been started')
  return validateRunId(readJson(path).runId)
}

function selectedRunId(value) {
  return !value || value === 'latest' ? latestRunId() : validateRunId(value)
}

function updateState(runId, mutate) {
  const state = readState(runId)
  mutate(state)
  state.updatedAt = nowIso()
  writeJsonAtomic(statePath(runId), state)
  return state
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminateProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch {}
  try { process.kill(pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
  }, 1_000).unref()
}

function argumentValue(args, flag, fallback = null) {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function assertKnownOptions(args, flags, booleans = []) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--')) continue
    if (booleans.includes(value)) continue
    if (!flags.includes(value)) throw new Error(`Unknown option: ${value}`)
    index += 1
  }
}

function initialState(runId, profileName, profile) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId,
    profile: profileName,
    repository: ROOT,
    status: 'queued',
    pid: null,
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null,
    totalDeadlineSeconds: profile.totalDeadlineSeconds,
    activeStep: null,
    failure: null,
    outputLog: outputPath(runId),
    steps: profile.steps.map((step) => ({
      id: step.id,
      status: 'queued',
      timeoutSeconds: step.timeoutSeconds,
      stallSeconds: step.stallSeconds ?? null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      failure: null,
    })),
  }
}

function markStaleLatestRun() {
  let runId
  try { runId = latestRunId() } catch { return }
  const state = readState(runId)
  if (TERMINAL_STATES.has(state.status)) return
  if (isProcessAlive(state.pid)) throw new Error(`Supervised build ${runId} is already ${state.status}`)
  state.status = 'interrupted'
  state.finishedAt = nowIso()
  state.failure = 'The build worker no longer exists; a new run may start.'
  state.activeStep = null
  state.updatedAt = nowIso()
  writeJsonAtomic(statePath(runId), state)
}

async function startCommand(args) {
  assertKnownOptions(args, ['--profile'], ['--foreground'])
  const profileName = argumentValue(args, '--profile', 'package')
  const profile = profiles()[profileName]
  if (!profile) throw new Error(`Unknown profile: ${profileName}`)
  markStaleLatestRun()

  const runId = createRunId()
  mkdirSync(runDirectory(runId), { recursive: true })
  writeJsonAtomic(statePath(runId), initialState(runId, profileName, profile))
  writeJsonAtomic(join(runsRoot(), 'latest.json'), { runId })

  if (args.includes('--foreground')) {
    process.stdout.write(`${JSON.stringify({ runId, profile: profileName, detached: false, statePath: statePath(runId) })}\n`)
    await runWorker(runId, profileName)
    return
  }

  const logFd = openSync(outputPath(runId), 'a', 0o600)
  const child = spawn(process.execPath, [SCRIPT_PATH, 'worker', '--run-id', runId, '--profile', profileName], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  closeSync(logFd)
  updateState(runId, (state) => { state.pid = child.pid ?? null })
  process.stdout.write(`${JSON.stringify({
    runId,
    profile: profileName,
    detached: true,
    pid: child.pid ?? null,
    statePath: statePath(runId),
    outputLog: outputPath(runId),
    statusCommand: `npm run build:status -- ${runId}`,
    followCommand: `npm run build:follow -- ${runId}`,
  }, null, 2)}\n`)
}

function log(message) {
  process.stdout.write(`[syzygy-build] ${message}\n`)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function windowsProcessSnapshot() {
  const command = `$items = @(Get-CimInstance Win32_Process -Filter "Name = 'Syzygy.exe' OR Name = 'llama-server.exe'" | Select-Object Name,ProcessId,ParentProcessId); ConvertTo-Json -InputObject $items -Compress`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  if (result.status !== 0) throw new Error('Could not inspect Syzygy processes before packaging')
  const parsed = JSON.parse(result.stdout.trim() || '[]')
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    name: String(item.Name ?? ''),
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
  })).filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0)
}

function unixProcessSnapshot() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0) throw new Error('Could not inspect Syzygy processes before packaging')
  return result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 3)).filter((parts) => parts.length === 3).map(([pid, parentPid, command]) => ({
    name: basename(command), pid: Number(pid), parentPid: Number(parentPid),
  })).filter((item) => item.name === 'Syzygy' || item.name === 'llama-server')
}

function processSnapshot() {
  return process.platform === 'win32' ? windowsProcessSnapshot() : unixProcessSnapshot()
}

function processIds(snapshot, name) {
  return snapshot.filter((item) => item.name.toLowerCase() === name.toLowerCase()).map((item) => item.pid)
}

function requestGracefulClose(syzygyPids) {
  if (process.platform === 'win32') {
    const ids = syzygyPids.join(',')
    const command = `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    return
  }
  for (const pid of syzygyPids) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

function forceKnownProcesses(pids) {
  for (const pid of pids) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
}

async function shutdownAppResources(timeoutSeconds) {
  const absoluteDeadline = Date.now() + timeoutSeconds * 1_000
  const initial = processSnapshot()
  const syzygyPids = processIds(initial, process.platform === 'win32' ? 'Syzygy.exe' : 'Syzygy')
  const llama = initial.filter((item) => item.name.toLowerCase() === (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'))
  const ownedLlamaPids = llama.filter((item) => syzygyPids.includes(item.parentPid)).map((item) => item.pid)
  const unrelatedLlamaPids = llama.filter((item) => !ownedLlamaPids.includes(item.pid)).map((item) => item.pid)
  if (unrelatedLlamaPids.length) {
    throw new Error(`Unowned llama-server process detected (${unrelatedLlamaPids.join(', ')}); refusing to terminate it automatically`)
  }
  if (!syzygyPids.length && !ownedLlamaPids.length) {
    log('resource preflight: no running Syzygy or llama-server process')
    return
  }

  log(`resource preflight: requesting normal close for Syzygy PID(s) ${syzygyPids.join(', ')}`)
  requestGracefulClose(syzygyPids)
  const gracefulDeadline = Math.min(Date.now() + 60_000, absoluteDeadline - 10_000)
  while (Date.now() < gracefulDeadline) {
    const current = processSnapshot()
    const remaining = current.filter((item) => syzygyPids.includes(item.pid) || ownedLlamaPids.includes(item.pid))
    if (!remaining.length) {
      log('resource preflight: normal close verified app and local model exit')
      return
    }
    await delay(1_000)
  }

  log('resource preflight: normal close deadline reached; terminating only the captured Syzygy process tree')
  forceKnownProcesses(syzygyPids)
  forceKnownProcesses(ownedLlamaPids)
  const forcedDeadline = absoluteDeadline
  while (Date.now() < forcedDeadline) {
    const current = processSnapshot()
    const remaining = current.filter((item) => syzygyPids.includes(item.pid) || ownedLlamaPids.includes(item.pid))
    if (!remaining.length) {
      log('resource preflight: scoped forced recovery verified process exit')
      return
    }
    await delay(500)
  }
  throw new Error('Syzygy or its captured local-model process remained after scoped recovery')
}

function markStep(runId, stepId, values) {
  updateState(runId, (state) => {
    const step = state.steps.find((candidate) => candidate.id === stepId)
    if (!step) throw new Error(`Missing state for step ${stepId}`)
    Object.assign(step, values)
    state.activeStep = values.status === 'running' ? stepId : null
  })
}

async function runCommandStep(runId, step, active) {
  const args = [
    WATCHDOG,
    '--timeout-seconds', String(step.timeoutSeconds),
    '--heartbeat-seconds', String(step.heartbeatSeconds ?? HEARTBEAT_SECONDS),
    '--', step.command, ...step.args,
  ]
  const child = spawn(process.execPath, args, {
    cwd: step.cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  active.child = child
  let requiredOutputSeen = !step.requiredOutput
  let monitorBuffer = ''
  let stallFailure = null
  const forward = (source, target) => source.on('data', (chunk) => {
    const text = chunk.toString()
    if (step.requiredOutput && text.includes(step.requiredOutput)) requiredOutputSeen = true
    monitorBuffer = `${monitorBuffer}${text}`.slice(-4_096)
    const silentMatches = [...monitorBuffer.matchAll(/\[syzygy-watchdog\] heartbeat[^\n]*silent=(\d+)s/g)]
    const silentSeconds = Number(silentMatches.at(-1)?.[1] ?? 0)
    if (!stallFailure && step.stallSeconds && silentSeconds >= step.stallSeconds) {
      stallFailure = `Step ${step.id} produced no child output for ${silentSeconds}s (stall clamp ${step.stallSeconds}s)`
      log(stallFailure)
      if (child.pid) terminateProcessTree(child.pid)
    }
    target.write(chunk)
  })
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)
  const result = await new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild)
    child.once('close', (code, signal) => resolveChild({ code, signal }))
  })
  active.child = null
  if (stallFailure) {
    const error = new Error(stallFailure)
    error.exitCode = STALL_EXIT_CODE
    throw error
  }
  if (result.code !== 0) {
    const error = new Error(`Step ${step.id} failed with exit ${result.code ?? result.signal ?? 'unknown'}`)
    error.exitCode = result.code
    throw error
  }
  if (!requiredOutputSeen) throw new Error(`Step ${step.id} did not prove frontend assets were re-embedded (${step.requiredOutput})`)
}

async function runWorker(runId, profileName) {
  validateRunId(runId)
  const profile = profiles()[profileName]
  if (!profile) throw new Error(`Unknown profile: ${profileName}`)
  const active = { child: null }
  let totalTimedOut = false
  let cancelled = false
  const startedAt = Date.now()

  updateState(runId, (state) => {
    state.status = 'running'
    state.pid = process.pid
    state.startedAt = nowIso()
  })
  log(`run ${runId} profile=${profileName} pid=${process.pid} total-deadline=${profile.totalDeadlineSeconds}s`)

  const heartbeat = setInterval(() => {
    const state = readState(runId)
    log(`heartbeat elapsed=${Math.floor((Date.now() - startedAt) / 1_000)}s active=${state.activeStep ?? 'between-steps'} total-deadline=${profile.totalDeadlineSeconds}s`)
  }, HEARTBEAT_SECONDS * 1_000)

  const totalDeadline = setTimeout(() => {
    totalTimedOut = true
    log(`total deadline reached after ${profile.totalDeadlineSeconds}s; terminating active step`)
    if (active.child?.pid) terminateProcessTree(active.child.pid)
  }, profile.totalDeadlineSeconds * 1_000)

  const interrupt = () => {
    cancelled = true
    log('worker interrupted; terminating active step')
    if (active.child?.pid) terminateProcessTree(active.child.pid)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)

  try {
    for (const step of profile.steps) {
      if (totalTimedOut || cancelled) throw new Error(totalTimedOut ? 'Total build deadline reached' : 'Build cancelled')
      markStep(runId, step.id, { status: 'running', startedAt: nowIso() })
      log(`step start id=${step.id} deadline=${step.timeoutSeconds}s`)
      const stepStartedAt = Date.now()
      try {
        if (step.kind === 'shutdown') await shutdownAppResources(step.timeoutSeconds)
        else await runCommandStep(runId, step, active)
      } catch (error) {
        const stepTimedOut = totalTimedOut || error.exitCode === 124
        markStep(runId, step.id, {
          status: stepTimedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed',
          finishedAt: nowIso(),
          exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
          failure: error.message,
        })
        throw error
      }
      markStep(runId, step.id, { status: 'succeeded', finishedAt: nowIso(), exitCode: 0 })
      log(`step complete id=${step.id} elapsed=${Math.ceil((Date.now() - stepStartedAt) / 1_000)}s`)
    }
    updateState(runId, (state) => {
      state.status = 'succeeded'
      state.finishedAt = nowIso()
      state.activeStep = null
    })
    log(`run complete status=succeeded elapsed=${Math.ceil((Date.now() - startedAt) / 1_000)}s`)
  } catch (error) {
    const status = totalTimedOut || error.exitCode === 124 ? 'timed_out' : cancelled ? 'cancelled' : 'failed'
    updateState(runId, (state) => {
      state.status = status
      state.finishedAt = nowIso()
      state.activeStep = null
      state.failure = error.message
    })
    log(`run complete status=${status} failure=${error.message}`)
    process.exitCode = totalTimedOut ? 124 : cancelled ? 130 : 1
  } finally {
    clearInterval(heartbeat)
    clearTimeout(totalDeadline)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

function tailText(path, maxLines = 40, maxBytes = 64_000) {
  if (!existsSync(path)) return ''
  const size = statSync(path).size
  const text = readFileSync(path, 'utf8').slice(Math.max(0, size - maxBytes))
  return text.split(/\r?\n/).slice(-maxLines).join('\n').trim()
}

function statusCommand(args) {
  if (args.length > 1) throw new Error('usage: status [run-id|latest]')
  const runId = selectedRunId(args[0])
  const state = readState(runId)
  const tail = tailText(outputPath(runId))
  process.stdout.write(`${JSON.stringify({ ...state, workerAlive: !TERMINAL_STATES.has(state.status) && isProcessAlive(state.pid), outputTail: tail }, null, 2)}\n`)
  if (state.status === 'failed' || state.status === 'interrupted') process.exitCode = 1
  if (state.status === 'timed_out') process.exitCode = 124
  if (state.status === 'cancelled') process.exitCode = 130
}

async function followCommand(args) {
  if (args.length > 1) throw new Error('usage: follow [run-id|latest]')
  const runId = selectedRunId(args[0])
  const path = outputPath(runId)
  let offset = 0
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      if (text.length > offset) process.stdout.write(text.slice(offset))
      offset = text.length
    }
    const state = readState(runId)
    if (TERMINAL_STATES.has(state.status)) {
      process.stdout.write(`[syzygy-build] follow complete status=${state.status} run=${runId}\n`)
      if (state.status === 'failed' || state.status === 'interrupted') process.exitCode = 1
      if (state.status === 'timed_out') process.exitCode = 124
      if (state.status === 'cancelled') process.exitCode = 130
      return
    }
    await delay(1_000)
  }
}

async function cancelCommand(args) {
  if (args.length > 1) throw new Error('usage: cancel [run-id|latest]')
  const runId = selectedRunId(args[0])
  const state = readState(runId)
  if (TERMINAL_STATES.has(state.status)) {
    process.stdout.write(`Run ${runId} is already ${state.status}.\n`)
    return
  }
  if (isProcessAlive(state.pid)) terminateProcessTree(state.pid)
  await delay(500)
  updateState(runId, (current) => {
    current.status = 'cancelled'
    current.finishedAt = nowIso()
    current.activeStep = null
    current.failure = 'Cancelled by explicit build:cancel command.'
  })
  process.stdout.write(`Cancelled supervised build ${runId}.\n`)
}

async function main() {
  mkdirSync(runsRoot(), { recursive: true })
  const [command = 'start', ...args] = process.argv.slice(2)
  if (command === 'start') await startCommand(args)
  else if (command === 'worker') {
    assertKnownOptions(args, ['--run-id', '--profile'])
    await runWorker(argumentValue(args, '--run-id'), argumentValue(args, '--profile'))
  } else if (command === 'status') statusCommand(args)
  else if (command === 'follow') await followCommand(args)
  else if (command === 'cancel') await cancelCommand(args)
  else throw new Error('usage: supervised-build.mjs start|status|follow|cancel')
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`[syzygy-build] ${error.message}\n`)
    process.exitCode = 2
  })
}
