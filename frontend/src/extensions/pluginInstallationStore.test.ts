import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { loadZeroAuthorityPluginPackage } from './pluginExecution'
import {
  canonicalPluginManifest,
  canonicalPluginPublisherClaim,
  PluginInstallationStore,
  type PluginPublisherSignature,
} from './pluginInstallationStore'

const databases: Array<{ name: string; store: PluginInstallationStore }> = []

const database = () => {
  const name = `syzygy-plugin-install-test-${Date.now()}-${Math.random()}`
  const store = new PluginInstallationStore(name, () => 1_725_000_000_000)
  databases.push({ name, store })
  return { name, store }
}

afterEach(async () => {
  for (const entry of databases.splice(0)) {
    entry.store.close()
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(entry.name)
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    })
  }
})

const manifest = (version: string, id = 'org.example.signed-review') => ({
  schemaVersion: 1 as const,
  id,
  name: 'Signed review',
  version,
  description: 'A signed package fixture.',
  runtime: {
    kind: 'wasi-component' as const,
    component: 'signed-review.component',
    world: 'syzygy:research/plugin@1.0.0',
  },
  permissions: {
    capabilities: ['project.read' as const, 'project.propose' as const],
    networkDomains: [],
    modelProviders: [],
  },
  contributions: [{
    kind: 'evaluator' as const,
    id: 'review',
    title: 'Review',
    description: 'Review the current project.',
  }],
})

const asArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

const base64Url = (value: ArrayBuffer | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')

const createSigner = async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey('raw', keys.publicKey)
  const keyDigest = await crypto.subtle.digest('SHA-256', publicKey)
  return {
    keys,
    publicKey: base64Url(publicKey),
    keyId: `ed25519-sha256:${base64Url(keyDigest)}`,
  }
}

const signedPackage = async (
  version: string,
  byte: number,
  signer?: Awaited<ReturnType<typeof createSigner>>,
  id?: string,
) => {
  const activeSigner = signer ?? await createSigner()
  const plugin = await loadZeroAuthorityPluginPackage(manifest(version, id), {
    name: 'signed-review.component',
    bytes: new Uint8Array([0, 97, 115, 109, byte]),
  })
  const proof: PluginPublisherSignature = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    publisher: { name: 'Fixture publisher', keyId: activeSigner.keyId, publicKey: activeSigner.publicKey },
    package: {
      pluginId: plugin.manifest.id,
      version: plugin.manifest.version,
      manifestSha256: hex(await crypto.subtle.digest('SHA-256', asArrayBuffer(canonicalPluginManifest(plugin)))),
      componentName: plugin.componentName,
      componentSha256: plugin.componentSha256,
      world: 'syzygy:research/plugin@1.0.0',
    },
    signature: 'A'.repeat(86),
  }
  proof.signature = base64Url(await crypto.subtle.sign(
    { name: 'Ed25519' }, activeSigner.keys.privateKey, asArrayBuffer(canonicalPluginPublisherClaim(proof)),
  ))
  return { plugin, proof, signer: activeSigner }
}

describe('persistent signed plugin installation store', () => {
  it('installs, reopens, and re-verifies an enabled signed package without executing it', async () => {
    const { name, store } = database()
    const fixture = await signedPackage('1.0.0', 1)
    const result = await store.installSigned(fixture.plugin, fixture.proof)
    expect(result).toMatchObject({ action: 'installed', replacedPackageId: null, installed: { enabled: true } })
    expect(await store.list()).toEqual([
      expect.objectContaining({
        packageId: fixture.plugin.packageId,
        publisherKeyId: fixture.proof.publisher.keyId,
        enabled: true,
      }),
    ])
    expect(await store.restoreEnabled()).toMatchObject({
      packages: [expect.objectContaining({ packageId: fixture.plugin.packageId })],
      failures: [],
    })

    store.close()
    const reopened = new PluginInstallationStore(name)
    databases.push({ name, store: reopened })
    expect((await reopened.getVerified(fixture.plugin.packageId)).componentSha256)
      .toBe(fixture.plugin.componentSha256)
  })

  it('retains the prior signed version and performs an explicit verified rollback', async () => {
    const { store } = database()
    const signer = await createSigner()
    const first = await signedPackage('1.0.0', 1, signer)
    const second = await signedPackage('2.0.0', 2, signer)
    await store.installSigned(first.plugin, first.proof)
    expect(await store.installSigned(second.plugin, second.proof)).toMatchObject({
      action: 'upgraded',
      replacedPackageId: first.plugin.packageId,
    })
    expect(await store.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageId: first.plugin.packageId, enabled: false }),
      expect.objectContaining({ packageId: second.plugin.packageId, enabled: true }),
    ]))
    expect((await store.restoreEnabled()).packages[0].packageId).toBe(second.plugin.packageId)

    const rolledBack = await store.rollback(first.plugin.manifest.id, first.plugin.packageId)
    expect(rolledBack).toMatchObject({ packageId: first.plugin.packageId, enabled: true })
    await expect(store.remove(first.plugin.packageId)).rejects.toMatchObject({ code: 'active-removal-denied' })
    await store.disable(first.plugin.packageId)
    await store.remove(first.plugin.packageId)
    expect((await store.list()).map((entry) => entry.packageId)).toEqual([second.plugin.packageId])
  })

  it('rejects downgrade activation and same-version component substitution', async () => {
    const { store } = database()
    const signer = await createSigner()
    const current = await signedPackage('2.0.0', 2, signer)
    const older = await signedPackage('1.0.0', 1, signer)
    const substituted = await signedPackage('2.0.0', 3, signer)
    await store.installSigned(current.plugin, current.proof)
    await expect(store.installSigned(older.plugin, older.proof)).rejects.toMatchObject({ code: 'rollback-required' })
    await expect(store.installSigned(substituted.plugin, substituted.proof))
      .rejects.toMatchObject({ code: 'version-collision' })
  })

  it('requires publisher-key continuity across an upgrade', async () => {
    const { store } = database()
    const first = await signedPackage('1.0.0', 1)
    const takeover = await signedPackage('2.0.0', 2)
    await store.installSigned(first.plugin, first.proof)
    await expect(store.installSigned(takeover.plugin, takeover.proof))
      .rejects.toMatchObject({ code: 'publisher-mismatch' })
    await store.disable(first.plugin.packageId)
    await expect(store.installSigned(takeover.plugin, takeover.proof))
      .rejects.toMatchObject({ code: 'publisher-mismatch' })
    expect(await store.list()).toEqual([
      expect.objectContaining({ packageId: first.plugin.packageId, enabled: false }),
    ])
  })

  it('rejects altered publisher claims and persistent component tampering', async () => {
    const { name, store } = database()
    const fixture = await signedPackage('1.0.0', 1)
    await expect(store.installSigned(fixture.plugin, {
      ...fixture.proof,
      publisher: { ...fixture.proof.publisher, name: 'Imposter' },
    })).rejects.toMatchObject({ code: 'signature-invalid' })
    await store.installSigned(fixture.plugin, fixture.proof)

    const open = indexedDB.open(name, 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const transaction = db.transaction('packages', 'readwrite')
    const objectStore = transaction.objectStore('packages')
    const request = objectStore.get(fixture.plugin.packageId)
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as Record<string, unknown>)
      request.onerror = () => reject(request.error)
    })
    const storedPlugin = record.plugin as Record<string, unknown>
    objectStore.put({ ...record, plugin: { ...storedPlugin, componentBase64: 'AAAAAAI=' } })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = transaction.onabort = () => reject(transaction.error)
    })
    db.close()

    await expect(store.getVerified(fixture.plugin.packageId)).rejects.toMatchObject({ code: 'package-invalid' })
    expect(await store.restoreEnabled()).toEqual({
      packages: [],
      failures: [{ packageId: fixture.plugin.packageId, code: 'package-invalid' }],
    })
  })

  it('serializes concurrent upgrades so exactly one highest version remains enabled', async () => {
    const { store } = database()
    const signer = await createSigner()
    const first = await signedPackage('1.0.0', 1, signer)
    const second = await signedPackage('2.0.0', 2, signer)
    const third = await signedPackage('3.0.0', 3, signer)
    await store.installSigned(first.plugin, first.proof)
    await Promise.all([
      store.installSigned(second.plugin, second.proof),
      store.installSigned(third.plugin, third.proof),
    ])
    const installed = await store.list()
    expect(installed.filter((entry) => entry.enabled)).toEqual([
      expect.objectContaining({ packageId: third.plugin.packageId, version: '3.0.0' }),
    ])
  })

  it('keeps durable enabled packages within the eight-package session boundary', async () => {
    const { store } = database()
    const signer = await createSigner()
    for (let index = 0; index < 8; index += 1) {
      const fixture = await signedPackage('1.0.0', index, signer, `org.example.capacity-${index}`)
      await store.installSigned(fixture.plugin, fixture.proof)
    }
    const overflow = await signedPackage('1.0.0', 9, signer, 'org.example.capacity-overflow')
    await expect(store.installSigned(overflow.plugin, overflow.proof))
      .rejects.toMatchObject({ code: 'active-capacity' })
    expect((await store.list()).filter((entry) => entry.enabled)).toHaveLength(8)
  })
})
