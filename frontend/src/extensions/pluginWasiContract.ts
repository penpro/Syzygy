import { validatePluginChangeProposal, type PluginChangeProposal } from './pluginManifest'

export const RESEARCH_PLUGIN_WIT_WORLD = 'syzygy:research/plugin@1.0.0' as const
export const PLUGIN_INVOCATION_VERSION = 1 as const

export interface PluginWasiSourceSnapshot {
  snapshotId: string
  label: string
  content: string
}

export interface PluginWasiProjectSnapshot {
  projectId: string
  revision: string
  documentText: string
  sources: PluginWasiSourceSnapshot[]
}

export interface PluginWasiInvocation {
  invocationVersion: typeof PLUGIN_INVOCATION_VERSION
  pluginId: string
  contributionId: string
  project: PluginWasiProjectSnapshot | null
}

export type PluginWasiOutput =
  | { kind: 'no-change'; reason: string }
  | { kind: 'proposals'; proposals: PluginChangeProposal[] }

const MAX_INVOCATION_BYTES = 1024 * 1024
const MAX_SOURCE_COUNT = 200
const MAX_PROPOSALS = 32
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, allowed: string[], label: string, errors: string[]) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) errors.push(`${label} contains unknown fields: ${unknown.sort().join(', ')}`)
}
const validId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const encodedBytes = (value: unknown) => {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function validatePluginWasiInvocation(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['invocation must be an object']
  exactKeys(value, ['invocationVersion', 'pluginId', 'contributionId', 'project'], 'invocation', errors)
  if (value.invocationVersion !== PLUGIN_INVOCATION_VERSION) errors.push('unsupported invocationVersion')
  if (!validId(value.pluginId, 200) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.pluginId)) errors.push('pluginId is invalid')
  if (!validId(value.contributionId, 120) || !/^[a-z][a-z0-9-]*$/.test(value.contributionId)) errors.push('contributionId is invalid')
  if (value.project !== null) {
    if (!isRecord(value.project)) {
      errors.push('project must be an object or null')
    } else {
      exactKeys(value.project, ['projectId', 'revision', 'documentText', 'sources'], 'project', errors)
      if (!validId(value.project.projectId)) errors.push('project.projectId is invalid')
      if (!validId(value.project.revision, 500)) errors.push('project.revision is invalid')
      if (typeof value.project.documentText !== 'string' || value.project.documentText.length > 500_000) {
        errors.push('project.documentText must be at most 500,000 characters')
      }
      if (!Array.isArray(value.project.sources) || value.project.sources.length > MAX_SOURCE_COUNT) {
        errors.push(`project.sources must contain at most ${MAX_SOURCE_COUNT} snapshots`)
      } else {
        const ids = new Set<string>()
        for (const source of value.project.sources) {
          if (!isRecord(source)) {
            errors.push('project.sources must contain objects')
            continue
          }
          exactKeys(source, ['snapshotId', 'label', 'content'], 'source', errors)
          if (!validId(source.snapshotId)) errors.push('source.snapshotId is invalid')
          else if (ids.has(source.snapshotId)) errors.push(`duplicate source snapshot: ${source.snapshotId}`)
          else ids.add(source.snapshotId)
          if (!validId(source.label, 500)) errors.push('source.label is invalid')
          if (typeof source.content !== 'string' || source.content.length > 200_000) errors.push('source.content must be at most 200,000 characters')
        }
      }
    }
  }
  if (encodedBytes(value) > MAX_INVOCATION_BYTES) errors.push('invocation exceeds one MiB')
  return errors
}

export function validatePluginWasiOutput(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['output must be an object']
  if (value.kind === 'no-change') {
    exactKeys(value, ['kind', 'reason'], 'output', errors)
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) {
      errors.push('no-change reason is required and must be at most 1,000 characters')
    }
    return errors
  }
  if (value.kind !== 'proposals') return ['output kind must be no-change or proposals']
  exactKeys(value, ['kind', 'proposals'], 'output', errors)
  if (!Array.isArray(value.proposals) || value.proposals.length === 0 || value.proposals.length > MAX_PROPOSALS) {
    errors.push(`output proposals must contain between 1 and ${MAX_PROPOSALS} items`)
    return errors
  }
  for (const proposal of value.proposals) errors.push(...validatePluginChangeProposal(proposal).map((error) => `proposal: ${error}`))
  if (encodedBytes(value) > MAX_INVOCATION_BYTES) errors.push('output exceeds one MiB')
  return errors
}
