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
const uniqueStrings = (value: string[]) => new Set(value).size === value.length
const exactKeys = (value: Record<string, unknown>, allowed: string[], label: string, errors: string[]) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) errors.push(`${label} contains unknown fields: ${unknown.sort().join(', ')}`)
}

export function validateResearchPluginManifest(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['manifest must be an object']
  exactKeys(value, ['schemaVersion', 'id', 'name', 'version', 'description', 'runtime', 'permissions', 'contributions'], 'manifest', errors)
  if (value.schemaVersion !== RESEARCH_PLUGIN_SCHEMA_VERSION) errors.push('unsupported schemaVersion')
  if (typeof value.id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.id)) {
    errors.push('id must be a stable dotted lowercase identifier')
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) errors.push('name is required and must be at most 120 characters')
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    errors.push('version must be semantic version syntax')
  }
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000) {
    errors.push('description is required and must be at most 1,000 characters')
  }

  if (!isRecord(value.runtime)) {
    errors.push('runtime is required')
  } else if (value.runtime.kind === 'wasi-component') {
    exactKeys(value.runtime, ['kind', 'component', 'world'], 'runtime', errors)
    if (typeof value.runtime.component !== 'string' || !value.runtime.component.trim()) errors.push('WASI component is required')
    if (typeof value.runtime.world !== 'string' || !value.runtime.world.trim()) errors.push('WASI world is required')
  } else if (value.runtime.kind === 'mcp-stdio') {
    exactKeys(value.runtime, ['kind', 'command', 'args'], 'runtime', errors)
    if (typeof value.runtime.command !== 'string' || !value.runtime.command.trim()) errors.push('MCP command is required')
    if (!strings(value.runtime.args) || value.runtime.args.length > 64) errors.push('MCP args must contain at most 64 strings')
  } else {
    errors.push('runtime kind must be wasi-component or mcp-stdio')
  }

  if (!isRecord(value.permissions)) {
    errors.push('permissions are required')
  } else {
    exactKeys(value.permissions, ['capabilities', 'networkDomains', 'modelProviders'], 'permissions', errors)
    const requested = value.permissions.capabilities
    if (!strings(requested) || !uniqueStrings(requested) || requested.some((item) => !capabilities.has(item as PluginCapability))) {
      errors.push('permissions.capabilities contains an unknown capability')
    }
    const domains = value.permissions.networkDomains
    if (!strings(domains) || !uniqueStrings(domains) || domains.some((domain) => !/^(?:\*\.)?[a-z0-9.-]+$/i.test(domain))) {
      errors.push('permissions.networkDomains must contain host names only')
    }
    if (
      !strings(value.permissions.modelProviders) ||
      !uniqueStrings(value.permissions.modelProviders) ||
      value.permissions.modelProviders.some((provider) => !/^[a-z][a-z0-9-]{1,63}$/.test(provider))
    ) {
      errors.push('permissions.modelProviders must contain unique stable provider IDs')
    }
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

  if (!Array.isArray(value.contributions) || value.contributions.length === 0 || value.contributions.length > 128) {
    errors.push('at least one contribution is required')
  } else {
    const ids = new Set<string>()
    for (const contribution of value.contributions) {
      if (!isRecord(contribution)) {
        errors.push('contributions must be objects')
        continue
      }
      exactKeys(contribution, ['kind', 'id', 'title', 'description'], 'contribution', errors)
      if (!contributionKinds.has(contribution.kind as PluginContributionKind)) errors.push('unknown contribution kind')
      if (typeof contribution.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(contribution.id)) {
        errors.push('contribution id must be a lowercase stable identifier')
      } else if (ids.has(contribution.id)) {
        errors.push(`duplicate contribution id: ${contribution.id}`)
      } else {
        ids.add(contribution.id)
      }
      if (typeof contribution.title !== 'string' || !contribution.title.trim() || contribution.title.length > 120) {
        errors.push('contribution title is required and must be at most 120 characters')
      }
      if (typeof contribution.description !== 'string' || !contribution.description.trim() || contribution.description.length > 1000) {
        errors.push('contribution description is required and must be at most 1,000 characters')
      }
    }
  }
  return errors
}

export function validatePluginChangeProposal(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['proposal must be an object']
  exactKeys(
    value,
    ['proposalVersion', 'proposalId', 'pluginId', 'projectId', 'expectedRevision', 'summary', 'content', 'operation'],
    'proposal',
    errors,
  )
  if (value.proposalVersion !== 1) errors.push('unsupported proposalVersion')
  for (const key of ['proposalId', 'pluginId', 'projectId', 'expectedRevision', 'summary', 'content'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim()) errors.push(`${key} is required`)
  }
  if (typeof value.operation !== 'string' || !['append', 'replace'].includes(value.operation)) {
    errors.push('operation must be append or replace')
  }
  if (typeof value.proposalId === 'string' && value.proposalId.length > 120) errors.push('proposalId exceeds 120 characters')
  if (typeof value.pluginId === 'string' && !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.pluginId)) errors.push('pluginId is invalid')
  if (typeof value.projectId === 'string' && value.projectId.length > 200) errors.push('projectId exceeds 200 characters')
  if (typeof value.expectedRevision === 'string' && value.expectedRevision.length > 500) {
    errors.push('expectedRevision exceeds 500 characters')
  }
  if (typeof value.summary === 'string' && value.summary.length > 1000) errors.push('summary exceeds 1,000 characters')
  if (typeof value.content === 'string' && value.content.length > 200_000) errors.push('content exceeds 200,000 characters')
  return errors
}
