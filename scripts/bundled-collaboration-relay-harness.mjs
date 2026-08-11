import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(repository, 'frontend')
const vitestEntry = join(frontend, 'node_modules', 'vitest', 'vitest.mjs')
const yjsEntry = pathToFileURL(join(frontend, 'node_modules', 'yjs', 'dist', 'yjs.mjs')).href
const websocketEntry = pathToFileURL(join(frontend, 'node_modules', 'y-websocket', 'src', 'y-websocket.js')).href
const Y = await import(yjsEntry)
const { WebsocketProvider } = await import(websocketEntry)

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}

async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a relay port')
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return address.port
}

async function waitFor(predicate, label, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error(`${label} did not complete within ${timeoutMilliseconds} ms`)
}

async function startRelay(executable, port, dataDirectory) {
  const child = spawn(executable, [
    '--collaboration-relay',
    '--listen', '127.0.0.1',
    '--port', String(port),
    '--data-dir', dataDirectory,
  ], {
    cwd: repository,
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-8_192) })
  await Promise.race([
    waitFor(() => output.includes('SYZYGY_COLLABORATION_RELAY_READY'), 'bundled relay startup'),
    new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`bundled relay exited during startup (${code}): ${output}`)))),
  ])
  return child
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
  child.stdin.end()
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(5_000).then(() => false),
  ])
  if (!graceful && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'bundled relay process exit', 5_000)
}

async function assertPortReleased(port) {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
}

async function runProductProviderFlow(endpoint, roomId) {
  const child = spawn(process.execPath, [
    vitestEntry,
    'run',
    'src/workspace/websocketProjectProductFlow.integration.test.ts',
  ], {
    cwd: frontend,
    env: {
      ...process.env,
      VITE_SYZYGY_WEBSOCKET_TEST_ENDPOINT: endpoint,
      VITE_SYZYGY_WEBSOCKET_TEST_ROOM: roomId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16_384) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16_384) })
  const result = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', (code, signal) => resolvePromise({ code, signal }))),
    sleep(30_000).then(async () => {
      child.kill('SIGKILL')
      return { code: null, signal: 'deadline' }
    }),
  ])
  if (result.code !== 0) {
    throw new Error(`product provider flow failed (code=${result.code}, signal=${result.signal ?? 'none'}): ${output}`)
  }
}

const executable = argumentValue('--relay-executable')
const dataDirectory = await mkdtemp(join(tmpdir(), 'syzygy-bundled-relay-'))
const port = await freePort()
const endpoint = `ws://127.0.0.1:${port}`
const persistedRoom = `room_${crypto.randomUUID().replaceAll('-', '')}`
let relay = null
let providerA = null
let providerB = null
let providerC = null
let docA = null
let docB = null
let docC = null

try {
  relay = await startRelay(executable, port, dataDirectory)
  docA = new Y.Doc()
  docB = new Y.Doc()
  providerA = new WebsocketProvider(endpoint, persistedRoom, docA, { WebSocketPolyfill: WebSocket, disableBc: true })
  providerB = new WebsocketProvider(endpoint, persistedRoom, docB, { WebSocketPolyfill: WebSocket, disableBc: true })
  await waitFor(() => providerA.synced && providerB.synced, 'initial bundled-relay synchronization')
  docA.getMap('durability').set('server-only-recovery', 'retained')
  await waitFor(() => docB.getMap('durability').get('server-only-recovery') === 'retained', 'live bundled-relay propagation')
  providerA.awareness.setLocalStateField('transient', { participantId: 'a' })
  providerB.awareness.setLocalStateField('transient', { participantId: 'b' })
  await waitFor(() => providerA.awareness.getStates().size === 2, 'live awareness propagation')

  providerA.destroy()
  providerB.destroy()
  docA.destroy()
  docB.destroy()
  providerA = null
  providerB = null
  docA = null
  docB = null
  await stopRelay(relay)
  relay = null
  await assertPortReleased(port)

  const roomLog = join(dataDirectory, `${persistedRoom}.updates`)
  const roomLogStat = await stat(roomLog)
  if (roomLogStat.size <= 22) throw new Error('bundled relay did not retain a document update log')

  relay = await startRelay(executable, port, dataDirectory)
  docC = new Y.Doc()
  providerC = new WebsocketProvider(endpoint, persistedRoom, docC, { WebSocketPolyfill: WebSocket, disableBc: true })
  await waitFor(() => providerC.synced, 'empty-client synchronization after relay restart')
  await waitFor(
    () => docC.getMap('durability').get('server-only-recovery') === 'retained',
    'server-only document recovery',
  )
  if (providerC.awareness.getStates().size !== 1) throw new Error('ephemeral awareness survived relay restart')

  await runProductProviderFlow(endpoint, `product_${crypto.randomUUID().replaceAll('-', '')}`)

  providerC.destroy()
  docC.destroy()
  providerC = null
  docC = null
  await stopRelay(relay)
  relay = null
  await assertPortReleased(port)

  console.log(JSON.stringify({
    passed: true,
    executable: basename(executable),
    protocol: 'y-websocket-v1',
    processRestarted: true,
    listenerReleased: true,
    liveTwoClientConvergence: true,
    serverOnlyRecovery: true,
    partialTailRepairCoveredByRust: true,
    awarenessPersisted: false,
    productInviteRoundTrip: true,
    productProviderReopenRestored: true,
  }, null, 2))
} finally {
  providerA?.destroy()
  providerB?.destroy()
  providerC?.destroy()
  docA?.destroy()
  docB?.destroy()
  docC?.destroy()
  await stopRelay(relay)
  await rm(dataDirectory, { recursive: true, force: true })
}
