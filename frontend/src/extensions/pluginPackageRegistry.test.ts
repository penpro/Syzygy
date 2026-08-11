import { describe, expect, it, vi } from 'vitest'
import { loadZeroAuthorityPluginPackage } from './pluginExecution'
import { PluginPackageRegistry } from './pluginPackageRegistry'

const manifest = (id: string, version = '1.0.0') => ({
  schemaVersion: 1 as const,
  id,
  name: id,
  version,
  description: 'Fixture package',
  runtime: { kind: 'wasi-component' as const, component: 'fixture.component', world: 'syzygy:research/plugin@1.0.0' },
  permissions: { capabilities: ['project.read' as const], networkDomains: [], modelProviders: [] },
  contributions: [{ kind: 'evaluator' as const, id: 'review', title: 'Review', description: 'Review' }],
})

const load = (id: string, byte: number) => loadZeroAuthorityPluginPackage(
  manifest(id), { name: 'fixture.component', bytes: new Uint8Array([byte]) },
)

describe('in-memory plugin package registry', () => {
  it('lists content-minimized metadata and never exposes component bytes', async () => {
    const registry = new PluginPackageRegistry()
    const summary = registry.register(await load('org.example.alpha', 1))
    expect(summary).toMatchObject({ pluginId: 'org.example.alpha', componentByteLength: 1 })
    expect(summary).not.toHaveProperty('componentBase64')
    expect(registry.list()[0]).not.toHaveProperty('manifest')
    expect(registry.get(summary.packageId).componentBase64).toBe('AQ==')
  })

  it('notifies on load, removal, and clear while missing packages fail closed', async () => {
    const registry = new PluginPackageRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const first = registry.register(await load('org.example.alpha', 1))
    registry.register(await load('org.example.beta', 2))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(registry.remove(first.packageId)).toBe(true)
    registry.clear()
    expect(listener).toHaveBeenCalledTimes(4)
    expect(() => registry.get('missing')).toThrowError(expect.objectContaining({ code: 'package-missing' }))
    unsubscribe()
  })

  it('caps the registry at eight simultaneously loaded packages', async () => {
    const registry = new PluginPackageRegistry()
    for (let index = 0; index < 8; index += 1) {
      registry.register(await load(`org.example.plugin-${index}`, index))
    }
    expect(registry.list()).toHaveLength(8)
    expect(() => registry.register({ ...registry.get(registry.list()[0].packageId), packageId: 'bad' }))
      .toThrowError(expect.objectContaining({ code: 'package-invalid' }))
    await expect(load('org.example.overflow', 9).then((plugin) => registry.register(plugin)))
      .rejects.toMatchObject({ code: 'registry-full' })
  })
})
