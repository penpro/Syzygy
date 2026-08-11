import { verifyEd25519DeviceMessage } from '../workspace/deviceIdentity'
import {
  loadZeroAuthorityPluginPackage,
  type LoadedZeroAuthorityPluginPackage,
} from './pluginExecution'
import { validateResearchPluginManifest } from './pluginManifest'

const DATABASE_VERSION = 1
const STORE_NAME = 'packages'
const DEFAULT_DATABASE_NAME = 'syzygy-plugin-installations-v1'
const MAX_INSTALLED_VERSIONS = 32
const MAX_INSTALLED_COMPONENT_BYTES = 128 * 1024 * 1024
const MAX_COMPONENT_BYTES = 8 * 1024 * 1024
const MAX_ENABLED_PACKAGES = 8
const MAX_ENABLED_COMPONENT_BYTES = 32 * 1024 * 1024
const KEY_ID_PATTERN = /^ed25519-sha256:[A-Za-z0-9_-]{43}$/
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_64_PATTERN = /^[A-Za-z0-9_-]{86}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export interface PluginPublisherSignature {
  schemaVersion: 1
  algorithm: 'Ed25519'
  publisher: {
    name: string
    keyId: string
    publicKey: string
  }
  package: {
    pluginId: string
    version: string
    manifestSha256: string
    componentName: string
    componentSha256: string
    world: string
  }
  signature: string
}

interface StoredPluginInstallation {
  recordVersion: 1
  packageId: string
  pluginId: string
  version: string
  installedAt: number
  enabled: boolean
  plugin: LoadedZeroAuthorityPluginPackage
  publisherSignature: PluginPublisherSignature
}

export interface InstalledPluginSummary {
  packageId: string
  pluginId: string
  name: string
  version: string
  description: string
  componentName: string
  componentByteLength: number
  componentSha256: string
  publisherName: string
  publisherKeyId: string
  installedAt: number
  enabled: boolean
  activationAction: 'disable' | 'enable' | 'upgrade' | 'rollback'
}

export interface PluginInstallResult {
  action: 'installed' | 'upgraded' | 'already-installed'
  installed: InstalledPluginSummary
  replacedPackageId: string | null
}

export interface PluginRestoreResult {
  packages: LoadedZeroAuthorityPluginPackage[]
  failures: Array<{ packageId: string; code: PluginInstallationError['code'] }>
}

export class PluginInstallationError extends Error {
  constructor(readonly code:
    | 'database-unavailable'
    | 'store-corrupt'
    | 'store-full'
    | 'active-capacity'
    | 'package-invalid'
    | 'package-missing'
    | 'signature-invalid'
    | 'signature-unavailable'
    | 'publisher-mismatch'
    | 'version-collision'
    | 'rollback-required'
    | 'rollback-denied'
    | 'active-removal-denied') {
    super('Plugin installation request was denied')
    this.name = 'PluginInstallationError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

const asArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

const bytesToHex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')

const base64ToBytes = (value: string): Uint8Array => {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new PluginInstallationError('package-invalid')
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new PluginInstallationError('package-invalid')
}

const sha256Hex = async (value: Uint8Array) => bytesToHex(new Uint8Array(
  await crypto.subtle.digest('SHA-256', asArrayBuffer(value)),
))

export const canonicalPluginManifest = (plugin: LoadedZeroAuthorityPluginPackage): Uint8Array =>
  new TextEncoder().encode(canonicalJson(plugin.manifest))

export function canonicalPluginPublisherClaim(proof: PluginPublisherSignature): Uint8Array {
  return new TextEncoder().encode([
    'syzygy-plugin-publisher-signature-v1',
    proof.publisher.name,
    proof.publisher.keyId,
    proof.package.pluginId,
    proof.package.version,
    proof.package.manifestSha256,
    proof.package.componentName,
    proof.package.componentSha256,
    proof.package.world,
  ].join('\n'))
}

export function parsePluginPublisherSignature(value: unknown): PluginPublisherSignature | null {
  if (!isRecord(value) || !exactKeys(value, [
    'schemaVersion', 'algorithm', 'publisher', 'package', 'signature',
  ]) || value.schemaVersion !== 1 || value.algorithm !== 'Ed25519' ||
    !isRecord(value.publisher) || !exactKeys(value.publisher, ['name', 'keyId', 'publicKey']) ||
    typeof value.publisher.name !== 'string' || !value.publisher.name.trim() || value.publisher.name.length > 200 ||
    typeof value.publisher.keyId !== 'string' || !KEY_ID_PATTERN.test(value.publisher.keyId) ||
    typeof value.publisher.publicKey !== 'string' || !BASE64URL_32_PATTERN.test(value.publisher.publicKey) ||
    !isRecord(value.package) || !exactKeys(value.package, [
      'pluginId', 'version', 'manifestSha256', 'componentName', 'componentSha256', 'world',
    ]) || typeof value.package.pluginId !== 'string' ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.package.pluginId) ||
    typeof value.package.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.package.version) ||
    typeof value.package.manifestSha256 !== 'string' || !SHA256_PATTERN.test(value.package.manifestSha256) ||
    typeof value.package.componentName !== 'string' || !value.package.componentName || value.package.componentName.length > 240 ||
    value.package.componentName.includes('/') || value.package.componentName.includes('\\') ||
    typeof value.package.componentSha256 !== 'string' || !SHA256_PATTERN.test(value.package.componentSha256) ||
    value.package.world !== 'syzygy:research/plugin@1.0.0' ||
    typeof value.signature !== 'string' || !BASE64URL_64_PATTERN.test(value.signature)) return null
  return structuredClone(value) as unknown as PluginPublisherSignature
}

async function verifyPublisherSignature(
  plugin: LoadedZeroAuthorityPluginPackage,
  signatureValue: unknown,
): Promise<PluginPublisherSignature> {
  const proof = parsePluginPublisherSignature(signatureValue)
  if (!proof || validateResearchPluginManifest(plugin.manifest).length > 0 ||
    plugin.manifest.runtime.kind !== 'wasi-component' ||
    proof.package.pluginId !== plugin.manifest.id || proof.package.version !== plugin.manifest.version ||
    proof.package.componentName !== plugin.componentName || proof.package.componentSha256 !== plugin.componentSha256 ||
    proof.package.world !== plugin.manifest.runtime.world ||
    proof.package.manifestSha256 !== await sha256Hex(canonicalPluginManifest(plugin))) {
    throw new PluginInstallationError('signature-invalid')
  }
  const status = await verifyEd25519DeviceMessage(
    proof.publisher.keyId,
    proof.publisher.publicKey,
    proof.signature,
    canonicalPluginPublisherClaim(proof),
  )
  if (status === 'unavailable') throw new PluginInstallationError('signature-unavailable')
  if (status !== 'verified-device') throw new PluginInstallationError('signature-invalid')
  return proof
}

async function verifyLoadedPackage(
  plugin: LoadedZeroAuthorityPluginPackage,
): Promise<LoadedZeroAuthorityPluginPackage> {
  if (!globalThis.crypto?.subtle) throw new PluginInstallationError('signature-unavailable')
  if (validateResearchPluginManifest(plugin.manifest).length > 0 ||
    typeof plugin.componentBase64 !== 'string' || typeof plugin.componentName !== 'string') {
    throw new PluginInstallationError('package-invalid')
  }
  let reloaded: LoadedZeroAuthorityPluginPackage
  try {
    reloaded = await loadZeroAuthorityPluginPackage(plugin.manifest, {
      name: plugin.componentName,
      bytes: base64ToBytes(plugin.componentBase64),
    })
  } catch {
    throw new PluginInstallationError('package-invalid')
  }
  if (reloaded.packageId !== plugin.packageId || reloaded.componentByteLength !== plugin.componentByteLength ||
    reloaded.componentSha256 !== plugin.componentSha256 || reloaded.componentBase64 !== plugin.componentBase64) {
    throw new PluginInstallationError('package-invalid')
  }
  return reloaded
}

const summarize = (record: StoredPluginInstallation): InstalledPluginSummary => ({
  packageId: record.packageId,
  pluginId: record.pluginId,
  name: record.plugin.manifest.name,
  version: record.version,
  description: record.plugin.manifest.description,
  componentName: record.plugin.componentName,
  componentByteLength: record.plugin.componentByteLength,
  componentSha256: record.plugin.componentSha256,
  publisherName: record.publisherSignature.publisher.name,
  publisherKeyId: record.publisherSignature.publisher.keyId,
  installedAt: record.installedAt,
  enabled: record.enabled,
  activationAction: record.enabled ? 'disable' : 'enable',
})

const parseStoredRecord = (value: unknown): StoredPluginInstallation => {
  if (!isRecord(value) || !exactKeys(value, [
    'recordVersion', 'packageId', 'pluginId', 'version', 'installedAt', 'enabled', 'plugin', 'publisherSignature',
  ]) || value.recordVersion !== 1 || typeof value.packageId !== 'string' ||
    typeof value.pluginId !== 'string' || typeof value.version !== 'string' ||
    !Number.isSafeInteger(value.installedAt) || Number(value.installedAt) < 1 ||
    typeof value.enabled !== 'boolean' || !isRecord(value.plugin)) {
    throw new PluginInstallationError('store-corrupt')
  }
  const plugin = value.plugin as unknown as LoadedZeroAuthorityPluginPackage
  const proof = parsePluginPublisherSignature(value.publisherSignature)
  const expectedPackageId = typeof plugin.componentSha256 === 'string' && typeof plugin.manifest === 'object' &&
    plugin.manifest && 'id' in plugin.manifest && 'version' in plugin.manifest
    ? `${String(plugin.manifest.id)}@${String(plugin.manifest.version)}#${plugin.componentSha256.slice(0, 16)}` : ''
  if (!proof || validateResearchPluginManifest(plugin.manifest).length > 0 ||
    typeof plugin.componentBase64 !== 'string' || plugin.componentBase64.length > 12 * 1024 * 1024 ||
    typeof plugin.componentByteLength !== 'number' || !Number.isSafeInteger(plugin.componentByteLength) ||
    plugin.componentByteLength < 1 || plugin.componentByteLength > MAX_COMPONENT_BYTES ||
    plugin.componentBase64.length !== Math.ceil(plugin.componentByteLength / 3) * 4 ||
    typeof plugin.componentSha256 !== 'string' || !SHA256_PATTERN.test(plugin.componentSha256) ||
    plugin.manifest.runtime.kind !== 'wasi-component' ||
    plugin.componentName !== plugin.manifest.runtime.component ||
    plugin.manifest.runtime.world !== 'syzygy:research/plugin@1.0.0' ||
    value.packageId !== plugin.packageId || value.packageId !== expectedPackageId ||
    value.pluginId !== plugin.manifest.id || value.version !== plugin.manifest.version ||
    proof.package.pluginId !== value.pluginId || proof.package.version !== value.version ||
    proof.package.componentSha256 !== plugin.componentSha256 || proof.package.componentName !== plugin.componentName) {
    throw new PluginInstallationError('store-corrupt')
  }
  return structuredClone(value) as unknown as StoredPluginInstallation
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
})

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
})

const semverParts = (value: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) throw new PluginInstallationError('package-invalid')
  return { numbers: match.slice(1, 4).map((part) => BigInt(part)), prerelease: match[4]?.split('.') ?? [] }
}

const compareSemver = (leftValue: string, rightValue: string): number => {
  const left = semverParts(leftValue)
  const right = semverParts(rightValue)
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/.test(leftPart) ? BigInt(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? BigInt(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber < rightNumber ? -1 : 1
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export class PluginInstallationCatalog {
  private summaries: InstalledPluginSummary[] = []
  private readonly listeners = new Set<() => void>()

  replace(summaries: InstalledPluginSummary[]) {
    this.summaries = structuredClone(summaries)
    this.listeners.forEach((listener) => listener())
  }

  list(): InstalledPluginSummary[] { return structuredClone(this.summaries) }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const pluginInstallationCatalog = new PluginInstallationCatalog()

export class PluginInstallationStore {
  private database: Promise<IDBDatabase> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly databaseName = DEFAULT_DATABASE_NAME,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    if (typeof indexedDB === 'undefined') return Promise.reject(new PluginInstallationError('database-unavailable'))
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'packageId' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new PluginInstallationError('database-unavailable'))
      request.onblocked = () => reject(new PluginInstallationError('database-unavailable'))
    })
    return this.database
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async readRecords(): Promise<StoredPluginInstallation[]> {
    try {
      const database = await this.open()
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const done = transactionDone(transaction)
      const values = await requestResult(transaction.objectStore(STORE_NAME)
        .getAll(undefined, MAX_INSTALLED_VERSIONS + 1))
      await done
      const records = values.map(parseStoredRecord)
      if (records.length > MAX_INSTALLED_VERSIONS ||
        records.reduce((total, record) => total + record.plugin.componentByteLength, 0) >
          MAX_INSTALLED_COMPONENT_BYTES) throw new PluginInstallationError('store-corrupt')
      const enabledIds = new Set<string>()
      const publisherKeys = new Map<string, string>()
      const versionPackages = new Map<string, string>()
      const enabledRecords = records.filter((candidate) => candidate.enabled)
      if (enabledRecords.length > MAX_ENABLED_PACKAGES ||
        enabledRecords.reduce((total, record) => total + record.plugin.componentByteLength, 0) >
          MAX_ENABLED_COMPONENT_BYTES) throw new PluginInstallationError('store-corrupt')
      for (const record of records) {
        const publisherKey = publisherKeys.get(record.pluginId)
        const versionKey = `${record.pluginId}\n${record.version}`
        const versionPackage = versionPackages.get(versionKey)
        if ((publisherKey && publisherKey !== record.publisherSignature.publisher.keyId) ||
          (versionPackage && versionPackage !== record.packageId) ||
          (record.enabled && enabledIds.has(record.pluginId))) {
          throw new PluginInstallationError('store-corrupt')
        }
        publisherKeys.set(record.pluginId, record.publisherSignature.publisher.keyId)
        versionPackages.set(versionKey, record.packageId)
        if (record.enabled) enabledIds.add(record.pluginId)
      }
      return records
    } catch (error) {
      if (error instanceof PluginInstallationError) throw error
      throw new PluginInstallationError('database-unavailable')
    }
  }

  private async putRecords(records: StoredPluginInstallation[]): Promise<void> {
    try {
      const database = await this.open()
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const done = transactionDone(transaction)
      const store = transaction.objectStore(STORE_NAME)
      records.forEach((record) => store.put(structuredClone(record)))
      await done
    } catch (error) {
      if (error instanceof PluginInstallationError) throw error
      throw new PluginInstallationError('database-unavailable')
    }
  }

  async list(): Promise<InstalledPluginSummary[]> {
    const records = await this.readRecords()
    for (const record of records) {
      await verifyPublisherSignature(record.plugin, record.publisherSignature)
    }
    const enabledByPlugin = new Map(records.filter((record) => record.enabled)
      .map((record) => [record.pluginId, record]))
    const summaries = records.map((record) => {
      const summary = summarize(record)
      const current = enabledByPlugin.get(record.pluginId)
      if (!record.enabled && current) {
        summary.activationAction = compareSemver(record.version, current.version) > 0 ? 'upgrade' : 'rollback'
      }
      return summary
    }).sort((left, right) =>
      left.name.localeCompare(right.name) || compareSemver(right.version, left.version) ||
      left.packageId.localeCompare(right.packageId))
    return summaries
  }

  async refreshCatalog(): Promise<InstalledPluginSummary[]> {
    const summaries = await this.list()
    pluginInstallationCatalog.replace(summaries)
    return summaries
  }

  async installSigned(
    plugin: LoadedZeroAuthorityPluginPackage,
    signatureValue: unknown,
  ): Promise<PluginInstallResult> {
    const verifiedPlugin = await verifyLoadedPackage(plugin)
    const proof = await verifyPublisherSignature(verifiedPlugin, signatureValue)
    return this.serialized(async () => {
      const records = await this.readRecords()
      const existingExact = records.find((record) => record.packageId === verifiedPlugin.packageId)
      const sameVersion = records.find((record) =>
        record.pluginId === verifiedPlugin.manifest.id && record.version === verifiedPlugin.manifest.version)
      const retainedLineage = records.filter((record) =>
        record.pluginId === verifiedPlugin.manifest.id)
      if (sameVersion && sameVersion.packageId !== verifiedPlugin.packageId) {
        throw new PluginInstallationError('version-collision')
      }
      const enabled = records.find((record) => record.pluginId === verifiedPlugin.manifest.id && record.enabled)
      if ((existingExact && canonicalJson(existingExact.publisherSignature) !== canonicalJson(proof)) ||
        retainedLineage.some((record) =>
          record.publisherSignature.publisher.keyId !== proof.publisher.keyId)) {
        throw new PluginInstallationError('publisher-mismatch')
      }
      if (enabled && enabled.packageId !== verifiedPlugin.packageId &&
        compareSemver(verifiedPlugin.manifest.version, enabled.version) <= 0) {
        throw new PluginInstallationError('rollback-required')
      }
      if (!existingExact && (records.length >= MAX_INSTALLED_VERSIONS ||
        records.reduce((total, record) => total + record.plugin.componentByteLength, 0) +
          verifiedPlugin.componentByteLength > MAX_INSTALLED_COMPONENT_BYTES)) {
        throw new PluginInstallationError('store-full')
      }
      const enabledOthers = records.filter((record) =>
        record.enabled && record.pluginId !== verifiedPlugin.manifest.id)
      if (enabledOthers.length >= MAX_ENABLED_PACKAGES ||
        enabledOthers.reduce((total, record) => total + record.plugin.componentByteLength, 0) +
          verifiedPlugin.componentByteLength > MAX_ENABLED_COMPONENT_BYTES) {
        throw new PluginInstallationError('active-capacity')
      }
      const installedAt = existingExact?.installedAt ?? this.clock()
      if (!Number.isSafeInteger(installedAt) || installedAt < 1) throw new PluginInstallationError('package-invalid')
      const next: StoredPluginInstallation = {
        recordVersion: 1,
        packageId: verifiedPlugin.packageId,
        pluginId: verifiedPlugin.manifest.id,
        version: verifiedPlugin.manifest.version,
        installedAt,
        enabled: true,
        plugin: structuredClone(verifiedPlugin),
        publisherSignature: proof,
      }
      const changed = records.filter((record) =>
        record.pluginId === verifiedPlugin.manifest.id && record.enabled &&
        record.packageId !== verifiedPlugin.packageId)
        .map((record) => ({ ...record, enabled: false }))
      await this.putRecords([...changed, next])
      await this.refreshCatalog()
      return {
        action: existingExact ? 'already-installed' : enabled ? 'upgraded' : 'installed',
        installed: summarize(next),
        replacedPackageId: enabled?.packageId ?? null,
      }
    })
  }

  async getVerified(packageId: string): Promise<LoadedZeroAuthorityPluginPackage> {
    const record = (await this.readRecords()).find((candidate) => candidate.packageId === packageId)
    if (!record) throw new PluginInstallationError('package-missing')
    const reloaded = await verifyLoadedPackage(record.plugin)
    await verifyPublisherSignature(reloaded, record.publisherSignature)
    return reloaded
  }

  async restoreEnabled(): Promise<PluginRestoreResult> {
    const records = (await this.readRecords()).filter((record) => record.enabled)
    const packages: LoadedZeroAuthorityPluginPackage[] = []
    const failures: PluginRestoreResult['failures'] = []
    for (const record of records) {
      try { packages.push(await this.getVerified(record.packageId)) } catch (error) {
        failures.push({
          packageId: record.packageId,
          code: error instanceof PluginInstallationError ? error.code : 'package-invalid',
        })
      }
    }
    return { packages, failures }
  }

  async disable(packageId: string): Promise<InstalledPluginSummary> {
    return this.serialized(async () => {
      const records = await this.readRecords()
      const record = records.find((candidate) => candidate.packageId === packageId)
      if (!record) throw new PluginInstallationError('package-missing')
      const next = { ...record, enabled: false }
      await this.putRecords([next])
      await this.refreshCatalog()
      return summarize(next)
    })
  }

  async enable(packageId: string): Promise<InstalledPluginSummary> {
    await this.getVerified(packageId)
    return this.serialized(async () => {
      const records = await this.readRecords()
      const target = records.find((candidate) => candidate.packageId === packageId)
      if (!target) throw new PluginInstallationError('package-missing')
      const current = records.find((candidate) => candidate.pluginId === target.pluginId && candidate.enabled)
      if (current && current.packageId !== target.packageId) throw new PluginInstallationError('rollback-required')
      const enabledOthers = records.filter((candidate) => candidate.enabled && candidate.pluginId !== target.pluginId)
      if (enabledOthers.length >= MAX_ENABLED_PACKAGES ||
        enabledOthers.reduce((total, record) => total + record.plugin.componentByteLength, 0) +
          target.plugin.componentByteLength > MAX_ENABLED_COMPONENT_BYTES) {
        throw new PluginInstallationError('active-capacity')
      }
      const next = { ...target, enabled: true }
      await this.putRecords([next])
      await this.refreshCatalog()
      return summarize(next)
    })
  }

  async activate(packageId: string): Promise<InstalledPluginSummary> {
    await this.getVerified(packageId)
    return this.serialized(async () => {
      const records = await this.readRecords()
      const target = records.find((candidate) => candidate.packageId === packageId)
      if (!target) throw new PluginInstallationError('package-missing')
      const current = records.find((candidate) => candidate.pluginId === target.pluginId && candidate.enabled)
      if (current?.packageId === target.packageId) return summarize(target)
      if (current && compareSemver(target.version, current.version) <= 0) {
        throw new PluginInstallationError('rollback-required')
      }
      const enabledOthers = records.filter((candidate) => candidate.enabled && candidate.pluginId !== target.pluginId)
      if (enabledOthers.length >= MAX_ENABLED_PACKAGES ||
        enabledOthers.reduce((total, record) => total + record.plugin.componentByteLength, 0) +
          target.plugin.componentByteLength > MAX_ENABLED_COMPONENT_BYTES) {
        throw new PluginInstallationError('active-capacity')
      }
      const enabled = { ...target, enabled: true }
      await this.putRecords([
        ...(current ? [{ ...current, enabled: false }] : []),
        enabled,
      ])
      await this.refreshCatalog()
      return summarize(enabled)
    })
  }

  async rollback(pluginId: string, targetPackageId: string): Promise<InstalledPluginSummary> {
    await this.getVerified(targetPackageId)
    return this.serialized(async () => {
      const records = await this.readRecords()
      const current = records.find((candidate) => candidate.pluginId === pluginId && candidate.enabled)
      const target = records.find((candidate) => candidate.packageId === targetPackageId && candidate.pluginId === pluginId)
      if (!current || !target || target.enabled || compareSemver(target.version, current.version) >= 0) {
        throw new PluginInstallationError('rollback-denied')
      }
      const enabledOthers = records.filter((candidate) => candidate.enabled && candidate.pluginId !== pluginId)
      if (enabledOthers.reduce((total, record) => total + record.plugin.componentByteLength, 0) +
        target.plugin.componentByteLength > MAX_ENABLED_COMPONENT_BYTES) {
        throw new PluginInstallationError('active-capacity')
      }
      const disabled = { ...current, enabled: false }
      const enabled = { ...target, enabled: true }
      await this.putRecords([disabled, enabled])
      await this.refreshCatalog()
      return summarize(enabled)
    })
  }

  async remove(packageId: string): Promise<void> {
    return this.serialized(async () => {
      const records = await this.readRecords()
      const record = records.find((candidate) => candidate.packageId === packageId)
      if (!record) throw new PluginInstallationError('package-missing')
      if (record.enabled) throw new PluginInstallationError('active-removal-denied')
      try {
        const database = await this.open()
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        const done = transactionDone(transaction)
        transaction.objectStore(STORE_NAME).delete(packageId)
        await done
      } catch (error) {
        if (error instanceof PluginInstallationError) throw error
        throw new PluginInstallationError('database-unavailable')
      }
      await this.refreshCatalog()
    })
  }

  close(): void {
    void this.database?.then((database) => database.close())
    this.database = null
  }
}

export const pluginInstallationStore = new PluginInstallationStore()
