import * as Y from 'yjs'
import {
  importScenarioSnapshots,
  type ResearchScenario,
  type ScenarioSnapshotImportResult,
} from './scenarioModel'

export const SCENARIO_PACK_FORMAT = 'syzygy-scenario-pack' as const
export const SCENARIO_PACK_SCHEMA_VERSION = 2 as const
export const LEGACY_SCENARIO_PACK_SCHEMA_VERSION = 1 as const
export const SCENARIO_PACK_EXTENSION = '.syzygy-scenarios.json'
export const SCENARIO_PACK_MAX_FILE_BYTES = 64 * 1024 * 1024
export const SCENARIO_PACK_MAX_SCENARIOS = 10_000

export interface ScenarioPackSource {
  projectId: string
  documentId: string
  projectTitle: string
  exportedBy: string
  exportedByDisplayName: string
  exportedAt: number
}

export interface ScenarioPackChecksum {
  algorithm: 'SHA-256'
  canonicalization: 'syzygy-json-v1'
  value: string
}

export interface ScenarioPack {
  format: typeof SCENARIO_PACK_FORMAT
  schemaVersion: typeof SCENARIO_PACK_SCHEMA_VERSION | typeof LEGACY_SCENARIO_PACK_SCHEMA_VERSION
  packId: string
  title: string
  description: string
  license: string | null
  source: ScenarioPackSource
  scenarios: ResearchScenario[]
  checksum: ScenarioPackChecksum
}

export interface CreateScenarioPackInput {
  packId: string
  title: string
  description?: string
  license?: string | null
  source: ScenarioPackSource
  scenarios: ResearchScenario[]
  selectedScenarioIds?: string[]
}

type UnsignedScenarioPack = Omit<ScenarioPack, 'checksum'>

const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

export function canonicalScenarioPackJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalScenarioPackJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalScenarioPackJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Scenario pack contains a non-JSON value')
  return encoded
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this runtime')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function migrateLegacyScenarios(value: unknown): ResearchScenario[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SCENARIO_PACK_MAX_SCENARIOS ||
    !value.every(isRecord)) throw new Error('Legacy scenario pack scenarios are invalid or exceed the limit')
  const migrated = value.map((scenarioValue) => {
    if (!exactKeys(scenarioValue, [
      'schemaVersion', 'id', 'title', 'background', 'status', 'parentScenarioId',
      'createdBy', 'createdAt', 'turns', 'edits',
    ]) || scenarioValue.schemaVersion !== LEGACY_SCENARIO_PACK_SCHEMA_VERSION ||
      !Array.isArray(scenarioValue.turns) || !Array.isArray(scenarioValue.edits)) {
      throw new Error('Legacy scenario pack contains an invalid scenario record')
    }
    const turns = scenarioValue.turns.map((turnValue) => {
      if (!isRecord(turnValue) || !exactKeys(turnValue, [
        'id', 'createdBy', 'createdAt', 'role', 'content', 'revisions',
      ]) || !Array.isArray(turnValue.revisions) || turnValue.revisions.length === 0 ||
        turnValue.revisions.length > 10_000 || !turnValue.revisions.every(isRecord)) {
        throw new Error('Legacy scenario pack contains an invalid turn record')
      }
      const legacyRevisions = turnValue.revisions as Record<string, unknown>[]
      const revisions = legacyRevisions.map((revisionValue, index) => {
        if (!exactKeys(revisionValue, ['editId', 'role', 'content', 'authorId', 'timestamp'])) {
          throw new Error('Legacy scenario pack contains an invalid turn revision')
        }
        return {
          ...revisionValue,
          parentEditIds: index === 0 ? [] : [legacyRevisions[index - 1].editId],
          source: 'migration-v1',
        }
      })
      const finalLegacy = legacyRevisions[legacyRevisions.length - 1]
      if (turnValue.role !== finalLegacy.role || turnValue.content !== finalLegacy.content) {
        throw new Error('Legacy scenario pack current turn projection is invalid')
      }
      return {
        ...turnValue,
        headEditId: finalLegacy.editId,
        tipEditIds: [finalLegacy.editId],
        revisions,
      }
    })
    return { ...scenarioValue, schemaVersion: 2, turns }
  })
  return normalizedScenarios(migrated)
}

function normalizedScenarios(value: unknown): ResearchScenario[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SCENARIO_PACK_MAX_SCENARIOS ||
    !value.every(isRecord)) throw new Error('Scenario pack scenarios are invalid or exceed the limit')
  const scenarios = value as unknown as ResearchScenario[]
  const sortedIds = scenarios.map((scenario) => scenario.id).sort()
  if (scenarios.some((scenario, index) => scenario.id !== sortedIds[index])) {
    throw new Error('Scenario pack scenarios must be sorted by ID')
  }
  const scratch = new Y.Doc()
  try {
    importScenarioSnapshots(scratch.getMap<unknown>('scenarios'), scenarios)
  } finally {
    scratch.destroy()
  }
  return scenarios.map((scenario) => structuredClone(scenario))
}

function parseSource(value: unknown): ScenarioPackSource {
  if (!isRecord(value) || !exactKeys(value, [
    'projectId', 'documentId', 'projectTitle', 'exportedBy', 'exportedByDisplayName', 'exportedAt',
  ]) || !stableId(value.projectId) || !stableId(value.documentId) ||
    !validText(value.projectTitle, 200) || !stableId(value.exportedBy) ||
    !validText(value.exportedByDisplayName, 200) || !validTimestamp(value.exportedAt)) {
    throw new Error('Scenario pack source metadata is invalid')
  }
  return value as unknown as ScenarioPackSource
}

function parseUnsigned(value: unknown): UnsignedScenarioPack {
  if (!isRecord(value) || !exactKeys(value, [
    'format', 'schemaVersion', 'packId', 'title', 'description', 'license', 'source', 'scenarios',
  ])) throw new Error('Scenario pack envelope has unknown or missing fields')
  if (value.format !== SCENARIO_PACK_FORMAT ||
    (value.schemaVersion !== SCENARIO_PACK_SCHEMA_VERSION &&
      value.schemaVersion !== LEGACY_SCENARIO_PACK_SCHEMA_VERSION)) {
    throw new Error('Unsupported scenario pack format or schema version')
  }
  if (!stableId(value.packId) || !validText(value.title, 200) || !validText(value.description, 20_000, true) ||
    (value.license !== null && !validText(value.license, 200))) {
    throw new Error('Scenario pack metadata is invalid')
  }
  return {
    format: SCENARIO_PACK_FORMAT,
    schemaVersion: value.schemaVersion,
    packId: value.packId,
    title: value.title,
    description: value.description,
    license: value.license as string | null,
    source: parseSource(value.source),
    scenarios: value.schemaVersion === LEGACY_SCENARIO_PACK_SCHEMA_VERSION
      ? migrateLegacyScenarios(value.scenarios)
      : normalizedScenarios(value.scenarios),
  }
}

function parseChecksum(value: unknown): ScenarioPackChecksum {
  if (!isRecord(value) || !exactKeys(value, ['algorithm', 'canonicalization', 'value']) ||
    value.algorithm !== 'SHA-256' || value.canonicalization !== 'syzygy-json-v1' ||
    typeof value.value !== 'string' || !/^[a-f0-9]{64}$/.test(value.value)) {
    throw new Error('Scenario pack checksum declaration is invalid')
  }
  return value as unknown as ScenarioPackChecksum
}

export function selectScenarioClosure(
  scenarios: ResearchScenario[], selectedScenarioIds?: string[],
): ResearchScenario[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  if (byId.size !== scenarios.length) throw new Error('Scenario collection contains duplicate IDs')
  const requested = selectedScenarioIds ?? scenarios.map((scenario) => scenario.id)
  if (!requested.length) throw new Error('Select at least one scenario to export')
  if (new Set(requested).size !== requested.length || requested.some((id) => !stableId(id) || !byId.has(id))) {
    throw new Error('Scenario export selection is invalid')
  }
  const included = new Set<string>()
  for (const requestedId of requested) {
    let currentId: string | null = requestedId
    const path = new Set<string>()
    while (currentId !== null) {
      if (path.has(currentId)) throw new Error(`Scenario ${requestedId} has cyclic ancestry`)
      path.add(currentId)
      const scenario = byId.get(currentId)
      if (!scenario) throw new Error(`Scenario ${requestedId} has missing parent ${currentId}`)
      included.add(currentId)
      currentId = scenario.parentScenarioId
    }
  }
  return scenarios.filter((scenario) => included.has(scenario.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((scenario) => structuredClone(scenario))
}

export async function createScenarioPack(input: CreateScenarioPackInput): Promise<string> {
  const unsigned = parseUnsigned({
    format: SCENARIO_PACK_FORMAT,
    schemaVersion: SCENARIO_PACK_SCHEMA_VERSION,
    packId: input.packId,
    title: input.title,
    description: input.description ?? '',
    license: input.license ?? null,
    source: input.source,
    scenarios: selectScenarioClosure(input.scenarios, input.selectedScenarioIds),
  })
  const checksum: ScenarioPackChecksum = {
    algorithm: 'SHA-256',
    canonicalization: 'syzygy-json-v1',
    value: await sha256(canonicalScenarioPackJson(unsigned)),
  }
  const text = `${JSON.stringify({ ...unsigned, checksum }, null, 2)}\n`
  if (new TextEncoder().encode(text).byteLength > SCENARIO_PACK_MAX_FILE_BYTES) {
    throw new Error('Scenario pack exceeds the file size limit')
  }
  return text
}

export async function decodeScenarioPack(text: string): Promise<ScenarioPack> {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > SCENARIO_PACK_MAX_FILE_BYTES) {
    throw new Error('Scenario pack exceeds the file size limit')
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Scenario pack is not valid JSON') }
  if (!isRecord(parsed) || !exactKeys(parsed, [
    'format', 'schemaVersion', 'packId', 'title', 'description', 'license', 'source', 'scenarios', 'checksum',
  ])) throw new Error('Scenario pack envelope has unknown or missing fields')
  if (parsed.format !== SCENARIO_PACK_FORMAT ||
    (parsed.schemaVersion !== SCENARIO_PACK_SCHEMA_VERSION &&
      parsed.schemaVersion !== LEGACY_SCENARIO_PACK_SCHEMA_VERSION)) {
    throw new Error('Unsupported scenario pack format or schema version')
  }
  const checksum = parseChecksum(parsed.checksum)
  const rawUnsigned = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'checksum'))
  const actual = await sha256(canonicalScenarioPackJson(rawUnsigned))
  if (actual !== checksum.value) throw new Error('Scenario pack checksum does not match its contents')
  const unsigned = parseUnsigned(rawUnsigned)
  return { ...unsigned, checksum }
}

export interface ScenarioPackImportPlan {
  addScenarioIds: string[]
  existingScenarioIds: string[]
  collisionScenarioIds: string[]
}

export function planScenarioPackImport(
  existingScenarios: ResearchScenario[], pack: ScenarioPack,
): ScenarioPackImportPlan {
  const existing = new Map(existingScenarios.map((scenario) => [scenario.id, scenario]))
  if (existing.size !== existingScenarios.length) throw new Error('Existing scenario list contains duplicate IDs')
  const addScenarioIds: string[] = []
  const existingScenarioIds: string[] = []
  const collisionScenarioIds: string[] = []
  for (const scenario of pack.scenarios) {
    const current = existing.get(scenario.id)
    if (!current) addScenarioIds.push(scenario.id)
    else if (canonicalScenarioPackJson(current) === canonicalScenarioPackJson(scenario)) existingScenarioIds.push(scenario.id)
    else collisionScenarioIds.push(scenario.id)
  }
  return { addScenarioIds, existingScenarioIds, collisionScenarioIds }
}

export function importScenarioPack(
  collection: Y.Map<unknown>, pack: ScenarioPack,
): ScenarioSnapshotImportResult {
  return importScenarioSnapshots(collection, pack.scenarios)
}

export function scenarioPackFilename(title: string): string {
  const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '').trim().slice(0, 80)
  return `${safeTitle || 'syzygy-scenarios'}${SCENARIO_PACK_EXTENSION}`
}
