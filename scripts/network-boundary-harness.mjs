import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_PATH = 'docs/audits/NETWORK-BOUNDARIES.json'
export const PROOF_PATH = 'docs/audits/runs/NETWORK-BOUNDARIES-2026-07-20.json'

const ROOT_KEYS = ['format', 'schemaVersion', 'status', 'boundaries', 'literalOrigins', 'limitations']
const BOUNDARY_KEYS = ['id', 'label', 'defaultState', 'activation', 'destinations', 'payloads', 'credentials', 'sourceAnchors', 'copyAnchors', 'evidence']
const DESTINATION_KEYS = ['kind', 'origin', 'routePrefixes']
const ANCHOR_KEYS = ['path', 'contains']
const LITERAL_KEYS = ['origin', 'boundaryId', 'classification', 'note']
const LITERAL_CLASSIFICATIONS = new Set(['loopback-runtime', 'app-internal', 'identifier-only', 'feature-destination', 'disclosed-policy-link'])
const URL_LITERAL_RE = /https?:\/\/[^\s"'`<>\\)]+/g

function fail(message) {
  throw new Error(`Network boundary manifest: ${message}`)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly ${wanted.join(', ')}; received ${actual.join(', ')}`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !value) fail(`${label} must be a non-empty trimmed string`)
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`)
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`))
}

function resolveSafe(root, path, label) {
  assertString(path, label)
  const absolute = resolve(root, path)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!absolute.startsWith(prefix)) fail(`${label} escapes the repository root`)
  return absolute
}

function validateAnchor(root, anchor, label, checkAnchors) {
  assertExactKeys(anchor, ANCHOR_KEYS, label)
  const absolute = resolveSafe(root, anchor.path, `${label}.path`)
  assertString(anchor.contains, `${label}.contains`)
  if (!checkAnchors) return
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${label}.path does not exist: ${anchor.path}`)
  if (!readFileSync(absolute, 'utf8').includes(anchor.contains)) fail(`${label} text is missing from ${anchor.path}`)
}

export function validateManifest(manifest, { root = ROOT, checkAnchors = true } = {}) {
  assertExactKeys(manifest, ROOT_KEYS, 'root')
  if (manifest.format !== 'syzygy-network-boundaries') fail('format must be syzygy-network-boundaries')
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (manifest.status !== 'implemented-unverified') fail('status must be implemented-unverified')
  if (!Array.isArray(manifest.boundaries) || manifest.boundaries.length < 1 || manifest.boundaries.length > 64) fail('boundaries must contain 1..64 entries')
  if (!Array.isArray(manifest.literalOrigins) || manifest.literalOrigins.length < 1 || manifest.literalOrigins.length > 128) fail('literalOrigins must contain 1..128 entries')
  assertStringArray(manifest.limitations, 'limitations')

  const ids = new Set()
  for (const [index, boundary] of manifest.boundaries.entries()) {
    const label = `boundaries[${index}]`
    assertExactKeys(boundary, BOUNDARY_KEYS, label)
    assertString(boundary.id, `${label}.id`)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(boundary.id)) fail(`${label}.id must be kebab-case`)
    if (ids.has(boundary.id)) fail(`duplicate boundary id ${boundary.id}`)
    ids.add(boundary.id)
    for (const key of ['label', 'defaultState', 'activation', 'credentials']) assertString(boundary[key], `${label}.${key}`)
    assertStringArray(boundary.payloads, `${label}.payloads`)
    assertStringArray(boundary.evidence, `${label}.evidence`)
    if (!Array.isArray(boundary.destinations) || boundary.destinations.length === 0) fail(`${label}.destinations must be non-empty`)
    boundary.destinations.forEach((destination, destinationIndex) => {
      const destinationLabel = `${label}.destinations[${destinationIndex}]`
      assertExactKeys(destination, DESTINATION_KEYS, destinationLabel)
      assertString(destination.kind, `${destinationLabel}.kind`)
      assertString(destination.origin, `${destinationLabel}.origin`)
      assertStringArray(destination.routePrefixes, `${destinationLabel}.routePrefixes`, { allowEmpty: true })
    })
    for (const anchorKind of ['sourceAnchors', 'copyAnchors']) {
      if (!Array.isArray(boundary[anchorKind]) || boundary[anchorKind].length === 0) fail(`${label}.${anchorKind} must be non-empty`)
      boundary[anchorKind].forEach((anchor, anchorIndex) => validateAnchor(root, anchor, `${label}.${anchorKind}[${anchorIndex}]`, checkAnchors))
    }
    if (checkAnchors) {
      boundary.evidence.forEach((path, evidenceIndex) => {
        const absolute = resolveSafe(root, path, `${label}.evidence[${evidenceIndex}]`)
        if (!existsSync(absolute)) fail(`${label}.evidence[${evidenceIndex}] does not exist: ${path}`)
      })
    }
  }

  const origins = new Set()
  for (const [index, literal] of manifest.literalOrigins.entries()) {
    const label = `literalOrigins[${index}]`
    assertExactKeys(literal, LITERAL_KEYS, label)
    assertString(literal.origin, `${label}.origin`)
    assertString(literal.classification, `${label}.classification`)
    assertString(literal.note, `${label}.note`)
    if (!LITERAL_CLASSIFICATIONS.has(literal.classification)) fail(`${label}.classification is unsupported`)
    if (literal.boundaryId !== null && !ids.has(literal.boundaryId)) fail(`${label}.boundaryId does not name a boundary`)
    if (origins.has(literal.origin)) fail(`duplicate literal origin ${literal.origin}`)
    origins.add(literal.origin)
  }
  return manifest
}

export function loadManifest(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, MANIFEST_PATH), 'utf8'))
  return validateManifest(manifest, { root })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function filesBelow(path) {
  const output = []
  for (const name of readdirSync(path)) {
    const absolute = resolve(path, name)
    if (statSync(absolute).isDirectory()) output.push(...filesBelow(absolute))
    else output.push(absolute)
  }
  return output
}

function productionSourcePaths(root) {
  const candidates = [
    ...filesBelow(resolve(root, 'frontend/src')),
    ...filesBelow(resolve(root, 'frontend/src-tauri/src')),
    resolve(root, 'frontend/src-tauri/tauri.conf.json'),
  ]
  return candidates
    .filter((path) => ['.ts', '.tsx', '.rs', '.json'].includes(extname(path)))
    .filter((path) => !/\.test\.[^.]+$/i.test(path))
    .filter((path) => !path.includes(`${sep}bin${sep}`))
    .sort()
}

function productionText(path, source) {
  if (extname(path) !== '.rs') return source
  return source.replace(/\r?\n\s*#\[cfg\(test\)\][\s\S]*$/, '')
}

export function normalizeLiteralOrigin(raw) {
  if (raw.startsWith('http://127.0.0.1')) return 'http://127.0.0.1:*'
  if (raw.startsWith('http://localhost')) return 'http://localhost:*'
  try {
    return new URL(raw).origin
  } catch {
    throw new Error(`Could not normalize URL literal without exposing it in proof output`)
  }
}

export function classifyOrigin(origin, manifest) {
  const rule = manifest.literalOrigins.find((candidate) => candidate.origin === origin)
  if (!rule) throw new Error(`Unclassified production URL origin: ${origin}`)
  return rule
}

export function scanSourceText(path, source, manifest) {
  const observations = []
  const safeSource = productionText(path, source)
  for (const match of safeSource.matchAll(URL_LITERAL_RE)) {
    const raw = match[0].replace(/[\],.;}]+$/g, '')
    const origin = normalizeLiteralOrigin(raw)
    const rule = classifyOrigin(origin, manifest)
    observations.push({
      path: path.replaceAll('\\', '/'),
      line: safeSource.slice(0, match.index).split(/\r?\n/).length,
      origin,
      boundaryId: rule.boundaryId,
      classification: rule.classification,
    })
  }
  return observations
}

export function scanProductionSources(manifest, root = ROOT) {
  const observations = []
  const sourceFiles = []
  for (const absolute of productionSourcePaths(root)) {
    const source = readFileSync(absolute, 'utf8')
    const path = relative(root, absolute).replaceAll('\\', '/')
    sourceFiles.push({ path, sha256: sha256(source) })
    observations.push(...scanSourceText(path, source, manifest))
  }
  return { observations, sourceFiles }
}

export function buildProof(manifest, inventory, generatedAt = new Date().toISOString()) {
  const sourceDigest = sha256(inventory.sourceFiles.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))
  const manifestDigest = sha256(`${JSON.stringify(manifest)}\n`)
  const boundaryCounts = Object.fromEntries(manifest.boundaries.map((boundary) => [boundary.id, inventory.observations.filter((item) => item.boundaryId === boundary.id).length]))
  return {
    format: 'syzygy-network-boundary-proof',
    schemaVersion: 1,
    generatedAt,
    manifestDigest,
    sourceDigest,
    summary: {
      boundaryCount: manifest.boundaries.length,
      productionSourceCount: inventory.sourceFiles.length,
      observedLiteralCount: inventory.observations.length,
      boundaryLiteralCounts: boundaryCounts,
    },
    observations: inventory.observations,
    limitations: [...manifest.limitations],
  }
}

export function runHarness({ root = ROOT, writeProof = false, generatedAt } = {}) {
  const manifest = loadManifest(root)
  const inventory = scanProductionSources(manifest, root)
  const proof = buildProof(manifest, inventory, generatedAt)
  if (writeProof) writeFileSync(resolve(root, PROOF_PATH), `${JSON.stringify(proof, null, 2)}\n`, 'utf8')
  return proof
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isCli) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--write-proof')) throw new Error(`Usage: node scripts/network-boundary-harness.mjs [--write-proof]`)
  const proof = runHarness({ writeProof: args.includes('--write-proof') })
  console.log(JSON.stringify({ ok: true, ...proof.summary, proof: args.includes('--write-proof') ? PROOF_PATH : null }))
}
