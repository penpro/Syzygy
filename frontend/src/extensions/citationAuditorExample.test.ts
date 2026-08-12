import 'fake-indexeddb/auto'
// @ts-expect-error -- Vitest runs this fixture in Node; production intentionally omits Node types.
import { readFileSync } from 'node:fs'
// @ts-expect-error -- Vitest runs this fixture in Node; production intentionally omits Node types.
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadZeroAuthorityPluginPackage } from './pluginExecution'
import {
  PluginInstallationStore,
  type PluginPublisherSignature,
} from './pluginInstallationStore'
import {
  validateResearchPluginManifest,
  type ResearchPluginManifest,
} from './pluginManifest'

const packagePath = (name: string) => fileURLToPath(new URL(
  `../../../examples/plugins/citation-auditor/${name}`,
  import.meta.url,
))

const databaseNames: string[] = []

const deleteDatabase = (name: string) => new Promise<void>((resolve) => {
  const request = indexedDB.deleteDatabase(name)
  request.onsuccess = request.onerror = request.onblocked = () => resolve()
})

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map(deleteDatabase))
})

describe('independently packaged citation auditor', () => {
  it('installs and re-verifies the exact signed component in two isolated profiles', async () => {
    const manifestValue: unknown = JSON.parse(readFileSync(packagePath('syzygy-plugin.json'), 'utf8'))
    expect(validateResearchPluginManifest(manifestValue)).toEqual([])
    const manifest = manifestValue as ResearchPluginManifest
    const proof = JSON.parse(readFileSync(
      packagePath('syzygy-plugin-signature.json'),
      'utf8',
    )) as PluginPublisherSignature
    const plugin = await loadZeroAuthorityPluginPackage(manifest, {
      name: manifest.runtime.kind === 'wasi-component' ? manifest.runtime.component : '',
      bytes: new Uint8Array(readFileSync(packagePath('citation-auditor.component'))),
    })

    const profiles = ['alpha', 'beta'].map((profile, index) => {
      const name = `syzygy-citation-auditor-${profile}-${Date.now()}-${Math.random()}`
      databaseNames.push(name)
      return {
        name,
        store: new PluginInstallationStore(name, () => 1_760_000_000_000 + index),
      }
    })
    for (const profile of profiles) {
      await expect(profile.store.installSigned(plugin, proof)).resolves.toMatchObject({
        action: 'installed',
        installed: {
          enabled: true,
          pluginId: 'org.example.citation-auditor',
          componentSha256: proof.package.componentSha256,
        },
      })
      profile.store.close()
    }

    for (const profile of profiles) {
      const reopened = new PluginInstallationStore(profile.name)
      const restored = await reopened.restoreEnabled()
      expect(restored.failures).toEqual([])
      expect(restored.packages).toHaveLength(1)
      expect(restored.packages[0]).toMatchObject({
        packageId: plugin.packageId,
        componentSha256: proof.package.componentSha256,
        componentByteLength: plugin.componentByteLength,
      })
      reopened.close()
    }

    await deleteDatabase(profiles[0].name)
    databaseNames.splice(databaseNames.indexOf(profiles[0].name), 1)
    const unaffected = new PluginInstallationStore(profiles[1].name)
    await expect(unaffected.getVerified(plugin.packageId)).resolves.toMatchObject({
      componentSha256: proof.package.componentSha256,
    })
    unaffected.close()
  })
})
