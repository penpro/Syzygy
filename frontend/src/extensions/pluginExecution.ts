import {
  ResearchPluginAuthorityBroker,
  PluginHostError,
  type PluginProposalReceipt,
} from './pluginAuthorityBroker'
import {
  validateResearchPluginManifest,
  type ResearchPluginManifest,
} from './pluginManifest'
import {
  RESEARCH_PLUGIN_WIT_WORLD,
  validatePluginWasiInvocation,
  validatePluginWasiOutput,
  type PluginWasiInvocation,
  type PluginWasiProjectSnapshot,
} from './pluginWasiContract'
import {
  pluginComponentRun,
  type PluginRuntimeInvocation,
  type PluginRuntimeResult,
} from '../tauri'

const MAX_COMPONENT_BYTES = 8 * 1024 * 1024
const MAX_ACTIVE_PROJECT_RUNS = 1

export interface LoadedZeroAuthorityPluginPackage {
  packageId: string
  manifest: ResearchPluginManifest
  componentName: string
  componentBase64: string
  componentByteLength: number
  componentSha256: string
}

export interface PluginPackageComponent {
  name: string
  bytes: Uint8Array
}

export interface ExecutePluginInput {
  plugin: LoadedZeroAuthorityPluginPackage
  contributionId: string
  project: PluginWasiProjectSnapshot
}

export type PluginExecutionOutcome =
  | {
      status: 'no-change'
      packageId: string
      pluginId: string
      pluginVersion: string
      contributionId: string
      componentSha256: string
      reason: string
      runtime: PluginRuntimeResult['limits']
    }
  | {
      status: 'pending-human-review'
      packageId: string
      pluginId: string
      pluginVersion: string
      contributionId: string
      componentSha256: string
      receipts: PluginProposalReceipt[]
      runtime: PluginRuntimeResult['limits']
    }

export type PluginComponentExecutor = (
  componentBase64: string,
  invocation: PluginRuntimeInvocation,
) => Promise<PluginRuntimeResult>

export class PluginExecutionError extends Error {
  constructor(readonly code:
    | 'package-invalid'
    | 'contribution-denied'
    | 'run-in-progress'
    | 'runtime-denied'
    | 'output-denied') {
    super('Plugin execution was denied')
    this.name = 'PluginExecutionError'
  }
}

const componentFileName = (value: string) => {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PluginExecutionError('package-invalid')
  }
  return value
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)))
  }
  return btoa(binary)
}

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const base64ToBytes = (value: string) => {
  let binary: string
  try { binary = atob(value) } catch { throw new PluginExecutionError('package-invalid') }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function verifyLoadedPlugin(plugin: LoadedZeroAuthorityPluginPackage) {
  const expectedPackageId = `${plugin.manifest.id}@${plugin.manifest.version}#${plugin.componentSha256.slice(0, 16)}`
  const component = base64ToBytes(plugin.componentBase64)
  if (plugin.packageId !== expectedPackageId || component.length !== plugin.componentByteLength ||
    component.length < 1 || component.length > MAX_COMPONENT_BYTES) {
    throw new PluginExecutionError('package-invalid')
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', component.buffer))
  if (bytesToHex(digest) !== plugin.componentSha256) throw new PluginExecutionError('package-invalid')
}

export async function loadZeroAuthorityPluginPackage(
  manifestValue: unknown,
  component: PluginPackageComponent,
): Promise<LoadedZeroAuthorityPluginPackage> {
  if (validateResearchPluginManifest(manifestValue).length > 0) {
    throw new PluginExecutionError('package-invalid')
  }
  const manifest = structuredClone(manifestValue) as ResearchPluginManifest
  if (manifest.runtime.kind !== 'wasi-component' || manifest.runtime.world !== RESEARCH_PLUGIN_WIT_WORLD) {
    throw new PluginExecutionError('package-invalid')
  }
  const expectedName = componentFileName(manifest.runtime.component)
  if (componentFileName(component.name) !== expectedName ||
    !(component.bytes instanceof Uint8Array) || component.bytes.length === 0 ||
    component.bytes.length > MAX_COMPONENT_BYTES) {
    throw new PluginExecutionError('package-invalid')
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(component.bytes).buffer))
  const componentSha256 = bytesToHex(digest)
  return {
    packageId: `${manifest.id}@${manifest.version}#${componentSha256.slice(0, 16)}`,
    manifest,
    componentName: expectedName,
    componentBase64: bytesToBase64(component.bytes),
    componentByteLength: component.bytes.length,
    componentSha256,
  }
}

function assertRuntimeResult(result: PluginRuntimeResult, invocation: PluginWasiInvocation) {
  if (!result || result.runtimeVersion !== 1 || result.world !== RESEARCH_PLUGIN_WIT_WORLD ||
    result.limits?.ambientImportsLinked !== false || validatePluginWasiOutput(result.output).length > 0) {
    throw new PluginExecutionError('output-denied')
  }
  if (result.output.kind === 'proposals') {
    for (const proposal of result.output.proposals) {
      if (proposal.pluginId !== invocation.pluginId ||
        proposal.projectId !== invocation.project?.projectId ||
        proposal.expectedRevision !== invocation.project?.revision) {
        throw new PluginExecutionError('output-denied')
      }
    }
  }
}

export class ZeroAuthorityPluginExecutor {
  private readonly activeProjects = new Set<string>()

  constructor(
    private readonly executeComponent: PluginComponentExecutor = pluginComponentRun,
    private readonly brokerFactory: () => ResearchPluginAuthorityBroker = () => new ResearchPluginAuthorityBroker(),
  ) {}

  async execute(input: ExecutePluginInput): Promise<PluginExecutionOutcome> {
    const { plugin, contributionId, project } = input
    if (validateResearchPluginManifest(plugin.manifest).length > 0 ||
      plugin.manifest.runtime.kind !== 'wasi-component' ||
      plugin.manifest.runtime.world !== RESEARCH_PLUGIN_WIT_WORLD ||
      !/^[a-f0-9]{64}$/.test(plugin.componentSha256) ||
      plugin.componentByteLength < 1 || plugin.componentByteLength > MAX_COMPONENT_BYTES) {
      throw new PluginExecutionError('package-invalid')
    }
    await verifyLoadedPlugin(plugin)
    if (!plugin.manifest.contributions.some((contribution) => contribution.id === contributionId)) {
      throw new PluginExecutionError('contribution-denied')
    }
    if (this.activeProjects.size >= MAX_ACTIVE_PROJECT_RUNS || this.activeProjects.has(project.projectId)) {
      throw new PluginExecutionError('run-in-progress')
    }

    const capabilities = plugin.manifest.permissions.capabilities.filter(
      (capability): capability is 'project.read' | 'project.propose' =>
        capability === 'project.read' || capability === 'project.propose',
    )
    const invocation: PluginWasiInvocation = {
      invocationVersion: 1,
      pluginId: plugin.manifest.id,
      contributionId,
      project: capabilities.includes('project.read') ? structuredClone(project) : null,
    }
    if (validatePluginWasiInvocation(invocation).length > 0) {
      throw new PluginExecutionError('package-invalid')
    }

    const broker = this.brokerFactory()
    const session = broker.openSession(plugin.manifest, {
      capabilities,
      networkDomains: [],
      modelProviders: [],
    }, {
      projectId: project.projectId,
      revision: project.revision,
      semanticText: project.documentText,
      sourceSnapshotIds: project.sources.map((source) => source.snapshotId),
    })
    this.activeProjects.add(project.projectId)
    try {
      let result: PluginRuntimeResult
      try {
        result = await this.executeComponent(plugin.componentBase64, invocation)
      } catch {
        throw new PluginExecutionError('runtime-denied')
      }
      assertRuntimeResult(result, invocation)
      if (result.output.kind === 'no-change') {
        return {
          status: 'no-change',
          packageId: plugin.packageId,
          pluginId: plugin.manifest.id,
          pluginVersion: plugin.manifest.version,
          contributionId,
          componentSha256: plugin.componentSha256,
          reason: result.output.reason,
          runtime: structuredClone(result.limits),
        }
      }
      const receipts = result.output.proposals.map((proposal) => {
        try {
          return broker.submitProjectProposal(session.sessionId, proposal)
        } catch (error) {
          if (error instanceof PluginHostError) throw new PluginExecutionError('output-denied')
          throw error
        }
      })
      return {
        status: 'pending-human-review',
        packageId: plugin.packageId,
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        contributionId,
        componentSha256: plugin.componentSha256,
        receipts,
        runtime: structuredClone(result.limits),
      }
    } finally {
      broker.revokeSession(session.sessionId)
      this.activeProjects.delete(project.projectId)
    }
  }
}

export const zeroAuthorityPluginExecutor = new ZeroAuthorityPluginExecutor()
