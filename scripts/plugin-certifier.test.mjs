import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { certifyPluginPackage, evaluateAuthority, safePackagePath } from './plugin-certifier.mjs'

const example = resolve('..', 'examples', 'plugins', 'citation-auditor')

test('example package passes contract certification without execution', () => {
  const report = certifyPluginPackage(example)
  assert.equal(report.passed, true)
  assert.equal(report.status, 'contract-certified')
  assert.equal(report.plugin.id, 'org.example.citation-auditor')
  assert.equal(report.runtimeArtifactPresent, true)
  assert.match(report.warnings.join(' '), /not execution/)
})

test('authority checks deny undeclared capabilities, domains, and URL-shaped targets', () => {
  const manifest = JSON.parse(readFileSync(join(example, 'syzygy-plugin.json'), 'utf8'))
  assert.equal(evaluateAuthority(manifest, { capability: 'network.fetch', target: 'api.crossref.org' }), 'allow')
  assert.equal(evaluateAuthority(manifest, { capability: 'network.fetch', target: 'crossref.org' }), 'deny')
  assert.equal(evaluateAuthority(manifest, { capability: 'network.fetch', target: 'https://doi.org' }), 'deny')
  assert.equal(evaluateAuthority(manifest, { capability: 'drive.read' }), 'deny')
})

test('package path containment rejects traversal and absolute paths', () => {
  assert.equal(safePackagePath(example, '../secret.json'), null)
  assert.equal(safePackagePath(example, resolve(example, 'README.md')), null)
  assert.ok(safePackagePath(example, 'fixtures/valid-proposal.json'))
})

test('unknown manifest fields and escaping fixtures fail closed', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'syzygy-plugin-certifier-'))
  try {
    cpSync(example, temporary, { recursive: true })
    const manifestPath = join(temporary, 'syzygy-plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, ambientAuthority: true }))
    let report = certifyPluginPackage(temporary)
    assert.equal(report.passed, false)
    assert.match(report.errors.join(' '), /additional properties/)

    writeFileSync(manifestPath, JSON.stringify(manifest))
    const certificationPath = join(temporary, 'syzygy-certification.json')
    const certification = JSON.parse(readFileSync(certificationPath, 'utf8'))
    certification.fixtures[0].proposal = '../outside.json'
    writeFileSync(certificationPath, JSON.stringify(certification))
    report = certifyPluginPackage(temporary)
    assert.equal(report.passed, false)
    assert.match(report.errors.join(' '), /escapes the plugin package/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
