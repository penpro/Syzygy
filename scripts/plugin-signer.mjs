import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { safePackagePath } from './plugin-certifier.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendRequire = createRequire(join(repositoryRoot, 'frontend', 'package.json'))
const Ajv2020Module = frontendRequire('ajv/dist/2020')
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_COMPONENT_BYTES = 8 * 1024 * 1024
const MAX_PRIVATE_KEY_BYTES = 64 * 1024
const DEFAULT_OUTPUT = 'syzygy-plugin-signature.json'

const schema = (name) => JSON.parse(readFileSync(join(repositoryRoot, 'docs', 'schemas', name), 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateManifest = ajv.compile(schema('syzygy-research-plugin-v1.schema.json'))
const validateSignature = ajv.compile(schema('syzygy-plugin-publisher-signature-v1.schema.json'))

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

export function canonicalPluginJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalPluginJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalPluginJson(value[key])}`).join(',')}}`
  }
  throw new Error('Manifest contains a non-canonical value')
}

export function canonicalPublisherClaim(proof) {
  return Buffer.from([
    'syzygy-plugin-publisher-signature-v1',
    proof.publisher.name,
    proof.publisher.keyId,
    proof.package.pluginId,
    proof.package.version,
    proof.package.manifestSha256,
    proof.package.componentName,
    proof.package.componentSha256,
    proof.package.world,
  ].join('\n'), 'utf8')
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const boundedFile = (path, maximumBytes, label) => {
  if (!existsSync(path)) throw new Error(`${label} is missing`)
  const bytes = readFileSync(path)
  if (bytes.length < 1 || bytes.length > maximumBytes) throw new Error(`${label} has an invalid size`)
  return bytes
}

export function createPublisherPrivateKey(path) {
  const target = resolve(path)
  if (existsSync(target)) throw new Error('Publisher private-key output already exists')
  const keys = generateKeyPairSync('ed25519')
  writeFileSync(target, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  return target
}

export function signPluginPackage(packagePath, options) {
  const packageRoot = resolve(packagePath)
  if (!options || typeof options.publisherName !== 'string' || !options.publisherName.trim() ||
    options.publisherName.length > 200 || typeof options.privateKeyPath !== 'string') {
    throw new Error('Publisher name and Ed25519 private-key path are required')
  }
  const manifestBytes = boundedFile(
    join(packageRoot, 'syzygy-plugin.json'), MAX_MANIFEST_BYTES, 'syzygy-plugin.json',
  )
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { throw new Error('Manifest is not valid JSON') }
  if (!validateManifest(manifest)) throw new Error('Manifest does not satisfy the public plugin schema')
  if (manifest.runtime.kind !== 'wasi-component' ||
    manifest.runtime.world !== 'syzygy:research/plugin@1.0.0') {
    throw new Error('Only the zero-import WASI component world can be signed for local installation')
  }
  const componentPath = safePackagePath(packageRoot, manifest.runtime.component)
  if (!componentPath) throw new Error('Component path escapes the plugin package')
  const componentBytes = boundedFile(componentPath, MAX_COMPONENT_BYTES, 'Plugin component')
  const privateKeyBytes = boundedFile(resolve(options.privateKeyPath), MAX_PRIVATE_KEY_BYTES, 'Publisher private key')
  let privateKey
  try { privateKey = createPrivateKey(privateKeyBytes) } catch { throw new Error('Publisher private key is invalid') }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Publisher private key must be Ed25519')
  const publicKey = createPublicKey(privateKey)
  const jwk = publicKey.export({ format: 'jwk' })
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('Publisher public key could not be exported as Ed25519')
  }
  const publicKeyBytes = Buffer.from(jwk.x, 'base64url')
  if (publicKeyBytes.length !== 32) throw new Error('Publisher public key has an invalid length')
  const proof = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    publisher: {
      name: options.publisherName.trim(),
      keyId: `ed25519-sha256:${createHash('sha256').update(publicKeyBytes).digest('base64url')}`,
      publicKey: publicKeyBytes.toString('base64url'),
    },
    package: {
      pluginId: manifest.id,
      version: manifest.version,
      manifestSha256: sha256(Buffer.from(canonicalPluginJson(manifest), 'utf8')),
      componentName: manifest.runtime.component,
      componentSha256: sha256(componentBytes),
      world: manifest.runtime.world,
    },
    signature: '',
  }
  proof.signature = sign(null, canonicalPublisherClaim(proof), privateKey).toString('base64url')
  if (!validateSignature(proof) ||
    !verify(null, canonicalPublisherClaim(proof), publicKey, Buffer.from(proof.signature, 'base64url'))) {
    throw new Error('Generated publisher signature failed self-verification')
  }
  const outputName = options.outputName ?? DEFAULT_OUTPUT
  if (basename(outputName) !== outputName || outputName === '.' || outputName === '..') {
    throw new Error('Signature output must be a file name inside the plugin package')
  }
  const outputPath = safePackagePath(packageRoot, outputName)
  if (!outputPath) throw new Error('Signature output escapes the plugin package')
  if (existsSync(outputPath)) throw new Error('Signature output already exists; remove it explicitly before replacing it')
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return {
    passed: true,
    status: 'publisher-signed',
    plugin: { id: manifest.id, version: manifest.version },
    component: {
      name: manifest.runtime.component,
      byteLength: componentBytes.length,
      sha256: proof.package.componentSha256,
    },
    publisher: { name: proof.publisher.name, keyId: proof.publisher.keyId },
    outputPath,
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function runCli() {
  const args = process.argv.slice(2)
  const packagePath = args[0]
  const privateKeyPath = option(args, '--private-key')
  const createPrivateKeyPath = option(args, '--create-private-key')
  const publisherName = option(args, '--publisher-name')
  const outputName = option(args, '--output')
  if (!packagePath || Boolean(privateKeyPath) === Boolean(createPrivateKeyPath) || !publisherName) {
    console.error('Usage: node scripts/plugin-signer.mjs <plugin-package-folder> (--private-key <ed25519-pem> | --create-private-key <new-pem>) --publisher-name <name> [--output <file-name>]')
    process.exit(2)
  }
  try {
    const packageRoot = resolve(packagePath)
    let selectedPrivateKeyPath = privateKeyPath
    if (createPrivateKeyPath) {
      const target = resolve(createPrivateKeyPath)
      const fromPackage = relative(packageRoot, target)
      if (!fromPackage || (!fromPackage.startsWith(`..${sep}`) && fromPackage !== '..') || isAbsolute(fromPackage)) {
        throw new Error('Publisher private key must be created outside the plugin package')
      }
      selectedPrivateKeyPath = createPublisherPrivateKey(target)
    }
    console.log(JSON.stringify(signPluginPackage(packagePath, {
      privateKeyPath: selectedPrivateKeyPath,
      publisherName,
      outputName,
    }), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Plugin signing failed')
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli()
