import * as Y from 'yjs'

export const POLICY_VERSION_SCHEMA_VERSION = 1 as const
export const POLICY_SNAPSHOT_FORMAT = 'syzygy-semantic-blocks-v1' as const

export type VersionBlockKind = 'paragraph' | 'heading1' | 'heading2' | 'quote' | 'policy'
export type VersionPolicyStatus = 'draft' | 'review' | 'approved'

export interface VersionPolicyBlock {
  kind: VersionBlockKind
  text: string
  policyId?: string
  status?: VersionPolicyStatus
}

export interface PolicyVersion {
  schemaVersion: typeof POLICY_VERSION_SCHEMA_VERSION
  versionId: string
  projectId: string
  parentVersionId: string | null
  policy: {
    format: typeof POLICY_SNAPSHOT_FORMAT
    blocks: VersionPolicyBlock[]
  }
  scenarioIds: string[]
  author: {
    participantId: string
    displayName: string
  }
  createdAt: number
  note: string | null
}

export interface CreatePolicyVersionInput {
  projectId: string
  parentVersionId?: string | null
  blocks: VersionPolicyBlock[]
  scenarioIds?: string[]
  participantId: string
  displayName: string
  createdAt: number
  note?: string | null
}

export interface CommitPolicyVersionInput extends Omit<CreatePolicyVersionInput, 'parentVersionId'> {
  expectedHeadVersionId: string | null
}

type PolicyVersionPayload = Omit<PolicyVersion, 'versionId'>

const MAX_VERSIONS = 10_000
const MAX_BLOCKS = 10_000
const MAX_POLICY_TEXT = 500_000
const MAX_SCENARIOS = 10_000
const MAX_CANONICAL_BYTES = 1_000_000
const sha256Pattern = /^[a-f0-9]{64}$/
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const blockKinds = new Set<VersionBlockKind>(['paragraph', 'heading1', 'heading2', 'quote', 'policy'])
const policyStatuses = new Set<VersionPolicyStatus>(['draft', 'review', 'approved'])
const encoder = new TextEncoder()

const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const validStableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && stableIdPattern.test(value)
const validDisplayName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const normalizeText = (value: string) => value.replace(/\r\n?/g, '\n')

function canonicalBlock(block: VersionPolicyBlock): VersionPolicyBlock {
  if (!block || typeof block !== 'object' || Array.isArray(block) || !blockKinds.has(block.kind)) {
    throw new Error('Invalid policy version block')
  }
  if (typeof block.text !== 'string' || /[\u0000]/.test(block.text)) throw new Error('Invalid policy version block text')
  if (block.kind === 'policy') {
    if (!exactKeys(block, ['kind', 'text', 'policyId', 'status']) || !validStableId(block.policyId) ||
      typeof block.status !== 'string' || !policyStatuses.has(block.status as VersionPolicyStatus)) {
      throw new Error('Policy version block requires valid identity and status')
    }
    return { kind: block.kind, text: normalizeText(block.text), policyId: block.policyId, status: block.status }
  }
  if (!exactKeys(block, ['kind', 'text'])) throw new Error('Non-policy version block has unsupported fields')
  return { kind: block.kind, text: normalizeText(block.text) }
}

function payloadFromInput(input: CreatePolicyVersionInput): PolicyVersionPayload {
  if (!validStableId(input.projectId)) throw new Error('Invalid policy version project ID')
  const parentVersionId = input.parentVersionId ?? null
  if (parentVersionId !== null && (typeof parentVersionId !== 'string' || !sha256Pattern.test(parentVersionId))) {
    throw new Error('Invalid parent policy version ID')
  }
  if (!Array.isArray(input.blocks) || input.blocks.length === 0 || input.blocks.length > MAX_BLOCKS) {
    throw new Error('Policy version requires a bounded non-empty block list')
  }
  const blocks = input.blocks.map(canonicalBlock)
  const policyIds = blocks.flatMap((block) => block.kind === 'policy' ? [block.policyId!] : [])
  if (new Set(policyIds).size !== policyIds.length) throw new Error('Policy version contains duplicate policy block IDs')
  if (blocks.reduce((total, block) => total + block.text.length, 0) > MAX_POLICY_TEXT) {
    throw new Error('Policy version text exceeds the size limit')
  }
  const scenarioIds = input.scenarioIds ?? []
  if (!Array.isArray(scenarioIds) || scenarioIds.length > MAX_SCENARIOS ||
    !scenarioIds.every((id) => validStableId(id)) || new Set(scenarioIds).size !== scenarioIds.length) {
    throw new Error('Invalid policy version scenario references')
  }
  if (!validStableId(input.participantId)) throw new Error('Invalid policy version participant ID')
  if (!validDisplayName(input.displayName)) throw new Error('Invalid policy version display name')
  if (!validTimestamp(input.createdAt)) throw new Error('Invalid policy version timestamp')
  const note = input.note ?? null
  if (note !== null && (typeof note !== 'string' || note.length > 20_000 || /[\u0000]/.test(note))) {
    throw new Error('Invalid policy version note')
  }
  return {
    schemaVersion: POLICY_VERSION_SCHEMA_VERSION,
    projectId: input.projectId,
    parentVersionId,
    policy: { format: POLICY_SNAPSHOT_FORMAT, blocks },
    scenarioIds: [...scenarioIds].sort(),
    author: { participantId: input.participantId, displayName: input.displayName.trim() },
    createdAt: input.createdAt,
    note: note === null ? null : normalizeText(note),
  }
}

function inputFromPayload(value: unknown): CreatePolicyVersionInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'projectId', 'parentVersionId', 'policy', 'scenarioIds', 'author', 'createdAt', 'note'])) return null
  const payload = value as Partial<PolicyVersionPayload>
  if (payload.schemaVersion !== POLICY_VERSION_SCHEMA_VERSION || !payload.policy || typeof payload.policy !== 'object' ||
    Array.isArray(payload.policy) || !exactKeys(payload.policy, ['format', 'blocks']) || payload.policy.format !== POLICY_SNAPSHOT_FORMAT ||
    !payload.author || typeof payload.author !== 'object' || Array.isArray(payload.author) ||
    !exactKeys(payload.author, ['participantId', 'displayName'])) return null
  return {
    projectId: payload.projectId as string,
    parentVersionId: payload.parentVersionId as string | null,
    blocks: payload.policy.blocks as VersionPolicyBlock[],
    scenarioIds: payload.scenarioIds as string[],
    participantId: payload.author.participantId as string,
    displayName: payload.author.displayName as string,
    createdAt: payload.createdAt as number,
    note: payload.note as string | null,
  }
}

function canonicalPayload(payload: PolicyVersionPayload): string {
  return JSON.stringify(payload)
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function transact(collection: Y.Map<unknown>, operation: () => void): void {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-policy-version')
  else operation()
}

interface PreparedPolicyVersion {
  payload: PolicyVersionPayload
  canonical: string
  versionId: string
  existing: unknown
  parentStored: unknown
}

async function preparePolicyVersion(
  collection: Y.Map<unknown>,
  input: CreatePolicyVersionInput,
): Promise<PreparedPolicyVersion> {
  const payload = payloadFromInput(input)
  let parentStored: unknown
  if (payload.parentVersionId !== null) {
    const lineage = await readPolicyVersionLineage(collection, payload.parentVersionId)
    const parent = lineage?.[0]
    if (!parent) throw new Error('Parent policy version not found or invalid')
    if (parent.projectId !== payload.projectId) throw new Error('Parent policy version belongs to another project')
    parentStored = collection.get(payload.parentVersionId)
  }
  const canonical = canonicalPayload(payload)
  if (encoder.encode(canonical).byteLength > MAX_CANONICAL_BYTES) throw new Error('Policy version exceeds the encoded size limit')
  const versionId = await sha256(canonical)
  const existing = collection.get(versionId)
  if (existing !== undefined && existing !== canonical) throw new Error('Policy version hash collision or corrupt record')
  return { payload, canonical, versionId, existing, parentStored }
}

export async function createPolicyVersion(
  collection: Y.Map<unknown>,
  input: CreatePolicyVersionInput,
): Promise<PolicyVersion> {
  const { canonical, versionId, existing } = await preparePolicyVersion(collection, input)
  if (existing === undefined) {
    if (collection.size >= MAX_VERSIONS) throw new Error('Policy version collection limit reached')
    transact(collection, () => collection.set(versionId, canonical))
  }
  const version = await readPolicyVersion(collection, versionId)
  if (!version) throw new Error('Policy version failed post-write verification')
  return version
}

export const POLICY_VERSION_HEAD_KEY = 'policyHeadVersionId'

export function readPolicyVersionHead(metadata: Y.Map<unknown>): string | null {
  const stored = metadata.get(POLICY_VERSION_HEAD_KEY)
  if (stored === undefined) return null
  if (typeof stored !== 'string' || !sha256Pattern.test(stored)) throw new Error('Policy version head is invalid')
  return stored
}

export async function commitPolicyVersion(
  collection: Y.Map<unknown>,
  metadata: Y.Map<unknown>,
  input: CommitPolicyVersionInput,
): Promise<PolicyVersion> {
  if (collection.doc !== metadata.doc) throw new Error('Policy versions and metadata must share one document')
  if (input.expectedHeadVersionId !== null && !sha256Pattern.test(input.expectedHeadVersionId)) {
    throw new Error('Expected policy version head is invalid')
  }
  if (readPolicyVersionHead(metadata) !== input.expectedHeadVersionId) throw new Error('Policy version head conflict')
  const prepared = await preparePolicyVersion(collection, { ...input, parentVersionId: input.expectedHeadVersionId })
  const operation = () => {
    if (readPolicyVersionHead(metadata) !== input.expectedHeadVersionId) throw new Error('Policy version head conflict')
    if (prepared.payload.parentVersionId !== null && collection.get(prepared.payload.parentVersionId) !== prepared.parentStored) {
      throw new Error('Parent policy version changed during commit')
    }
    const existing = collection.get(prepared.versionId)
    if (existing !== undefined && existing !== prepared.canonical) throw new Error('Policy version hash collision or corrupt record')
    if (existing === undefined && collection.size >= MAX_VERSIONS) throw new Error('Policy version collection limit reached')
    if (existing === undefined) collection.set(prepared.versionId, prepared.canonical)
    metadata.set(POLICY_VERSION_HEAD_KEY, prepared.versionId)
  }
  if (collection.doc) collection.doc.transact(operation, 'syzygy-policy-version-head')
  else operation()
  const committed = await readPolicyVersion(collection, prepared.versionId)
  if (!committed || readPolicyVersionHead(metadata) !== prepared.versionId) throw new Error('Policy version head failed post-write verification')
  return committed
}

export async function readPolicyVersion(collection: Y.Map<unknown>, versionId: string): Promise<PolicyVersion | null> {
  if (!sha256Pattern.test(versionId)) return null
  const stored = collection.get(versionId)
  if (typeof stored !== 'string' || encoder.encode(stored).byteLength > MAX_CANONICAL_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }
  const input = inputFromPayload(parsed)
  if (!input) return null
  let payload: PolicyVersionPayload
  try {
    payload = payloadFromInput(input)
  } catch {
    return null
  }
  const canonical = canonicalPayload(payload)
  if (canonical !== stored || await sha256(canonical) !== versionId) return null
  return { versionId, ...payload, policy: { ...payload.policy, blocks: payload.policy.blocks.map((block) => ({ ...block })) },
    scenarioIds: [...payload.scenarioIds], author: { ...payload.author } }
}

export async function readPolicyVersionLineage(
  collection: Y.Map<unknown>,
  versionId: string,
): Promise<PolicyVersion[] | null> {
  if (!sha256Pattern.test(versionId)) return null
  const lineage: PolicyVersion[] = []
  const seen = new Set<string>()
  let cursor: string | null = versionId
  let projectId: string | null = null
  while (cursor !== null) {
    if (seen.has(cursor) || lineage.length >= MAX_VERSIONS) return null
    seen.add(cursor)
    const version = await readPolicyVersion(collection, cursor)
    if (!version) return null
    projectId ??= version.projectId
    if (version.projectId !== projectId) return null
    lineage.push(version)
    cursor = version.parentVersionId
  }
  return lineage
}

export async function listPolicyVersions(collection: Y.Map<unknown>): Promise<PolicyVersion[]> {
  const ids = Array.from(collection.keys()).sort()
  if (ids.length > MAX_VERSIONS) return []
  const versions = await Promise.all(ids.map((id) => readPolicyVersion(collection, id)))
  return versions.filter((value): value is PolicyVersion => value !== null)
    .sort((left, right) => left.createdAt - right.createdAt || left.versionId.localeCompare(right.versionId))
}
