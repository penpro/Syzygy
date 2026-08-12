import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  canonicalPluginJson,
  canonicalPublisherClaim,
  createPublisherPrivateKey,
  signPluginPackage,
} from './plugin-signer.mjs'

const example = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'plugins', 'citation-auditor')

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'syzygy-plugin-signer-'))
  const packageRoot = join(root, 'package')
  cpSync(example, packageRoot, { recursive: true })
  rmSync(join(packageRoot, 'syzygy-plugin-signature.json'))
  const keys = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'publisher-private.pem')
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { root, packageRoot, privateKeyPath, keys }
}

test('signer emits an app-compatible domain-separated publisher proof without executing the component', () => {
  const current = fixture()
  try {
    const report = signPluginPackage(current.packageRoot, {
      privateKeyPath: current.privateKeyPath,
      publisherName: 'Independent fixture publisher',
    })
    assert.equal(report.status, 'publisher-signed')
    assert.equal(report.plugin.id, 'org.example.citation-auditor')
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY/)
    const proof = JSON.parse(readFileSync(join(current.packageRoot, 'syzygy-plugin-signature.json'), 'utf8'))
    assert.equal(proof.schemaVersion, 1)
    assert.equal(proof.algorithm, 'Ed25519')
    assert.match(proof.publisher.keyId, /^ed25519-sha256:[A-Za-z0-9_-]{43}$/)
    assert.equal(proof.publisher.publicKey.length, 43)
    assert.equal(proof.signature.length, 86)
    assert.equal(canonicalPublisherClaim(proof).toString('utf8').split('\n')[0],
      'syzygy-plugin-publisher-signature-v1')
    assert.equal(verify(
      null,
      canonicalPublisherClaim(proof),
      current.keys.publicKey,
      Buffer.from(proof.signature, 'base64url'),
    ), true)
    const manifest = JSON.parse(readFileSync(join(current.packageRoot, 'syzygy-plugin.json'), 'utf8'))
    assert.equal(proof.package.manifestSha256,
      createHash('sha256').update(canonicalPluginJson(manifest)).digest('hex'))
    assert.equal(proof.package.componentSha256,
      createHash('sha256').update(readFileSync(join(current.packageRoot, manifest.runtime.component))).digest('hex'))
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('signer refuses key substitution, output overwrite, and output-path escape', () => {
  const current = fixture()
  try {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPath = join(current.root, 'rsa-private.pem')
    writeFileSync(rsaPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    assert.throws(() => signPluginPackage(current.packageRoot, {
      privateKeyPath: rsaPath,
      publisherName: 'Wrong key',
    }), /must be Ed25519/)
    assert.throws(() => signPluginPackage(current.packageRoot, {
      privateKeyPath: current.privateKeyPath,
      publisherName: 'Publisher',
      outputName: '../escaped.json',
    }), /inside the plugin package/)
    signPluginPackage(current.packageRoot, {
      privateKeyPath: current.privateKeyPath,
      publisherName: 'Publisher',
    })
    assert.throws(() => signPluginPackage(current.packageRoot, {
      privateKeyPath: current.privateKeyPath,
      publisherName: 'Publisher',
    }), /already exists/)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})

test('publisher key generation is explicit, Ed25519, non-overwriting, and usable by the signer', () => {
  const current = fixture()
  try {
    const generatedPath = join(current.root, 'generated-private.pem')
    assert.equal(createPublisherPrivateKey(generatedPath), generatedPath)
    assert.throws(() => createPublisherPrivateKey(generatedPath), /already exists/)
    const report = signPluginPackage(current.packageRoot, {
      privateKeyPath: generatedPath,
      publisherName: 'Generated-key publisher',
    })
    assert.equal(report.status, 'publisher-signed')
    assert.doesNotMatch(readFileSync(join(current.packageRoot, 'syzygy-plugin-signature.json'), 'utf8'),
      /PRIVATE KEY/)
  } finally {
    rmSync(current.root, { recursive: true, force: true })
  }
})
