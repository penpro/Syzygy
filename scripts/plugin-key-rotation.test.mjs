import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  canonicalPublisherKeyRotation,
  createPluginPublisherKeyRotation,
} from './plugin-key-rotation.mjs'

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'syzygy-plugin-rotation-'))
  const from = generateKeyPairSync('ed25519')
  const to = generateKeyPairSync('ed25519')
  const fromPath = join(root, 'from.pem')
  const toPath = join(root, 'to.pem')
  const outputPath = join(root, 'rotation.json')
  writeFileSync(fromPath, from.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(toPath, to.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { root, from, to, fromPath, toPath, outputPath }
}

test('rotation generator emits one plugin/version/sequence-bound certificate signed by both keys', () => {
  const current = fixture()
  try {
    const report = createPluginPublisherKeyRotation({
      pluginId: 'org.example.research',
      sequence: 1,
      effectiveVersion: '2.0.0',
      fromPrivateKeyPath: current.fromPath,
      toPrivateKeyPath: current.toPath,
      fromPublisherName: 'Independent publisher',
      toPublisherName: 'Independent publisher',
      outputPath: current.outputPath,
    })
    assert.equal(report.status, 'publisher-key-rotation-created')
    assert.equal(report.sequence, 1)
    assert.notEqual(report.fromKeyId, report.toKeyId)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY/)
    const rotation = JSON.parse(readFileSync(current.outputPath, 'utf8'))
    const claim = canonicalPublisherKeyRotation(rotation)
    assert.equal(claim.toString('utf8').split('\n')[0], 'syzygy-plugin-publisher-key-rotation-v1')
    assert.equal(verify(
      null, claim, current.from.publicKey, Buffer.from(rotation.signatures.from, 'base64url'),
    ), true)
    assert.equal(verify(
      null, claim, current.to.publicKey, Buffer.from(rotation.signatures.to, 'base64url'),
    ), true)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('rotation generator refuses same-key rotation, invalid sequence, and output overwrite', () => {
  const current = fixture()
  try {
    const base = {
      pluginId: 'org.example.research',
      sequence: 1,
      effectiveVersion: '2.0.0',
      fromPrivateKeyPath: current.fromPath,
      toPrivateKeyPath: current.toPath,
      fromPublisherName: 'Independent publisher',
      toPublisherName: 'Independent publisher',
      outputPath: current.outputPath,
    }
    assert.throws(() => createPluginPublisherKeyRotation({
      ...base, toPrivateKeyPath: current.fromPath,
    }), /different new key/)
    assert.throws(() => createPluginPublisherKeyRotation({ ...base, sequence: 0 }), /sequence/)
    createPluginPublisherKeyRotation(base)
    assert.throws(() => createPluginPublisherKeyRotation(base), /already exists/)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})
