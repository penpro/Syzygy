import type { LoadedZeroAuthorityPluginPackage } from './pluginExecution'

const MAX_LOADED_PACKAGES = 8
const MAX_TOTAL_COMPONENT_BYTES = 32 * 1024 * 1024

export interface LoadedPluginPackageSummary {
  packageId: string
  pluginId: string
  name: string
  version: string
  description: string
  componentName: string
  componentByteLength: number
  componentSha256: string
  requestedCapabilities: string[]
  contributions: LoadedZeroAuthorityPluginPackage['manifest']['contributions']
}

export class PluginPackageRegistryError extends Error {
  constructor(readonly code: 'registry-full' | 'package-missing' | 'package-invalid') {
    super('Plugin package registry request was denied')
    this.name = 'PluginPackageRegistryError'
  }
}

const summarize = (plugin: LoadedZeroAuthorityPluginPackage): LoadedPluginPackageSummary => ({
  packageId: plugin.packageId,
  pluginId: plugin.manifest.id,
  name: plugin.manifest.name,
  version: plugin.manifest.version,
  description: plugin.manifest.description,
  componentName: plugin.componentName,
  componentByteLength: plugin.componentByteLength,
  componentSha256: plugin.componentSha256,
  requestedCapabilities: [...plugin.manifest.permissions.capabilities],
  contributions: structuredClone(plugin.manifest.contributions),
})

export class PluginPackageRegistry {
  private readonly packages = new Map<string, LoadedZeroAuthorityPluginPackage>()
  private readonly listeners = new Set<() => void>()

  register(plugin: LoadedZeroAuthorityPluginPackage): LoadedPluginPackageSummary {
    const expectedPackageId = `${plugin.manifest.id}@${plugin.manifest.version}#${plugin.componentSha256.slice(0, 16)}`
    if (plugin.packageId !== expectedPackageId || !/^[a-f0-9]{64}$/.test(plugin.componentSha256) ||
      plugin.componentByteLength < 1 || plugin.componentByteLength > 8 * 1024 * 1024) {
      throw new PluginPackageRegistryError('package-invalid')
    }
    const previous = this.packages.get(plugin.packageId)
    const totalBytes = Array.from(this.packages.values()).reduce(
      (total, item) => total + item.componentByteLength,
      0,
    ) - (previous?.componentByteLength ?? 0) + plugin.componentByteLength
    if ((!previous && this.packages.size >= MAX_LOADED_PACKAGES) || totalBytes > MAX_TOTAL_COMPONENT_BYTES) {
      throw new PluginPackageRegistryError('registry-full')
    }
    this.packages.set(plugin.packageId, structuredClone(plugin))
    this.notify()
    return summarize(plugin)
  }

  get(packageId: string): LoadedZeroAuthorityPluginPackage {
    const plugin = this.packages.get(packageId)
    if (!plugin) throw new PluginPackageRegistryError('package-missing')
    return structuredClone(plugin)
  }

  list(): LoadedPluginPackageSummary[] {
    return Array.from(this.packages.values()).map(summarize).sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version) ||
      left.packageId.localeCompare(right.packageId))
  }

  remove(packageId: string): boolean {
    const removed = this.packages.delete(packageId)
    if (removed) this.notify()
    return removed
  }

  clear(): void {
    if (this.packages.size === 0) return
    this.packages.clear()
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    this.listeners.forEach((listener) => listener())
  }
}

export const pluginPackageRegistry = new PluginPackageRegistry()
