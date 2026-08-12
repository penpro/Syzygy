import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPublisherPrivateKey } from './plugin-signer.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendRequire = createRequire(join(repositoryRoot, 'frontend', 'package.json'))
const Ajv2020Module = frontendRequire('ajv/dist/2020')
const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
const MAX_PRIVATE_KEY_BYTES = 64 * 1024

const schema = JSON.parse(readFileSync(join(
  repositoryRoot,
  'docs',
  'schemas',
  'syzygy-plugin-publisher-key-rotation-v1.schema.json',
), 'utf8'))
const validateRotation = new Ajv2020({ allErrors: true, strict: true }).compile(schema)

const privateKey = (path, label) => {
  const target = resolve(path)
  if (!existsSync(target)) throw new Error(`${label} is missing`)
  const bytes = readFileSync(target)
  if (bytes.length < 1 || bytes.length > MAX_PRIVATE_KEY_BYTES) throw new Error(`${label} has an invalid size`)
  let key
  try { key = createPrivateKey(bytes) } catch { throw new Error(`${label} is invalid`) }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${label} must be Ed25519`)
  return key
}

const publisher = (key, name) => {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    throw new Error('Publisher names must contain 1-200 characters')
  }
  const publicKey = createPublicKey(key)
  const jwk = publicKey.export({ format: 'jwk' })
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' ||
    Buffer.from(jwk.x, 'base64url').length !== 32) {
    throw new Error('Publisher public key could not be exported as Ed25519')
  }
  const bytes = Buffer.from(jwk.x, 'base64url')
  return {
    identity: {
      name: name.trim(),
      keyId: `ed25519-sha256:${createHash('sha256').update(bytes).digest('base64url')}`,
      publicKey: bytes.toString('base64url'),
    },
    publicKey,
  }
}

export function canonicalPublisherKeyRotation(rotation) {
  return Buffer.from([
    'syzygy-plugin-publisher-key-rotation-v1',
    rotation.pluginId,
    String(rotation.sequence),
    rotation.effectiveVersion,
    rotation.fromPublisher.name,
    rotation.fromPublisher.keyId,
    rotation.fromPublisher.publicKey,
    rotation.toPublisher.name,
    rotation.toPublisher.keyId,
    rotation.toPublisher.publicKey,
  ].join('\n'), 'utf8')
}

export function createPluginPublisherKeyRotation(options) {
  if (!options || typeof options.pluginId !== 'string' ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(options.pluginId) ||
    !Number.isSafeInteger(options.sequence) || options.sequence < 1 || options.sequence > 32 ||
    typeof options.effectiveVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.effectiveVersion) ||
    typeof options.fromPrivateKeyPath !== 'string' || !options.fromPrivateKeyPath ||
    typeof options.toPrivateKeyPath !== 'string' || !options.toPrivateKeyPath ||
    typeof options.outputPath !== 'string' || !options.outputPath) {
    throw new Error('Plugin ID, rotation sequence 1-32, effective semantic version, key paths, and output path are required')
  }
  const fromPrivateKey = privateKey(options.fromPrivateKeyPath, 'Current publisher private key')
  const toPrivateKey = privateKey(options.toPrivateKeyPath, 'New publisher private key')
  const from = publisher(fromPrivateKey, options.fromPublisherName)
  const to = publisher(toPrivateKey, options.toPublisherName)
  if (from.identity.keyId === to.identity.keyId) throw new Error('Publisher rotation requires a different new key')
  const rotation = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    pluginId: options.pluginId,
    sequence: options.sequence,
    effectiveVersion: options.effectiveVersion,
    fromPublisher: from.identity,
    toPublisher: to.identity,
    signatures: { from: '', to: '' },
  }
  const claim = canonicalPublisherKeyRotation(rotation)
  rotation.signatures.from = sign(null, claim, fromPrivateKey).toString('base64url')
  rotation.signatures.to = sign(null, claim, toPrivateKey).toString('base64url')
  if (!validateRotation(rotation) ||
    !verify(null, claim, from.publicKey, Buffer.from(rotation.signatures.from, 'base64url')) ||
    !verify(null, claim, to.publicKey, Buffer.from(rotation.signatures.to, 'base64url'))) {
    throw new Error('Generated publisher rotation failed self-verification')
  }
  const outputPath = resolve(options.outputPath)
  if (existsSync(outputPath)) throw new Error('Publisher rotation output already exists')
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(rotation, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return {
    passed: true,
    status: 'publisher-key-rotation-created',
    pluginId: rotation.pluginId,
    sequence: rotation.sequence,
    effectiveVersion: rotation.effectiveVersion,
    fromKeyId: rotation.fromPublisher.keyId,
    toKeyId: rotation.toPublisher.keyId,
    outputPath,
  }
}

const option = (args, name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function runCli() {
  const args = process.argv.slice(2)
  const fromPrivateKeyPath = option(args, '--from-private-key')
  const toPrivateKeyPath = option(args, '--to-private-key')
  const createToPrivateKeyPath = option(args, '--create-to-private-key')
  const sequence = Number(option(args, '--sequence'))
  const common = {
    pluginId: option(args, '--plugin-id'),
    sequence,
    effectiveVersion: option(args, '--effective-version'),
    fromPrivateKeyPath,
    fromPublisherName: option(args, '--from-publisher-name'),
    toPublisherName: option(args, '--to-publisher-name'),
    outputPath: option(args, '--output'),
  }
  if (!fromPrivateKeyPath || Boolean(toPrivateKeyPath) === Boolean(createToPrivateKeyPath) ||
    !common.pluginId || !common.effectiveVersion || !common.fromPublisherName ||
    !common.toPublisherName || !common.outputPath) {
    console.error('Usage: node scripts/plugin-key-rotation.mjs --plugin-id <id> --sequence <1-32> --effective-version <version> --from-private-key <old.pem> (--to-private-key <new.pem> | --create-to-private-key <new.pem>) --from-publisher-name <name> --to-publisher-name <name> --output <rotation.json>')
    process.exit(2)
  }
  try {
    const selectedToPrivateKeyPath = createToPrivateKeyPath
      ? createPublisherPrivateKey(resolve(createToPrivateKeyPath)) : toPrivateKeyPath
    console.log(JSON.stringify(createPluginPublisherKeyRotation({
      ...common,
      toPrivateKeyPath: selectedToPrivateKeyPath,
    }), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Publisher key rotation failed')
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli()
