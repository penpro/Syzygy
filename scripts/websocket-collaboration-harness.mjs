import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(repository, 'frontend')
const serverEntry = join(frontend, 'node_modules', '@y', 'websocket-server', 'src', 'server.js')
const yjsEntry = pathToFileURL(join(frontend, 'node_modules', 'yjs', 'dist', 'yjs.mjs')).href
const websocketEntry = pathToFileURL(join(frontend, 'node_modules', 'y-websocket', 'src', 'y-websocket.js')).href
const Y = await import(yjsEntry)
const { WebsocketProvider } = await import(websocketEntry)

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a relay port')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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

async function startRelay(port) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: frontend,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4_096) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4_096) })
  await Promise.race([
    waitFor(() => output.includes('running at'), 'relay startup', 10_000),
    new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`relay exited during startup (${code}): ${output}`)))),
  ])
  return child
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }),
  ])
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    'relay process exit',
    5_000,
  )
}

const port = await freePort()
const endpoint = `ws://127.0.0.1:${port}`
const room = `syzygy-harness-${crypto.randomUUID()}`
const docA = new Y.Doc()
const docB = new Y.Doc()
const providerA = new WebsocketProvider(endpoint, room, docA, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
  maxBackoffTime: 500,
})
const providerB = new WebsocketProvider(endpoint, room, docB, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
  maxBackoffTime: 500,
})
let relay = null

try {
  relay = await startRelay(port)
  await waitFor(() => providerA.synced && providerB.synced, 'initial two-client synchronization')

  const mapA = docA.getMap('probe')
  const mapB = docB.getMap('probe')
  mapA.set('beforeRestart', 'alpha')
  await waitFor(() => mapB.get('beforeRestart') === 'alpha', 'first-client update propagation')

  providerA.awareness.setLocalStateField('syzygyHarness', { participantId: 'a' })
  providerB.awareness.setLocalStateField('syzygyHarness', { participantId: 'b' })
  await waitFor(
    () => providerA.awareness.getStates().size === 2 && providerB.awareness.getStates().size === 2,
    'two-client awareness propagation',
  )

  await stopRelay(relay)
  relay = null
  await waitFor(() => !providerA.wsconnected && !providerB.wsconnected, 'relay disconnect observation')

  mapA.set('offlineA', 'one')
  mapB.set('offlineB', 'two')
  relay = await startRelay(port)
  await waitFor(() => providerA.synced && providerB.synced, 'post-restart synchronization', 15_000)
  await waitFor(
    () => mapA.get('offlineB') === 'two' && mapB.get('offlineA') === 'one' && mapB.get('beforeRestart') === 'alpha',
    'post-restart partition convergence',
    15_000,
  )

  providerB.disconnect()
  await waitFor(() => providerA.awareness.getStates().size === 1, 'stale awareness removal')

  console.log(JSON.stringify({
    passed: true,
    protocol: 'y-websocket-v1',
    clients: 2,
    relayRestarted: true,
    partitionedEditsConverged: true,
    awarenessPropagated: true,
    staleAwarenessRemoved: true,
    serverRetainedDocumentState: false,
  }, null, 2))
} finally {
  providerA.destroy()
  providerB.destroy()
  docA.destroy()
  docB.destroy()
  await stopRelay(relay)
}
