export const RESEARCH_PLUGIN_SCHEMA_VERSION = 1 as const

export type PluginCapability =
  | 'project.read'
  | 'project.propose'
  | 'drive.read'
  | 'drive.propose'
  | 'network.fetch'
  | 'model.invoke'

export type PluginContributionKind = 'tool' | 'evaluator' | 'importer' | 'exporter'

export type PluginRuntime =
  | { kind: 'wasi-component'; component: string; world: string }
  | { kind: 'mcp-stdio'; command: string; args: string[] }

export interface ResearchPluginManifest {
  schemaVersion: typeof RESEARCH_PLUGIN_SCHEMA_VERSION
  id: string
  name: string
  version: string
  description: string
  runtime: PluginRuntime
  permissions: {
    capabilities: PluginCapability[]
    networkDomains: string[]
    modelProviders: string[]
  }
  contributions: Array<{
    kind: PluginContributionKind
    id: string
    title: string
    description: string
  }>
}

export interface PluginChangeProposal {
  proposalVersion: 1
  proposalId: string
  pluginId: string
  projectId: string
  expectedRevision: string
  summary: string
  content: string
  operation: 'append' | 'replace'
}

const capabilities = new Set<PluginCapability>([
  'project.read',
  'project.propose',
  'drive.read',
  'drive.propose',
  'network.fetch',
  'model.invoke',
])
const contributionKinds = new Set<PluginContributionKind>(['tool', 'evaluator', 'importer', 'exporter'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

export function validateResearchPluginManifest(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['manifest must be an object']
  if (value.schemaVersion !== RESEARCH_PLUGIN_SCHEMA_VERSION) errors.push('unsupported schemaVersion')
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.id)) {
    errors.push('id must be a stable dotted lowercase identifier')
  }
  if (typeof value.name !== 'string' || !value.name.trim()) errors.push('name is required')
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    errors.push('version must be semantic version syntax')
  }
  if (typeof value.description !== 'string' || !value.description.trim()) errors.push('description is required')

  if (!isRecord(value.runtime)) {
    errors.push('runtime is required')
  } else if (value.runtime.kind === 'wasi-component') {
    if (typeof value.runtime.component !== 'string' || !value.runtime.component.trim()) errors.push('WASI component is required')
    if (typeof value.runtime.world !== 'string' || !value.runtime.world.trim()) errors.push('WASI world is required')
  } else if (value.runtime.kind === 'mcp-stdio') {
    if (typeof value.runtime.command !== 'string' || !value.runtime.command.trim()) errors.push('MCP command is required')
    if (!strings(value.runtime.args)) errors.push('MCP args must be strings')
  } else {
    errors.push('runtime kind must be wasi-component or mcp-stdio')
  }

  if (!isRecord(value.permissions)) {
    errors.push('permissions are required')
  } else {
    const requested = value.permissions.capabilities
    if (!strings(requested) || requested.some((item) => !capabilities.has(item as PluginCapability))) {
      errors.push('permissions.capabilities contains an unknown capability')
    }
    const domains = value.permissions.networkDomains
    if (!strings(domains) || domains.some((domain) => !/^(?:\*\.)?[a-z0-9.-]+$/i.test(domain))) {
      errors.push('permissions.networkDomains must contain host names only')
    }
    if (!strings(value.permissions.modelProviders)) errors.push('permissions.modelProviders must be strings')
    if (strings(domains) && domains.length > 0 && (!strings(requested) || !requested.includes('network.fetch'))) {
      errors.push('networkDomains require network.fetch')
    }
    if (
      strings(value.permissions.modelProviders) &&
      value.permissions.modelProviders.length > 0 &&
      (!strings(requested) || !requested.includes('model.invoke'))
    ) {
      errors.push('modelProviders require model.invoke')
    }
  }

  if (!Array.isArray(value.contributions) || value.contributions.length === 0) {
    errors.push('at least one contribution is required')
  } else {
    const ids = new Set<string>()
    for (const contribution of value.contributions) {
      if (!isRecord(contribution)) {
        errors.push('contributions must be objects')
        continue
      }
      if (!contributionKinds.has(contribution.kind as PluginContributionKind)) errors.push('unknown contribution kind')
      if (typeof contribution.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(contribution.id)) {
        errors.push('contribution id must be a lowercase stable identifier')
      } else if (ids.has(contribution.id)) {
        errors.push(`duplicate contribution id: ${contribution.id}`)
      } else {
        ids.add(contribution.id)
      }
      if (typeof contribution.title !== 'string' || !contribution.title.trim()) errors.push('contribution title is required')
      if (typeof contribution.description !== 'string' || !contribution.description.trim()) {
        errors.push('contribution description is required')
      }
    }
  }
  return errors
}

export function validatePluginChangeProposal(value: PluginChangeProposal): string[] {
  const errors: string[] = []
  if (value.proposalVersion !== 1) errors.push('unsupported proposalVersion')
  for (const key of ['proposalId', 'pluginId', 'projectId', 'expectedRevision', 'summary', 'content'] as const) {
    if (!value[key].trim()) errors.push(`${key} is required`)
  }
  if (!['append', 'replace'].includes(value.operation)) errors.push('operation must be append or replace')
  if (value.content.length > 200_000) errors.push('content exceeds 200,000 characters')
  return errors
}
