import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { certifyModelAdapterPackage, evaluateAdapterEndpoint } from './model-adapter-certifier.mjs'

const example = resolve('..', 'examples', 'model-adapters', 'local-vllm')

test('local vLLM example passes non-executing contract certification', () => {
  const report = certifyModelAdapterPackage(example)
  assert.equal(report.passed, true)
  assert.equal(report.status, 'contract-certified')
  assert.equal(report.adapter.id, 'lab-vllm')
  assert.match(report.warnings.join(' '), /does not execute/)
})

test('endpoint evaluation pins exact origin and route', () => {
  const profile = JSON.parse(readFileSync(join(example, 'syzygy-model-adapter.json'), 'utf8'))
  assert.equal(evaluateAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/responses'), 'allow')
  assert.equal(evaluateAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/chat/completions'), 'deny')
  assert.equal(evaluateAdapterEndpoint(profile, 'http://127.0.0.1:8001/v1/responses'), 'deny')
  assert.equal(evaluateAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/responses?next=https://evil.test'), 'deny')
})

test('unknown fields and escaping fixtures fail closed', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'syzygy-model-adapter-'))
  try {
    cpSync(example, temporary, { recursive: true })
    const profilePath = join(temporary, 'syzygy-model-adapter.json')
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    writeFileSync(profilePath, JSON.stringify({ ...profile, rawHeaders: { authorization: 'secret' } }))
    let report = certifyModelAdapterPackage(temporary)
    assert.equal(report.passed, false)
    assert.match(report.errors.join(' '), /additional properties/)

    writeFileSync(profilePath, JSON.stringify(profile))
    const certificationPath = join(temporary, 'syzygy-certification.json')
    const certification = JSON.parse(readFileSync(certificationPath, 'utf8'))
    certification.profileFixtures[0].profile = '../outside.json'
    writeFileSync(certificationPath, JSON.stringify(certification))
    report = certifyModelAdapterPackage(temporary)
    assert.equal(report.passed, false)
    assert.match(report.errors.join(' '), /escapes the adapter package/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
