import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { safePackagePath } from './plugin-certifier.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendRequire = createRequire(join(repositoryRoot, 'frontend', 'package.json'))
const Ajv2020Module = frontendRequire('ajv/dist/2020')
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
const MAX_JSON_BYTES = 1024 * 1024
const schema = (name) => JSON.parse(readFileSync(join(repositoryRoot, 'docs', 'schemas', name), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateProfileSchema = ajv.compile(schema('syzygy-model-adapter-v1.schema.json'))
const validateCertification = ajv.compile(schema('syzygy-model-adapter-certification-v1.schema.json'))

const paths = {
  'openai-responses': '/v1/responses',
  'openai-chat-completions': '/v1/chat/completions',
  'anthropic-messages': '/v1/messages',
}

function boundedText(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`)
  const value = readFileSync(path, 'utf8')
  if (Buffer.byteLength(value) > MAX_JSON_BYTES) throw new Error(`${label} exceeds one MiB`)
  return value
}

function readJson(path, label) {
  try {
    return JSON.parse(boundedText(path, label))
  } catch (error) {
    throw new Error(`${label} is not valid bounded JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

const schemaErrors = (label, errors = []) => errors.map((error) => `${label}${error.instancePath || '/'} ${error.message}`)
const loopback = (hostname) => hostname === '127.0.0.1' || hostname === '[::1]'

export function profileSemanticErrors(profile) {
  const errors = []
  if (['local', 'openai', 'anthropic', 'gemini', 'xai'].includes(profile.id)) errors.push('profile shadows a built-in provider ID')
  if (profile.endpoint.path !== paths[profile.protocol]) errors.push('endpoint path does not match protocol')
  let endpoint
  try {
    endpoint = new URL(profile.endpoint.baseUrl)
  } catch {
    return [...errors, 'baseUrl is not absolute']
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
    errors.push('baseUrl must be a credential-free origin')
  }
  if (profile.endpoint.locality === 'literal-loopback') {
    if (!loopback(endpoint.hostname)) errors.push('local endpoint is not literal loopback')
    if (profile.dataPolicy.storageControl !== 'local-only' || profile.dataPolicy.zeroRetention !== 'not-applicable') {
      errors.push('local data policy is inconsistent')
    }
    if (profile.dataPolicy.policyUrl || profile.dataPolicy.policyCheckedAt) errors.push('local profile fabricates remote policy evidence')
  } else {
    if (endpoint.protocol !== 'https:') errors.push('remote endpoint is not HTTPS')
    if (profile.endpoint.authentication === 'none') errors.push('remote endpoint has no declared authentication')
    if (!profile.dataPolicy.policyUrl || !profile.dataPolicy.policyCheckedAt) errors.push('remote policy evidence is incomplete')
    if (profile.dataPolicy.storageControl === 'local-only') errors.push('remote profile claims local-only storage')
  }
  if (profile.endpoint.authentication === 'x-api-key' && profile.protocol !== 'anthropic-messages') {
    errors.push('x-api-key is incompatible with protocol')
  }
  return errors
}

export function evaluateAdapterEndpoint(profile, candidate) {
  try {
    const base = new URL(profile.endpoint.baseUrl)
    const expected = new URL(profile.endpoint.path, base)
    const target = new URL(candidate)
    if (target.username || target.password || target.search || target.hash) return 'deny'
    return target.origin === expected.origin && target.pathname === expected.pathname ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}

function profileValid(profile) {
  return validateProfileSchema(profile) && profileSemanticErrors(profile).length === 0
}

export function certifyModelAdapterPackage(packagePath) {
  const packageRoot = resolve(packagePath)
  const errors = []
  const warnings = [
    'contract certification does not execute the adapter, contact an endpoint, validate a model, or grant credentials',
  ]
  let profile
  let certification
  try {
    profile = readJson(join(packageRoot, 'syzygy-model-adapter.json'), 'syzygy-model-adapter.json')
    certification = readJson(join(packageRoot, 'syzygy-certification.json'), 'syzygy-certification.json')
  } catch (error) {
    return { passed: false, status: 'contract-rejected', errors: [error.message], warnings }
  }
  if (!validateProfileSchema(profile)) errors.push(...schemaErrors('profile', validateProfileSchema.errors))
  else errors.push(...profileSemanticErrors(profile).map((error) => `profile ${error}`))
  if (!validateCertification(certification)) errors.push(...schemaErrors('certification', validateCertification.errors))
  if (errors.length) return { passed: false, status: 'contract-rejected', errors, warnings }

  const fixtureIds = new Set()
  let validFixtures = 0
  let invalidFixtures = 0
  for (const fixture of certification.profileFixtures) {
    if (fixtureIds.has(fixture.id)) errors.push(`duplicate profile fixture id: ${fixture.id}`)
    fixtureIds.add(fixture.id)
    const fixturePath = safePackagePath(packageRoot, fixture.profile)
    if (!fixturePath) {
      errors.push(`profile fixture ${fixture.id} escapes the adapter package`)
      continue
    }
    try {
      const candidate = readJson(fixturePath, `profile fixture ${fixture.id}`)
      const valid = profileValid(candidate)
      if (valid !== fixture.expectedValid) {
        errors.push(`profile fixture ${fixture.id} expectedValid=${fixture.expectedValid} but result was ${valid}`)
      }
    } catch (error) {
      errors.push(error.message)
    }
    if (fixture.expectedValid) validFixtures += 1
    else invalidFixtures += 1
  }
  if (!validFixtures || !invalidFixtures) errors.push('certification requires expected-valid and expected-invalid profiles')

  const probeIds = new Set()
  let deniedProbes = 0
  for (const probe of certification.endpointProbes) {
    if (probeIds.has(probe.id)) errors.push(`duplicate endpoint probe id: ${probe.id}`)
    probeIds.add(probe.id)
    const actual = evaluateAdapterEndpoint(profile, probe.url)
    if (actual !== probe.expected) errors.push(`endpoint probe ${probe.id} expected ${probe.expected} but resolved ${actual}`)
    if (probe.expected === 'deny') deniedProbes += 1
  }
  if (!deniedProbes) errors.push('certification requires at least one denied endpoint probe')

  for (const [label, candidate] of [['documentation', certification.documentation], ['license', certification.license]]) {
    try {
      const file = safePackagePath(packageRoot, candidate)
      if (!file || !boundedText(file, label).trim()) errors.push(`${label} must be a non-empty package file`)
    } catch {
      errors.push(`${label} must be a non-empty package file no larger than one MiB`)
    }
  }

  return {
    passed: errors.length === 0,
    status: errors.length === 0 ? 'contract-certified' : 'contract-rejected',
    adapter: { id: profile.id, version: profile.version, protocol: profile.protocol, locality: profile.endpoint.locality },
    counts: { profileFixtures: certification.profileFixtures.length, endpointProbes: certification.endpointProbes.length },
    errors,
    warnings,
  }
}

function runCli() {
  const packagePath = process.argv[2]
  if (!packagePath) {
    console.error('Usage: node scripts/model-adapter-certifier.mjs <adapter-package-folder>')
    process.exit(2)
  }
  const report = certifyModelAdapterPackage(packagePath)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exit(1)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli()
