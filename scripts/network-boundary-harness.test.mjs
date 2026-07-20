import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'
import {
  ROOT,
  MANIFEST_PATH,
  buildProof,
  scanSourceText,
  validateManifest,
} from './network-boundary-harness.mjs'

const manifest = JSON.parse(readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf8'))
const clone = () => structuredClone(manifest)

test('the checked-in manifest is strict and all source, copy, and evidence anchors exist', () => {
  assert.equal(validateManifest(clone(), { root: ROOT }).schemaVersion, 1)
})

test('unknown fields and duplicate feature identities fail closed', () => {
  const unknown = clone()
  unknown.futureAuthority = true
  assert.throws(() => validateManifest(unknown, { checkAnchors: false }), /fields must be exactly/)

  const duplicate = clone()
  duplicate.boundaries.push(structuredClone(duplicate.boundaries[0]))
  assert.throws(() => validateManifest(duplicate, { checkAnchors: false }), /duplicate boundary id/)
})

test('a boundary without matching product copy is rejected', () => {
  const missingCopy = clone()
  missingCopy.boundaries[0].copyAnchors = []
  assert.throws(() => validateManifest(missingCopy, { checkAnchors: false }), /copyAnchors must be non-empty/)
})

test('an unlisted production origin aborts the trace', () => {
  assert.throws(
    () => scanSourceText('frontend/src/future.ts', "const endpoint = 'https://unreviewed.example.test/upload'", manifest),
    /Unclassified production URL origin/,
  )
})

test('sanitized proof observations never retain URL credentials, paths, queries, or fragments', () => {
  const canary = 'TOP_SECRET_CANARY'
  const source = `const endpoint = 'https://public:${canary}@api.openai.com/v1/responses?token=${canary}#${canary}'`
  const observations = scanSourceText('frontend/src/canary.ts', source, manifest)
  const proof = buildProof(manifest, {
    observations,
    sourceFiles: [{ path: 'frontend/src/canary.ts', sha256: '0'.repeat(64) }],
  }, '2026-07-20T00:00:00.000Z')
  const encoded = JSON.stringify(proof)
  assert.equal(observations[0].origin, 'https://api.openai.com')
  assert.equal(encoded.includes(canary), false)
  assert.equal(encoded.includes('/v1/responses'), false)
  assert.equal(encoded.includes('token='), false)
})
