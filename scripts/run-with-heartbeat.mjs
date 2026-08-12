import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const DEFAULT_HEARTBEAT_SECONDS = 30
const MAX_HEARTBEAT_SECONDS = 60
const TIMEOUT_EXIT_CODE = 124

function fail(message) {
  process.stderr.write(`[syzygy-watchdog] ${message}\n`)
  process.exitCode = 2
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseArguments(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('usage: node scripts/run-with-heartbeat.mjs --timeout-seconds <n> [--heartbeat-seconds <n>] -- <command> [args...]')
  }

  let timeoutSeconds = null
  let heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS
  let cancelFile = null
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`${flag ?? 'option'} requires a value`)
    if (flag === '--timeout-seconds') timeoutSeconds = positiveInteger(value, flag)
    else if (flag === '--heartbeat-seconds') heartbeatSeconds = positiveInteger(value, flag)
    else if (flag === '--cancel-file') {
      if (!isAbsolute(value)) throw new Error('--cancel-file must be absolute')
      cancelFile = value
    }
    else throw new Error(`unknown option: ${flag}`)
  }

  if (timeoutSeconds === null) throw new Error('--timeout-seconds is required')
  if (heartbeatSeconds > MAX_HEARTBEAT_SECONDS) {
    throw new Error(`--heartbeat-seconds cannot exceed ${MAX_HEARTBEAT_SECONDS}`)
  }

  return {
    timeoutSeconds,
    heartbeatSeconds,
    cancelFile,
    command: argv[separator + 1],
    commandArgs: argv.slice(separator + 2),
  }
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : null,
  ]
  const candidate = candidates.find((path) => typeof path === 'string' && path.endsWith('.js') && existsSync(path))
  if (!candidate) {
    throw new Error('npm-cli.js was not found; invoke the underlying Node CLI explicitly')
  }
  return candidate
}

function resolveInvocation(command, commandArgs) {
  if (command.toLowerCase() !== 'npm') return { command, commandArgs }
  return { command: process.execPath, commandArgs: [npmCliPath(), ...commandArgs] }
}

function terminateProcessTree(child) {
  if (!child.pid) return false
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore', windowsHide: true,
    })
    if (result.status === 0) return true
    if (child.exitCode === null) child.kill('SIGKILL')
    return false
  }
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, 1_000).unref()
  return true
}

async function run() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    return
  }

  const startedAt = Date.now()
  let lastOutputAt = startedAt
  let timedOut = false
  let interrupted = false
  let forcedExit = null
  let stopRequested = false
  let invocation
  try {
    invocation = resolveInvocation(options.command, options.commandArgs)
  } catch (error) {
    fail(error.message)
    return
  }
  const child = spawn(invocation.command, invocation.commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const forward = (source, target) => source.on('data', (chunk) => {
    lastOutputAt = Date.now()
    target.write(chunk)
  })
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)

  const heartbeat = setInterval(() => {
    const now = Date.now()
    process.stderr.write(
      `[syzygy-watchdog] heartbeat elapsed=${Math.floor((now - startedAt) / 1_000)}s ` +
      `silent=${Math.floor((now - lastOutputAt) / 1_000)}s pid=${child.pid ?? 'pending'} ` +
      `deadline=${options.timeoutSeconds}s\n`,
    )
  }, options.heartbeatSeconds * 1_000)

  const requestStop = (reason) => {
    if (stopRequested) return
    stopRequested = true
    timedOut = reason === 'timeout'
    interrupted = reason !== 'timeout'
    process.stderr.write(reason === 'timeout'
      ? `[syzygy-watchdog] timeout after ${options.timeoutSeconds}s; terminating process tree\n`
      : `[syzygy-watchdog] ${reason}; terminating process tree\n`)
    const treeTerminated = terminateProcessTree(child)
    if (!treeTerminated && process.platform === 'win32') {
      process.stderr.write('[syzygy-watchdog] taskkill unavailable; terminated the directly owned command\n')
    }
    forcedExit = setTimeout(() => process.exit(timedOut ? TIMEOUT_EXIT_CODE : 130), 5_000)
  }

  const deadline = setTimeout(() => requestStop('timeout'), options.timeoutSeconds * 1_000)

  const cancelMonitor = options.cancelFile ? setInterval(() => {
    if (existsSync(options.cancelFile)) requestStop('cancel requested by supervisor')
  }, 250) : null

  const interrupt = () => {
    requestStop('interrupted')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)

  child.once('error', (error) => {
    clearInterval(heartbeat)
    if (cancelMonitor) clearInterval(cancelMonitor)
    clearTimeout(deadline)
    if (forcedExit) clearTimeout(forcedExit)
    process.stderr.write(`[syzygy-watchdog] failed to start command: ${error.code ?? 'spawn-error'}\n`)
    process.exitCode = 127
  })

  child.once('close', (code, signal) => {
    clearInterval(heartbeat)
    if (cancelMonitor) clearInterval(cancelMonitor)
    clearTimeout(deadline)
    if (forcedExit) clearTimeout(forcedExit)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    const elapsedSeconds = Math.ceil((Date.now() - startedAt) / 1_000)
    if (timedOut) {
      process.stderr.write(`[syzygy-watchdog] finished timeout elapsed=${elapsedSeconds}s\n`)
      process.exitCode = TIMEOUT_EXIT_CODE
    } else if (interrupted) {
      process.stderr.write(`[syzygy-watchdog] finished interrupted elapsed=${elapsedSeconds}s\n`)
      process.exitCode = 130
    } else {
      process.stderr.write(
        `[syzygy-watchdog] finished exit=${code ?? 'signal'} signal=${signal ?? 'none'} elapsed=${elapsedSeconds}s\n`,
      )
      process.exitCode = code ?? 1
    }
  })
}

await run()
