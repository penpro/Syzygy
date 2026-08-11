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

function parsePresenceProof(value) {
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

function parseRegistrationProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') throw new Error('Rust registration header was not exact')
  if (!exactKeys(value.claim, ['schemaVersion', 'projectId', 'participantId']) ||
    value.claim.schemaVersion !== 1) throw new Error('Rust registration claim was not exact')
  for (const id of [value.claim.projectId, value.claim.participantId]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(id)) {
      throw new Error('Rust registration contained an invalid stable ID')
    }
  }
  const publicKey = decodeBase64Url(value.publicKey, 32)
  decodeBase64Url(value.signature, 64)
  const keyId = `ed25519-sha256:${createHash('sha256').update(publicKey).digest('base64url')}`
  if (value.keyId !== keyId) throw new Error('Rust registration key ID did not match its public key')
  return value
}

function parseRelayAccessProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new Error('Rust relay access proof header was not exact')
  }
  if (!exactKeys(value.claim, [
    'schemaVersion', 'roomId', 'memberId', 'capabilityGeneration', 'issuedAtMs', 'nonce', 'capability',
  ]) || value.claim.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.claim.roomId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.claim.memberId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.claim.capability) ||
    !Number.isSafeInteger(value.claim.capabilityGeneration) || value.claim.capabilityGeneration < 1 ||
    !Number.isSafeInteger(value.claim.issuedAtMs) || value.claim.issuedAtMs < 1) {
    throw new Error('Rust relay access proof claim was not exact')
  }
  decodeBase64Url(value.claim.nonce, 32)
  decodeBase64Url(value.signature, 64)
  if (!/^ed25519-sha256:[A-Za-z0-9_-]{43}$/.test(value.keyId)) {
    throw new Error('Rust relay access proof key ID was malformed')
  }
  return value
}

function parseRelayAdminProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new Error('Rust relay administrator proof header was not exact')
  }
  if (!exactKeys(value.claim, [
    'schemaVersion', 'projectId', 'roomId', 'administratorMemberId', 'expectedRevision',
    'issuedAtMs', 'nonce', 'actionSha256',
  ]) || value.claim.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.claim.projectId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.claim.roomId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.claim.administratorMemberId) ||
    !Number.isSafeInteger(value.claim.expectedRevision) || value.claim.expectedRevision < 0 ||
    !Number.isSafeInteger(value.claim.issuedAtMs) || value.claim.issuedAtMs < 1) {
    throw new Error('Rust relay administrator proof claim was not exact')
  }
  decodeBase64Url(value.claim.nonce, 32)
  decodeBase64Url(value.claim.actionSha256, 32)
  decodeBase64Url(value.signature, 64)
  if (!/^ed25519-sha256:[A-Za-z0-9_-]{43}$/.test(value.keyId)) {
    throw new Error('Rust relay administrator proof key ID was malformed')
  }
  return value
}

function parseRelayAdminDecisionProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new Error('Rust project relay administrator decision proof header was not exact')
  }
  if (!exactKeys(value.claim, [
    'schemaVersion', 'projectId', 'roomId', 'administratorMemberId', 'expectedRevision',
    'resultingRevision', 'affectedMemberId', 'actionSha256', 'recordedAtMs', 'decisionNonce',
  ]) || value.claim.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.claim.projectId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.claim.roomId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.claim.administratorMemberId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.claim.affectedMemberId) ||
    !Number.isSafeInteger(value.claim.expectedRevision) || value.claim.expectedRevision < 1 ||
    value.claim.resultingRevision !== value.claim.expectedRevision + 1 ||
    !Number.isSafeInteger(value.claim.recordedAtMs) || value.claim.recordedAtMs < 1) {
    throw new Error('Rust project relay administrator decision claim was not exact')
  }
  decodeBase64Url(value.claim.actionSha256, 32)
  decodeBase64Url(value.claim.decisionNonce, 32)
  decodeBase64Url(value.publicKey, 32)
  decodeBase64Url(value.signature, 64)
  if (!/^ed25519-sha256:[A-Za-z0-9_-]{43}$/.test(value.keyId)) {
    throw new Error('Rust project relay administrator decision key ID was malformed')
  }
  return value
}

function parseRelayAdminApprovalProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new Error('Rust project relay administrator approval proof header was not exact')
  }
  if (!exactKeys(value.claim, [
    'schemaVersion', 'projectId', 'roomId', 'expectedRevision', 'actionSha256',
    'approvedAtMs', 'expiresAtMs', 'approvalNonce',
  ]) || value.claim.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.claim.projectId) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.claim.roomId) ||
    !Number.isSafeInteger(value.claim.expectedRevision) || value.claim.expectedRevision < 1 ||
    !Number.isSafeInteger(value.claim.approvedAtMs) || value.claim.approvedAtMs < 1 ||
    !Number.isSafeInteger(value.claim.expiresAtMs) ||
    value.claim.expiresAtMs <= value.claim.approvedAtMs ||
    value.claim.expiresAtMs - value.claim.approvedAtMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('Rust project relay administrator approval claim was not exact')
  }
  decodeBase64Url(value.claim.actionSha256, 32)
  decodeBase64Url(value.claim.approvalNonce, 32)
  decodeBase64Url(value.publicKey, 32)
  decodeBase64Url(value.signature, 64)
  if (!/^ed25519-sha256:[A-Za-z0-9_-]{43}$/.test(value.keyId)) {
    throw new Error('Rust project relay administrator approval key ID was malformed')
  }
  return value
}

function parseResearchEventProof(value) {
  if (!exactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'publicKey', 'claim', 'signature']) ||
    value.schemaVersion !== 1 || value.algorithm !== 'Ed25519') {
    throw new Error('Rust project research event proof header was not exact')
  }
  if (!exactKeys(value.claim, [
    'schemaVersion', 'projectId', 'participantId', 'eventKind', 'eventId', 'eventSha256',
    'recordedAtMs', 'attestationNonce',
  ]) || value.claim.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.claim.projectId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.claim.participantId) ||
    !['scenario', 'scenario-turn', 'scenario-vote', 'scenario-annotation', 'scenario-label',
      'suggestion', 'policy-version', 'adversarial-review', 'heuristic', 'scenario-rerun']
      .includes(value.claim.eventKind) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/.test(value.claim.eventId) ||
    !Number.isSafeInteger(value.claim.recordedAtMs) || value.claim.recordedAtMs < 1) {
    throw new Error('Rust project research event claim was not exact')
  }
  decodeBase64Url(value.claim.eventSha256, 32)
  decodeBase64Url(value.claim.attestationNonce, 32)
  const publicKey = decodeBase64Url(value.publicKey, 32)
  decodeBase64Url(value.signature, 64)
  const keyId = `ed25519-sha256:${createHash('sha256').update(publicKey).digest('base64url')}`
  if (value.keyId !== keyId) throw new Error('Rust project research event key ID did not match its public key')
  return value
}

function canonicalPresenceClaim(claim) {
  return Buffer.from([
    'syzygy-device-presence-v1',
    claim.projectId,
    claim.documentId,
    claim.participantId,
    String(claim.awarenessClientId),
    claim.sessionNonce,
  ].join('\n'), 'utf8')
}

function canonicalRegistrationClaim(claim) {
  return Buffer.from([
    'syzygy-project-device-registration-v1',
    claim.projectId,
    claim.participantId,
  ].join('\n'), 'utf8')
}

function canonicalRelayAccessClaim(claim) {
  return Buffer.from([
    'syzygy-relay-member-access-v1',
    claim.roomId,
    claim.memberId,
    String(claim.capabilityGeneration),
    String(claim.issuedAtMs),
    claim.nonce,
    claim.capability,
  ].join('\n'), 'utf8')
}

function canonicalRelayAdminClaim(claim) {
  return Buffer.from([
    'syzygy-relay-admin-action-v1',
    claim.projectId,
    claim.roomId,
    claim.administratorMemberId,
    String(claim.expectedRevision),
    String(claim.issuedAtMs),
    claim.nonce,
    claim.actionSha256,
  ].join('\n'), 'utf8')
}

function canonicalRelayAdminDecisionClaim(claim) {
  return Buffer.from([
    'syzygy-project-relay-admin-decision-v1',
    claim.projectId,
    claim.roomId,
    claim.administratorMemberId,
    String(claim.expectedRevision),
    String(claim.resultingRevision),
    claim.affectedMemberId,
    claim.actionSha256,
    String(claim.recordedAtMs),
    claim.decisionNonce,
  ].join('\n'), 'utf8')
}

function canonicalRelayAdminApprovalClaim(claim) {
  return Buffer.from([
    'syzygy-project-relay-admin-approval-v1',
    claim.projectId,
    claim.roomId,
    String(claim.expectedRevision),
    claim.actionSha256,
    String(claim.approvedAtMs),
    String(claim.expiresAtMs),
    claim.approvalNonce,
  ].join('\n'), 'utf8')
}

function canonicalResearchEventClaim(claim) {
  return Buffer.from([
    'syzygy-project-research-event-v1',
    claim.projectId,
    claim.participantId,
    claim.eventKind,
    claim.eventId,
    claim.eventSha256,
    String(claim.recordedAtMs),
    claim.attestationNonce,
  ].join('\n'), 'utf8')
}

async function verifies(proof, canonicalClaim) {
  return verifiesWithPublicKey(proof, canonicalClaim, proof.publicKey)
}

async function verifiesWithPublicKey(proof, canonicalClaim, publicKey) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    decodeBase64Url(publicKey, 32),
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
const output = JSON.parse(lines[0])
if (!exactKeys(output, [
  'presence', 'registration', 'relayAccess', 'relayAdmin', 'relayAdminDecision', 'relayAdminApproval',
  'researchEvent',
])) {
  throw new Error('Rust identity harness output was not exact')
}
const proof = parsePresenceProof(output.presence)
const registration = parseRegistrationProof(output.registration)
const relayAccess = parseRelayAccessProof(output.relayAccess)
const relayAdmin = parseRelayAdminProof(output.relayAdmin)
const relayAdminDecision = parseRelayAdminDecisionProof(output.relayAdminDecision)
const relayAdminApproval = parseRelayAdminApprovalProof(output.relayAdminApproval)
const researchEvent = parseResearchEventProof(output.researchEvent)
if (proof.keyId !== registration.keyId || proof.keyId !== relayAccess.keyId ||
  proof.keyId !== relayAdmin.keyId || proof.keyId !== relayAdminDecision.keyId ||
  proof.keyId !== relayAdminApproval.keyId || proof.keyId !== researchEvent.keyId ||
  proof.publicKey !== registration.publicKey ||
  proof.publicKey !== relayAdminDecision.publicKey || proof.publicKey !== relayAdminApproval.publicKey ||
  proof.publicKey !== researchEvent.publicKey) {
  throw new Error('Rust identity harness did not reuse one installation key')
}
if (!await verifies(proof, canonicalPresenceClaim)) {
  throw new Error('WebCrypto rejected the canonical Rust presence signature')
}
if (!await verifies(registration, canonicalRegistrationClaim)) {
  throw new Error('WebCrypto rejected the canonical Rust registration signature')
}
if (!await verifiesWithPublicKey(relayAccess, canonicalRelayAccessClaim, proof.publicKey)) {
  throw new Error('WebCrypto rejected the canonical Rust relay access signature')
}
if (!await verifiesWithPublicKey(relayAdmin, canonicalRelayAdminClaim, proof.publicKey)) {
  throw new Error('WebCrypto rejected the canonical Rust relay administrator signature')
}
if (!await verifies(relayAdminDecision, canonicalRelayAdminDecisionClaim)) {
  throw new Error('WebCrypto rejected the canonical Rust project relay administrator decision signature')
}
if (!await verifies(relayAdminApproval, canonicalRelayAdminApprovalClaim)) {
  throw new Error('WebCrypto rejected the canonical Rust project relay administrator approval signature')
}
if (!await verifies(researchEvent, canonicalResearchEventClaim)) {
  throw new Error('WebCrypto rejected the canonical Rust project research event signature')
}

const mutations = [
  { ...proof, claim: { ...proof.claim, projectId: 'project-mutated' } },
  { ...proof, claim: { ...proof.claim, documentId: 'document-mutated' } },
  { ...proof, claim: { ...proof.claim, participantId: 'participant-mutated' } },
  { ...proof, claim: { ...proof.claim, awarenessClientId: proof.claim.awarenessClientId - 1 } },
]
for (const mutation of mutations) {
  if (await verifies(mutation, canonicalPresenceClaim)) throw new Error('WebCrypto accepted a mutated Rust claim')
}
const registrationMutations = [
  { ...registration, claim: { ...registration.claim, projectId: 'project-mutated' } },
  { ...registration, claim: { ...registration.claim, participantId: 'participant-mutated' } },
]
for (const mutation of registrationMutations) {
  if (await verifies(mutation, canonicalRegistrationClaim)) {
    throw new Error('WebCrypto accepted a mutated Rust project registration')
  }
}
const relayAccessMutations = [
  { ...relayAccess, claim: { ...relayAccess.claim, roomId: `room_${'z'.repeat(40)}` } },
  { ...relayAccess, claim: { ...relayAccess.claim, memberId: `member_${'z'.repeat(24)}` } },
  { ...relayAccess, claim: { ...relayAccess.claim, capabilityGeneration: 8 } },
  { ...relayAccess, claim: { ...relayAccess.claim, issuedAtMs: relayAccess.claim.issuedAtMs + 1 } },
  { ...relayAccess, claim: { ...relayAccess.claim, nonce: 'z'.repeat(43) } },
  { ...relayAccess, claim: { ...relayAccess.claim, capability: 'z'.repeat(43) } },
]
for (const mutation of relayAccessMutations) {
  if (await verifiesWithPublicKey(mutation, canonicalRelayAccessClaim, proof.publicKey)) {
    throw new Error('WebCrypto accepted a mutated Rust relay access claim')
  }
}
const relayAdminMutations = [
  { ...relayAdmin, claim: { ...relayAdmin.claim, projectId: 'project-mutated' } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, roomId: `room_${'z'.repeat(40)}` } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, administratorMemberId: `member_${'z'.repeat(24)}` } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, expectedRevision: 12 } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, issuedAtMs: relayAdmin.claim.issuedAtMs + 1 } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, nonce: 'z'.repeat(43) } },
  { ...relayAdmin, claim: { ...relayAdmin.claim, actionSha256: 'z'.repeat(43) } },
]
for (const mutation of relayAdminMutations) {
  if (await verifiesWithPublicKey(mutation, canonicalRelayAdminClaim, proof.publicKey)) {
    throw new Error('WebCrypto accepted a mutated Rust relay administrator claim')
  }
}
const relayAdminDecisionMutations = [
  { ...relayAdminDecision, claim: { ...relayAdminDecision.claim, projectId: 'project-mutated' } },
  { ...relayAdminDecision, claim: { ...relayAdminDecision.claim, resultingRevision: 13 } },
  { ...relayAdminDecision, claim: { ...relayAdminDecision.claim, affectedMemberId: `member_${'z'.repeat(24)}` } },
  { ...relayAdminDecision, claim: { ...relayAdminDecision.claim, actionSha256: 'z'.repeat(43) } },
]
for (const mutation of relayAdminDecisionMutations) {
  if (await verifies(mutation, canonicalRelayAdminDecisionClaim)) {
    throw new Error('WebCrypto accepted a mutated Rust project relay administrator decision')
  }
}
const relayAdminApprovalMutations = [
  { ...relayAdminApproval, claim: { ...relayAdminApproval.claim, projectId: 'project-mutated' } },
  { ...relayAdminApproval, claim: { ...relayAdminApproval.claim, expectedRevision: 12 } },
  { ...relayAdminApproval, claim: { ...relayAdminApproval.claim, actionSha256: 'z'.repeat(43) } },
  { ...relayAdminApproval, claim: { ...relayAdminApproval.claim, expiresAtMs: relayAdminApproval.claim.expiresAtMs + 1 } },
  { ...relayAdminApproval, claim: { ...relayAdminApproval.claim, approvalNonce: 'z'.repeat(43) } },
]
for (const mutation of relayAdminApprovalMutations) {
  if (await verifies(mutation, canonicalRelayAdminApprovalClaim)) {
    throw new Error('WebCrypto accepted a mutated Rust project relay administrator approval')
  }
}
const researchEventMutations = [
  { ...researchEvent, claim: { ...researchEvent.claim, projectId: 'project-mutated' } },
  { ...researchEvent, claim: { ...researchEvent.claim, participantId: 'participant-mutated' } },
  { ...researchEvent, claim: { ...researchEvent.claim, eventKind: 'scenario-label' } },
  { ...researchEvent, claim: { ...researchEvent.claim, eventId: 'event-mutated' } },
  { ...researchEvent, claim: { ...researchEvent.claim, eventSha256: 'z'.repeat(43) } },
  { ...researchEvent, claim: { ...researchEvent.claim, recordedAtMs: researchEvent.claim.recordedAtMs + 1 } },
  { ...researchEvent, claim: { ...researchEvent.claim, attestationNonce: 'z'.repeat(43) } },
]
for (const mutation of researchEventMutations) {
  if (await verifies(mutation, canonicalResearchEventClaim)) {
    throw new Error('WebCrypto accepted a mutated Rust project research event')
  }
}
const serialized = JSON.stringify(output).toLowerCase()
if (['privatekey', 'private_key', 'pkcs8', 'secret'].some((term) => serialized.includes(term))) {
  throw new Error('Rust identity harness exposed private-material naming')
}

console.log(JSON.stringify({
  schemaVersion: 1,
  rustToWebCryptoVerified: true,
  rejectedSignedClaimMutations: mutations.length,
  durableRegistrationVerified: true,
  rejectedRegistrationMutations: registrationMutations.length,
  oneInstallationKeyReused: true,
  relayAccessVerified: true,
  rejectedRelayAccessMutations: relayAccessMutations.length,
  relayAdminVerified: true,
  rejectedRelayAdminMutations: relayAdminMutations.length,
  relayAdminDecisionVerified: true,
  rejectedRelayAdminDecisionMutations: relayAdminDecisionMutations.length,
  relayAdminApprovalVerified: true,
  rejectedRelayAdminApprovalMutations: relayAdminApprovalMutations.length,
  researchEventVerified: true,
  rejectedResearchEventMutations: researchEventMutations.length,
  privateMaterialExposed: false,
  exactSameSessionReplayRejected: false,
  replayBoundary: 'presence proof binds project, document, participant, awareness client, and random session nonce but remains replayable in that exact awareness context; relay access uses a separate fresh-proof boundary',
}))
