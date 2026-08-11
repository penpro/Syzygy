import { spawn } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(root, 'frontend')
const executable = join(
  frontend,
  'src-tauri',
  'target',
  'debug',
  `collaboration-identity-harness${process.platform === 'win32' ? '.exe' : ''}`,
)
const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 512 * 1024

function runBounded(command, args, { cwd, deadlineMs, label }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    const heartbeat = setInterval(() => process.stderr.write(`[identity-interop] ${label} active\n`), 10_000)
    const deadline = setTimeout(() => {
      if (!settled) child.kill()
      finish(new Error(`${label} exceeded its ${Math.ceil(deadlineMs / 1000)} second deadline`))
    }, deadlineMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      clearTimeout(deadline)
      if (error) reject(error)
      else resolveRun(value)
    }
    const collect = (current, chunk, limit, stream) => {
      const next = Buffer.concat([current, chunk])
      if (next.byteLength > limit) {
        child.kill()
        finish(new Error(`${label} exceeded its ${stream} output bound`))
      }
      return next
    }
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk, MAX_STDOUT, 'stdout') })
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk, MAX_STDERR, 'stderr') })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`${label} failed (exit=${code}, signal=${signal ?? 'none'}): ${stderr.toString('utf8').trim()}`))
        return
      }
      finish(null, { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
    })
  })
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, expected) {
  return record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function decodeBase64Url(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.includes('=')) {
    throw new Error('Rust proof used malformed base64url')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
    throw new Error('Rust proof used noncanonical or incorrectly sized base64url')
  }
  return decoded
}

function parseProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') throw new Error('Rust proof header was not exact')
  if (!exactKeys(value.claim, [
    'schemaVersion', 'projectId', 'documentId', 'participantId', 'awarenessClientId', 'sessionNonce',
  ]) || value.claim.schemaVersion !== 1) throw new Error('Rust proof claim was not exact')
  for (const id of [value.claim.projectId, value.claim.documentId, value.claim.participantId]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(id)) {
      throw new Error('Rust proof contained an invalid stable ID')
    }
  }
  if (!Number.isSafeInteger(value.claim.awarenessClientId) || value.claim.awarenessClientId < 0 ||
    value.claim.awarenessClientId > 0xffff_ffff) throw new Error('Rust proof client ID was out of bounds')
  decodeBase64Url(value.claim.sessionNonce, 32)
  const publicKey = decodeBase64Url(value.publicKey, 32)
  decodeBase64Url(value.signature, 64)
  const keyId = `ed25519-sha256:${createHash('sha256').update(publicKey).digest('base64url')}`
  if (value.keyId !== keyId) throw new Error('Rust proof key ID did not match its public key')
  return value
}

function canonicalClaim(claim) {
  return Buffer.from([
    'syzygy-device-presence-v1',
    claim.projectId,
    claim.documentId,
    claim.participantId,
    String(claim.awarenessClientId),
    claim.sessionNonce,
  ].join('\n'), 'utf8')
}

async function verifies(proof) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    decodeBase64Url(proof.publicKey, 32),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return webcrypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    decodeBase64Url(proof.signature, 64),
    canonicalClaim(proof.claim),
  )
}

const build = await runBounded('cargo', [
  'build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'collaboration-identity-harness',
], { cwd: frontend, deadlineMs: 120_000, label: 'Rust identity harness build' })
if (!build.stderr.includes('Finished')) throw new Error('Cargo did not report a finished identity harness build')

const run = await runBounded(executable, [], {
  cwd: frontend,
  deadlineMs: 30_000,
  label: 'Rust identity proof process',
})
const lines = run.stdout.trim().split(/\r?\n/)
if (lines.length !== 1) throw new Error('Rust identity harness did not emit exactly one JSON record')
const proof = parseProof(JSON.parse(lines[0]))
if (!await verifies(proof)) throw new Error('WebCrypto rejected the canonical Rust signature')

const mutations = [
  { ...proof, claim: { ...proof.claim, projectId: 'project-mutated' } },
  { ...proof, claim: { ...proof.claim, documentId: 'document-mutated' } },
  { ...proof, claim: { ...proof.claim, participantId: 'participant-mutated' } },
  { ...proof, claim: { ...proof.claim, awarenessClientId: proof.claim.awarenessClientId - 1 } },
]
for (const mutation of mutations) {
  if (await verifies(mutation)) throw new Error('WebCrypto accepted a mutated Rust claim')
}
const serialized = JSON.stringify(proof).toLowerCase()
if (['privatekey', 'private_key', 'pkcs8', 'secret'].some((term) => serialized.includes(term))) {
  throw new Error('Rust identity harness exposed private-material naming')
}

console.log(JSON.stringify({
  schemaVersion: 1,
  rustToWebCryptoVerified: true,
  rejectedSignedClaimMutations: mutations.length,
  privateMaterialExposed: false,
  exactSameSessionReplayRejected: false,
  replayBoundary: 'proof binds project, document, participant, awareness client, and random session nonce; no trusted clock or revocation authority exists yet',
}))
