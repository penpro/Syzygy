import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(repository, 'frontend')
const Y = await import(pathToFileURL(join(frontend, 'node_modules', 'yjs', 'dist', 'yjs.mjs')).href)
const { WebsocketProvider } = await import(
  pathToFileURL(join(frontend, 'node_modules', 'y-websocket', 'src', 'y-websocket.js')).href
)
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
const token = (bytes = 32) => randomBytes(bytes).toString('base64url')
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')
const sha256Base64Url = (value) => createHash('sha256').update(value).digest('base64url')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}

async function waitFor(predicate, label, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error(`${label} did not complete within ${timeoutMilliseconds} ms`)
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

async function startRelay(executable, port, dataDirectory) {
  const child = spawn(executable, [
    '--listen', '127.0.0.1', '--port', String(port), '--data-dir', dataDirectory,
  ], { cwd: repository, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let output = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16_384) })
  child.diagnostics = () => output
  await Promise.race([
    waitFor(() => output.includes('SYZYGY_COLLABORATION_RELAY_READY'), 'relay startup'),
    new Promise((_, reject) => child.once('exit', (code) => {
      reject(new Error(`relay exited during startup (${code}): ${output}`))
    })),
  ])
  return child
}

async function stopRelay(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
  child.stdin.end()
  if (!await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])) {
    child.kill('SIGKILL')
  }
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'relay exit', 5_000)
}

function deviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return {
    binding: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: `ed25519-sha256:${sha256Base64Url(publicKeyBytes)}`,
      publicKey: publicKeyBytes.toString('base64url'),
    },
    privateKey,
  }
}

function storedMember(access, device, createdAtMs) {
  return {
    memberId: access.memberId,
    role: access.role,
    capabilitySha256: sha256Hex(access.capability),
    capabilityGeneration: access.capabilityGeneration,
    createdAtMs,
    device: device.binding,
  }
}

function signedAccessParams(roomId, access, device, issuedAtMs = Date.now(), nonce = token()) {
  const canonical = [
    'syzygy-relay-member-access-v1', roomId, access.memberId, access.capabilityGeneration,
    issuedAtMs, nonce, access.capability,
  ].join('\n')
  return {
    member: access.memberId,
    capability: access.capability,
    generation: String(access.capabilityGeneration),
    issued: String(issuedAtMs),
    nonce,
    signature: sign(null, Buffer.from(canonical), device.privateKey).toString('base64url'),
  }
}

function canonicalDevice(device) {
  return `${device.schemaVersion}\n${device.algorithm}\n${device.keyId}\n${device.publicKey}`
}

function canonicalAdminAction(action) {
  if (action.kind === 'status') return 'status'
  if (action.kind === 'issue') {
    return `issue\n${action.role}\n${action.expiresInSeconds ?? 'none'}\n${canonicalDevice(action.device)}`
  }
  if (action.kind === 'rotate') {
    return `rotate\n${action.memberId}\n${action.expiresInSeconds ?? 'none'}\n${action.device ? canonicalDevice(action.device) : 'none'}`
  }
  if (action.kind === 'revoke') return `revoke\n${action.memberId}`
  throw new Error('Unsupported relay administrator action')
}

function prepareAdminRequest(endpoint, roomId, access, device, action, expectedRevision) {
  const issuedAtMs = Date.now()
  const nonce = token()
  const params = signedAccessParams(roomId, access, device, issuedAtMs, nonce)
  const claim = {
    schemaVersion: 1,
    projectId,
    roomId,
    administratorMemberId: access.memberId,
    expectedRevision,
    issuedAtMs,
    nonce,
    actionSha256: sha256Base64Url(canonicalAdminAction(action)),
  }
  const canonicalClaim = [
    'syzygy-relay-admin-action-v1', projectId, roomId, access.memberId, expectedRevision,
    issuedAtMs, nonce, claim.actionSha256,
  ].join('\n')
  return {
    url: `${endpoint}/__syzygy_relay_admin_v1/${roomId}?${new URLSearchParams(params)}`,
    body: JSON.stringify({
      schemaVersion: 1,
      claim,
      action,
      signature: sign(null, Buffer.from(canonicalClaim), device.privateKey).toString('base64url'),
    }),
  }
}

function readVarUint(bytes, offset) {
  let value = 0
  let shift = 0
  while (offset.value < bytes.length && shift < 35) {
    const byte = bytes[offset.value++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  return null
}

function isDocumentWritePayload(data) {
  if (typeof data === 'string' || data instanceof Blob) return false
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)
  const offset = { value: 0 }
  if (readVarUint(bytes, offset) !== 0) return false
  const subtype = readVarUint(bytes, offset)
  return subtype === 1 || subtype === 2
}

class ViewerWebSocket extends WebSocket {
  send(data) {
    if (isDocumentWritePayload(data)) return
    super.send(data)
  }
}

async function sendPreparedAdminRequest(request, label, expectResponse = true) {
  const socket = new WebSocket(request.url)
  let response = null
  socket.addEventListener('open', () => socket.send(request.body), { once: true })
  await Promise.race([
    new Promise((resolvePromise) => {
      socket.addEventListener('message', (event) => {
        response = JSON.parse(String(event.data))
        resolvePromise()
      }, { once: true })
      socket.addEventListener('close', () => {
        // Node may expose CLOSED before dispatching a final buffered message. Give that event one
        // bounded turn to drain before deciding the server returned no response.
        setTimeout(resolvePromise, 25)
      }, { once: true })
    }),
    sleep(5_100).then(() => { throw new Error(`${label} exceeded its outer deadline`) }),
  ])
  socket.close()
  if (expectResponse && response === null) throw new Error(
    `${label} closed without a response: ${relay?.diagnostics?.() ?? 'no relay diagnostics'}`,
  )
  if (!expectResponse && response !== null) throw new Error(`${label} unexpectedly received a response`)
  return response
}

async function adminRequest(endpoint, roomId, access, device, action, expectedRevision, label) {
  return sendPreparedAdminRequest(
    prepareAdminRequest(endpoint, roomId, access, device, action, expectedRevision),
    label,
  )
}

function createProvider(endpoint, roomId, doc, access, device, awareness) {
  const provider = new WebsocketProvider(endpoint, roomId, doc, {
    WebSocketPolyfill: access.role === 'viewer' ? ViewerWebSocket : WebSocket,
    disableBc: true,
    maxBackoffTime: 1_000,
    params: signedAccessParams(roomId, access, device),
    ...(awareness ? { awareness } : {}),
  })
  // y-websocket emits this synchronously before scheduling setupWS. Updating its documented
  // mutable params here gives every automatically retried physical socket a fresh one-use proof.
  provider.on('connection-close', () => {
    provider.params = signedAccessParams(roomId, access, device)
  })
  return provider
}

async function assertAuthorization(endpoint, roomId, access, device, accepted, label) {
  const params = signedAccessParams(roomId, access, device)
  const socket = new WebSocket(`${endpoint}/${roomId}?${new URLSearchParams(params)}`)
  let authorizedFrame = false
  socket.addEventListener('message', () => { authorizedFrame = true }, { once: true })
  await waitFor(
    () => accepted ? authorizedFrame : socket.readyState === WebSocket.CLOSED,
    label,
    5_000,
  )
  socket.close()
  if (accepted !== authorizedFrame) throw new Error(`${label} authorization result was incorrect`)
}

function converged(documents, expected) {
  return documents.every((doc) => {
    const map = doc.getMap('soak')
    return Object.entries(expected).every(([key, value]) => map.get(key) === value)
  })
}

const executable = argumentValue('--relay-executable')
const dataDirectory = await mkdtemp(join(tmpdir(), 'syzygy-relay-admin-soak-'))
const membershipPath = join(dataDirectory, 'members-v1.json')
const port = await freePort()
const endpoint = `ws://127.0.0.1:${port}`
const roomId = `admin_soak_${crypto.randomUUID().replaceAll('-', '')}`
const projectId = `project-${crypto.randomUUID()}`
const createdAtMs = Date.now()
const roles = ['admin', 'editor', 'editor', 'viewer', 'viewer']
const devices = roles.map(() => deviceIdentity())
const accesses = roles.map((role) => ({
  memberId: token(24), capability: token(), capabilityGeneration: 1, role,
}))
const registry = {
  schemaVersion: 1,
  revision: 1,
  rooms: [{
    roomId,
    projectId,
    createdAtMs,
    members: accesses.map((access, index) => storedMember(access, devices[index], createdAtMs)),
  }],
}
const documents = roles.map(() => new Y.Doc())
let providers = []
let awarenesses = []
let relay = null

try {
  await writeFile(membershipPath, JSON.stringify(registry, null, 2), { encoding: 'utf8', flag: 'wx' })
  relay = await startRelay(executable, port, dataDirectory)

  const reusableStatus = prepareAdminRequest(endpoint, roomId, accesses[0], devices[0], { kind: 'status' }, 0)
  const status = await sendPreparedAdminRequest(reusableStatus, 'remote administrator status')
  if (!status.ok || status.room.registryRevision !== 1 || status.room.members.length !== 5) {
    throw new Error('remote administrator status did not return the five-member room')
  }
  await sendPreparedAdminRequest(reusableStatus, 'replayed administrator request', false)

  providers = documents.map((doc, index) => createProvider(endpoint, roomId, doc, accesses[index], devices[index]))
  awarenesses = providers.map((provider) => provider.awareness)
  await waitFor(() => providers.every((provider) => provider.synced), 'five-client initial synchronization')
    .catch((error) => {
      throw new Error(`${error.message}; clients=${providers.map((provider) => JSON.stringify({
        synced: provider.synced,
        connected: provider.wsconnected,
        connecting: provider.wsconnecting,
      })).join(',')}; relay=${relay?.diagnostics?.() ?? 'none'}`)
    })
  providers.forEach((provider, index) => provider.awareness.setLocalStateField('soak-client', { index }))
  await waitFor(
    () => providers.every((provider) => provider.awareness.getStates().size === 5),
    'five-client awareness convergence',
  )

  const expected = {}
  for (let writer = 0; writer < 3; writer += 1) {
    for (let sequence = 0; sequence < 20; sequence += 1) {
      const key = `rapid-${writer}-${sequence}`
      const value = `${writer}:${sequence}`
      expected[key] = value
      documents[writer].getMap('soak').set(key, value)
    }
  }
  await waitFor(() => converged(documents, expected), 'five-client rapid-edit convergence')

  providers[1].destroy()
  providers[4].destroy()
  await waitFor(
    () => [providers[0], providers[2], providers[3]].every((provider) => provider.awareness.getStates().size === 3),
    'partition awareness cleanup',
  )
  expected['connected-partition-write'] = 'connected'
  documents[0].getMap('soak').set('connected-partition-write', 'connected')
  expected['offline-partition-write'] = 'offline'
  documents[1].getMap('soak').set('offline-partition-write', 'offline')
  providers[1] = createProvider(endpoint, roomId, documents[1], accesses[1], devices[1], awarenesses[1])
  providers[4] = createProvider(endpoint, roomId, documents[4], accesses[4], devices[4], awarenesses[4])
  await waitFor(() => providers[1].synced && providers[4].synced, 'partition reconnect synchronization')
    .catch((error) => {
      throw new Error(`${error.message}; editor=${JSON.stringify({
        synced: providers[1].synced, connected: providers[1].wsconnected,
      })}; viewer=${JSON.stringify({
        synced: providers[4].synced, connected: providers[4].wsconnected,
      })}; relay=${relay?.diagnostics?.() ?? 'none'}`)
    })
  providers[1].awareness.setLocalStateField('soak-client', { index: 1 })
  providers[4].awareness.setLocalStateField('soak-client', { index: 4 })
  await waitFor(() => converged(documents, expected), 'partition merge convergence')
  await waitFor(
    () => providers.every((provider) => provider.awareness.getStates().size === 5),
    'reconnected awareness convergence',
    20_000,
  ).catch((error) => {
    throw new Error(`${error.message}; awareness=${providers.map((provider) =>
      provider.awareness.getStates().size).join(',')}; relay=${relay?.diagnostics?.() ?? 'none'}`)
  })

  let evicted = 0
  providers.forEach((provider) => provider.on('connection-close', () => { evicted += 1 }))
  const issuedDevice = deviceIdentity()
  const issued = await adminRequest(endpoint, roomId, accesses[0], devices[0], {
    kind: 'issue', role: 'viewer', expiresInSeconds: 3600, device: issuedDevice.binding,
  }, 1, 'remote member issuance')
  if (!issued.ok || issued.room.registryRevision !== 2 || issued.credential?.schemaVersion !== 3) {
    throw new Error('remote member issuance did not return a device-bound credential')
  }
  await waitFor(() => evicted === 5, 'five-client forced reauthentication')
  providers.forEach((provider) => provider.destroy())
  providers = documents.map((doc, index) => createProvider(
    endpoint, roomId, doc, accesses[index], devices[index], awarenesses[index],
  ))
  await waitFor(() => providers.every((provider) => provider.synced), 'five-client reauthentication')
  await waitFor(() => converged(documents, expected), 'post-reauth retained-state convergence')

  const stale = await adminRequest(endpoint, roomId, accesses[0], devices[0], {
    kind: 'revoke', memberId: issued.credential.memberId,
  }, 1, 'stale remote revocation')
  if (stale.ok || !stale.error?.includes('refresh')) {
    throw new Error('stale remote administrator mutation did not fail closed')
  }

  const issuedAccess = {
    memberId: issued.credential.memberId,
    capability: issued.credential.capability,
    capabilityGeneration: issued.credential.capabilityGeneration,
    role: issued.credential.role,
  }
  await assertAuthorization(endpoint, roomId, issuedAccess, issuedDevice, true, 'issued member access')
  const rotated = await adminRequest(endpoint, roomId, accesses[0], devices[0], {
    kind: 'rotate', memberId: issuedAccess.memberId, expiresInSeconds: 7200, device: null,
  }, 2, 'remote member rotation')
  if (!rotated.ok || rotated.room.registryRevision !== 3 ||
    rotated.credential?.capabilityGeneration !== 2) {
    throw new Error('remote member rotation did not increment capability generation')
  }
  await assertAuthorization(endpoint, roomId, issuedAccess, issuedDevice, false, 'pre-rotation access')
  const rotatedAccess = {
    ...issuedAccess,
    capability: rotated.credential.capability,
    capabilityGeneration: rotated.credential.capabilityGeneration,
  }
  await assertAuthorization(endpoint, roomId, rotatedAccess, issuedDevice, true, 'rotated member access')
  const revoked = await adminRequest(endpoint, roomId, accesses[0], devices[0], {
    kind: 'revoke', memberId: issuedAccess.memberId,
  }, 3, 'remote member revocation')
  if (!revoked.ok || revoked.room.registryRevision !== 4) {
    throw new Error('remote member revocation did not advance the registry')
  }
  await assertAuthorization(endpoint, roomId, rotatedAccess, issuedDevice, false, 'revoked member access')

  // Model administrator recovery without exporting or escrowing the lost key. The original admin
  // first enrolled an independent backup admin. After the original installation is treated as lost,
  // that surviving admin rotates the original member onto a replacement installation.
  providers.forEach((provider) => provider.destroy())
  providers = []
  const backupAdminDevice = deviceIdentity()
  const backupAdmin = await adminRequest(endpoint, roomId, accesses[0], devices[0], {
    kind: 'issue', role: 'admin', expiresInSeconds: null, device: backupAdminDevice.binding,
  }, 4, 'backup administrator enrollment')
  if (!backupAdmin.ok || backupAdmin.room.registryRevision !== 5 ||
    backupAdmin.credential?.role !== 'admin') {
    throw new Error('backup administrator enrollment did not return administrator access')
  }
  const backupAdminAccess = {
    memberId: backupAdmin.credential.memberId,
    capability: backupAdmin.credential.capability,
    capabilityGeneration: backupAdmin.credential.capabilityGeneration,
    role: backupAdmin.credential.role,
  }
  await assertAuthorization(
    endpoint, roomId, backupAdminAccess, backupAdminDevice, true, 'backup administrator access',
  )
  const replacementAdminDevice = deviceIdentity()
  const recoveredAdmin = await adminRequest(endpoint, roomId, backupAdminAccess, backupAdminDevice, {
    kind: 'rotate',
    memberId: accesses[0].memberId,
    expiresInSeconds: null,
    device: replacementAdminDevice.binding,
  }, 5, 'surviving administrator recovery')
  if (!recoveredAdmin.ok || recoveredAdmin.room.registryRevision !== 6 ||
    recoveredAdmin.credential?.memberId !== accesses[0].memberId ||
    recoveredAdmin.credential?.role !== 'admin' ||
    recoveredAdmin.credential?.capabilityGeneration !== 2 ||
    recoveredAdmin.credential?.deviceKeyId !== replacementAdminDevice.binding.keyId) {
    throw new Error('surviving administrator did not recover the original administrator member')
  }
  const replacementAdminAccess = {
    memberId: recoveredAdmin.credential.memberId,
    capability: recoveredAdmin.credential.capability,
    capabilityGeneration: recoveredAdmin.credential.capabilityGeneration,
    role: recoveredAdmin.credential.role,
  }
  await assertAuthorization(endpoint, roomId, accesses[0], devices[0], false, 'lost administrator access')
  await assertAuthorization(
    endpoint, roomId, replacementAdminAccess, replacementAdminDevice, true,
    'replacement administrator access',
  )
  const recoveredStatus = await adminRequest(
    endpoint, roomId, replacementAdminAccess, replacementAdminDevice,
    { kind: 'status' }, 0, 'replacement administrator status',
  )
  if (!recoveredStatus.ok || recoveredStatus.room.registryRevision !== 6) {
    throw new Error('replacement administrator could not administer the recovered room')
  }

  const stored = await readFile(membershipPath, 'utf8')
  if (stored.includes(issuedAccess.capability) || stored.includes(rotatedAccess.capability) ||
    stored.includes(backupAdminAccess.capability) || stored.includes(replacementAdminAccess.capability)) {
    throw new Error('remote administrator mutation stored a plaintext member capability')
  }

  console.log(JSON.stringify({
    passed: true,
    executable: basename(executable),
    clients: 5,
    rapidWrites: 60,
    twoClientPartitionMerged: true,
    awarenessCleanupAndRecovery: true,
    deviceBoundAdminOnly: true,
    actionBoundNativeEd25519Protocol: true,
    exactRevisionMutation: true,
    staleRevisionRejected: true,
    adminReplayRejected: true,
    roomPeersForcedToReauthenticate: true,
    remoteIssueRotateRevoke: true,
    survivingAdministratorRecovery: true,
    lostAdministratorDenied: true,
    replacementAdministratorCanAdminister: true,
    keyExportOrEscrowUsed: false,
    credentialsHashedAtRest: true,
    finalRegistryRevision: recoveredStatus.room.registryRevision,
  }, null, 2))
} finally {
  providers.forEach((provider) => provider.destroy())
  awarenesses.forEach((awareness) => awareness.destroy())
  documents.forEach((doc) => doc.destroy())
  await stopRelay(relay)
  await rm(dataDirectory, { recursive: true, force: true })
}
