import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendRequire = createRequire(join(repositoryRoot, 'frontend', 'package.json'))
const Ajv2020Module = frontendRequire('ajv/dist/2020')
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
const MAX_JSON_BYTES = 1024 * 1024

const schema = (name) => JSON.parse(readFileSync(join(repositoryRoot, 'docs', 'schemas', name), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateManifest = ajv.compile(schema('syzygy-research-plugin-v1.schema.json'))
const validateProposal = ajv.compile(schema('syzygy-plugin-proposal-v1.schema.json'))
const validateCertification = ajv.compile(schema('syzygy-plugin-certification-v1.schema.json'))

function schemaErrors(label, errors = []) {
  return errors.map((error) => `${label}${error.instancePath || '/'} ${error.message}`)
}

function boundedText(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`)
  const text = readFileSync(path, 'utf8')
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`${label} exceeds one MiB`)
  return text
}

function readJson(path, label) {
  try {
    return JSON.parse(boundedText(path, label))
  } catch (error) {
    throw new Error(`${label} is not valid bounded JSON: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

export function safePackagePath(packageRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate || isAbsolute(candidate) || candidate.includes('\0')) return null
  const root = realpathSync(packageRoot)
  const unresolvedTarget = resolve(root, candidate)
  const target = existsSync(unresolvedTarget) ? realpathSync(unresolvedTarget) : unresolvedTarget
  const pathFromRoot = relative(root, target)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return null
  return target
}

function domainMatches(pattern, target) {
  const normalizedPattern = pattern.toLowerCase()
  const normalizedTarget = target.toLowerCase()
  if (!normalizedPattern.startsWith('*.')) return normalizedTarget === normalizedPattern
  const suffix = normalizedPattern.slice(1)
  return normalizedTarget.endsWith(suffix) && normalizedTarget.length > suffix.length
}

export function evaluateAuthority(manifest, probe) {
  const { capabilities, networkDomains, modelProviders } = manifest.permissions
  if (!capabilities.includes(probe.capability)) return 'deny'
  if (probe.capability === 'network.fetch') {
    if (typeof probe.target !== 'string' || !/^[a-z0-9.-]+$/i.test(probe.target)) return 'deny'
    return networkDomains.some((domain) => domainMatches(domain, probe.target)) ? 'allow' : 'deny'
  }
  if (probe.capability === 'model.invoke') {
    return typeof probe.target === 'string' && modelProviders.includes(probe.target) ? 'allow' : 'deny'
  }
  return probe.target === undefined ? 'allow' : 'deny'
}

export function certifyPluginPackage(packagePath) {
  const packageRoot = resolve(packagePath)
  const errors = []
  const warnings = []
  let manifest
  let certification
  try {
    manifest = readJson(join(packageRoot, 'syzygy-plugin.json'), 'syzygy-plugin.json')
    certification = readJson(join(packageRoot, 'syzygy-certification.json'), 'syzygy-certification.json')
  } catch (error) {
    return { passed: false, status: 'contract-rejected', errors: [error.message], warnings }
  }

  if (!validateManifest(manifest)) errors.push(...schemaErrors('manifest', validateManifest.errors))
  if (!validateCertification(certification)) {
    errors.push(...schemaErrors('certification', validateCertification.errors))
  }
  if (errors.length > 0) return { passed: false, status: 'contract-rejected', errors, warnings }

  const fixtureIds = new Set()
  let validFixtureCount = 0
  let invalidFixtureCount = 0
  for (const fixture of certification.fixtures) {
    if (fixtureIds.has(fixture.id)) errors.push(`duplicate fixture id: ${fixture.id}`)
    fixtureIds.add(fixture.id)
    const proposalPath = safePackagePath(packageRoot, fixture.proposal)
    if (!proposalPath) {
      errors.push(`fixture ${fixture.id} escapes the plugin package`)
      continue
    }
    let proposal
    try {
      proposal = readJson(proposalPath, `fixture ${fixture.id}`)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    const valid = validateProposal(proposal)
    if (valid !== fixture.expectedValid) {
      errors.push(`fixture ${fixture.id} expectedValid=${fixture.expectedValid} but schema result was ${valid}`)
    }
    if (valid && proposal.pluginId !== manifest.id) {
      errors.push(`fixture ${fixture.id} targets plugin ${proposal.pluginId} instead of ${manifest.id}`)
    }
    if (fixture.expectedValid) validFixtureCount += 1
    else invalidFixtureCount += 1
  }
  if (validFixtureCount === 0 || invalidFixtureCount === 0) {
    errors.push('certification requires at least one expected-valid and one expected-invalid proposal fixture')
  }

  const probeIds = new Set()
  let denyProbeCount = 0
  for (const probe of certification.authorityProbes) {
    if (probeIds.has(probe.id)) errors.push(`duplicate authority probe id: ${probe.id}`)
    probeIds.add(probe.id)
    const actual = evaluateAuthority(manifest, probe)
    if (actual !== probe.expected) {
      errors.push(`authority probe ${probe.id} expected ${probe.expected} but resolved ${actual}`)
    }
    if (probe.expected === 'deny') denyProbeCount += 1
  }
  if (denyProbeCount === 0) errors.push('certification requires at least one denied-authority probe')

  for (const [label, candidate] of [
    ['documentation', certification.documentation],
    ['license', certification.license],
  ]) {
    try {
      const path = safePackagePath(packageRoot, candidate)
      if (!path || !existsSync(path) || !boundedText(path, label).trim()) {
        errors.push(`${label} must be a non-empty package file`)
      }
    } catch {
      errors.push(`${label} must be a non-empty package file no larger than one MiB`)
    }
  }

  const runtimeCandidate = manifest.runtime.kind === 'wasi-component' ? manifest.runtime.component : manifest.runtime.command
  const runtimePath = safePackagePath(packageRoot, runtimeCandidate)
  const runtimeArtifactPresent = runtimePath !== null && existsSync(runtimePath)
  if (!runtimeArtifactPresent) errors.push('runtime artifact must be a package-contained file')
  if (manifest.runtime.kind === 'mcp-stdio') {
    warnings.push('mcp-stdio is a native-process trust tier and is not sandbox-certified')
  } else {
    warnings.push('WASI artifact presence is not execution, capability, or binary-format certification')
  }

  return {
    passed: errors.length === 0,
    status: errors.length === 0 ? 'contract-certified' : 'contract-rejected',
    plugin: { id: manifest.id, version: manifest.version, runtime: manifest.runtime.kind },
    determinism: certification.determinism,
    counts: {
      contributions: manifest.contributions.length,
      permissions: manifest.permissions.capabilities.length,
      proposalFixtures: certification.fixtures.length,
      authorityProbes: certification.authorityProbes.length,
    },
    runtimeArtifactPresent,
    errors,
    warnings,
  }
}

function runCli() {
  const packagePath = process.argv[2]
  if (!packagePath) {
    console.error('Usage: node scripts/plugin-certifier.mjs <plugin-package-folder>')
    process.exit(2)
  }
  const report = certifyPluginPackage(packagePath)
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exit(1)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli()
