import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  MAX_REQUEST_MS,
  assertNodeId,
  boundedTimeout,
  createAgentChannel,
  createAgentProof,
  createServerChannel,
  deriveSessionKeys,
  isPrivateListenAddress,
  verifyAgentProof,
} from './lan-bridge-protocol.mjs'

test('pairing proof authenticates the exact node and nonce tuple', () => {
  const key = randomBytes(32)
  const serverNonce = randomBytes(32)
  const clientNonce = randomBytes(32)
  const proof = createAgentProof(key, 'office-a', serverNonce, clientNonce)
  assert.equal(verifyAgentProof(key, 'office-a', serverNonce, clientNonce, proof), true)
  assert.equal(verifyAgentProof(key, 'office-b', serverNonce, clientNonce, proof), false)
  assert.equal(verifyAgentProof(randomBytes(32), 'office-a', serverNonce, clientNonce, proof), false)
})

test('encrypted channels round-trip in both directions and reject replay', () => {
  const key = randomBytes(32)
  const keys = deriveSessionKeys(key, 'office-a', randomBytes(32), randomBytes(32))
  const agent = createAgentChannel('office-a', keys)
  const server = createServerChannel('office-a', keys)
  const request = server.encode({ type: 'request', requestId: 'one', method: 'tools/list' })
  assert.deepEqual(agent.decode(request), { type: 'request', requestId: 'one', method: 'tools/list' })
  assert.throws(() => agent.decode(request), /sequence mismatch/)
  const response = agent.encode({ type: 'response', requestId: 'one', ok: true, result: {} })
  assert.deepEqual(server.decode(response), { type: 'response', requestId: 'one', ok: true, result: {} })
})

test('encrypted channels reject authenticated-frame tampering', () => {
  const key = randomBytes(32)
  const keys = deriveSessionKeys(key, 'office-a', randomBytes(32), randomBytes(32))
  const agent = createAgentChannel('office-a', keys)
  const server = createServerChannel('office-a', keys)
  const frame = JSON.parse(server.encode({ type: 'heartbeat' }))
  const ciphertext = Buffer.from(frame.ciphertext, 'base64url')
  ciphertext[0] ^= 1
  frame.ciphertext = ciphertext.toString('base64url')
  assert.throws(() => agent.decode(JSON.stringify(frame)), /authentication failed/)
})

test('node identities and operation deadlines are bounded', () => {
  assert.equal(assertNodeId('office-a.local'), 'office-a.local')
  assert.throws(() => assertNodeId('../office-a'), /node ID/)
  assert.equal(boundedTimeout(undefined), 20_000)
  assert.equal(boundedTimeout(MAX_REQUEST_MS), MAX_REQUEST_MS)
  assert.throws(() => boundedTimeout(MAX_REQUEST_MS + 1), /timeoutMs/)
})

test('private coordinator bind rejects wildcard and public addresses', () => {
  assert.equal(isPrivateListenAddress('127.0.0.1'), true)
  assert.equal(isPrivateListenAddress('192.168.1.20'), true)
  assert.equal(isPrivateListenAddress('10.10.0.4'), true)
  assert.equal(isPrivateListenAddress('172.31.2.9'), true)
  assert.equal(isPrivateListenAddress('0.0.0.0'), false)
  assert.equal(isPrivateListenAddress('8.8.8.8'), false)
  assert.equal(isPrivateListenAddress('coordinator.local'), false)
})