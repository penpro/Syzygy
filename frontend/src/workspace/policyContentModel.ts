import type { SerializedLexicalNode } from 'lexical'
import * as Y from 'yjs'

export const POLICY_CONTENT_SCHEMA_VERSION = 1 as const
export const POLICY_CONTENT_INDEX_TYPE = 'project:policy-contents:v1' as const
export const POLICY_CONTENT_TYPE_PREFIX = 'project:policy-content:v1:' as const
export const MAX_POLICY_CONTENT_CODE_UNITS = 500_000
export const MAX_POLICY_CONTENT_SEGMENTS = 20_000
export const MAX_POLICY_CONTENT_EMBED_JSON = 100_000

export type PolicyTextMode = 'normal' | 'token' | 'segmented'
export type StablePolicyStatus = 'draft' | 'review' | 'approved'

export interface InitializePolicyContentOptions {
  status?: StablePolicyStatus
  origin?: unknown
}

export interface PolicyTextAttributes {
  format?: number
  style?: string
  detail?: number
  mode?: PolicyTextMode
}

export interface PolicyLexicalEmbed {
  schemaVersion: 1
  kind: 'lexical-node'
  node: SerializedLexicalNode
}

export interface PolicyContentSegment {
  insert: string | PolicyLexicalEmbed
  attributes?: PolicyTextAttributes
}

export type PolicyContentDelta = PolicyContentSegment[]

interface PolicyContentAtom {
  insert: string | PolicyLexicalEmbed
  attributes: PolicyTextAttributes
}

const modes = new Set<PolicyTextMode>(['normal', 'token', 'segmented'])
const statuses = new Set<StablePolicyStatus>(['draft', 'review', 'approved'])
const attributeKeys = ['detail', 'format', 'mode', 'style']
const segmentKeys = ['attributes', 'insert']
const embedKeys = ['kind', 'node', 'schemaVersion']

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).sort().join(',') === allowed.filter((key) => value[key] !== undefined).sort().join(',')
}

export function validPolicyContentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
}

export function policyContentTypeName(policyId: string): string {
  if (!validPolicyContentId(policyId)) throw new Error('Policy content requires a stable policyId')
  return `${POLICY_CONTENT_TYPE_PREFIX}${policyId}`
}

export function getPolicyContentIndex(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(POLICY_CONTENT_INDEX_TYPE)
}

export function getPolicyContentText(doc: Y.Doc, policyId: string): Y.Text {
  return doc.get(policyContentTypeName(policyId), Y.Text) as Y.Text
}

function normalizeAttributes(value: unknown): PolicyTextAttributes {
  if (value === undefined) return {}
  if (!isRecord(value) || !exactKeys(value, attributeKeys)) throw new Error('Policy content attributes are malformed')
  const result: PolicyTextAttributes = {}
  if (value.format !== undefined) {
    if (!Number.isInteger(value.format) || (value.format as number) < 0 || (value.format as number) > 255) {
      throw new Error('Policy content format is invalid')
    }
    if (value.format !== 0) result.format = value.format as number
  }
  if (value.style !== undefined) {
    if (typeof value.style !== 'string' || value.style.length > 10_000) throw new Error('Policy content style is invalid')
    if (value.style) result.style = value.style
  }
  if (value.detail !== undefined) {
    if (!Number.isInteger(value.detail) || (value.detail as number) < 0 || (value.detail as number) > 3) {
      throw new Error('Policy content detail is invalid')
    }
    if (value.detail !== 0) result.detail = value.detail as number
  }
  if (value.mode !== undefined) {
    if (!modes.has(value.mode as PolicyTextMode)) throw new Error('Policy content mode is invalid')
    if (value.mode !== 'normal') result.mode = value.mode as PolicyTextMode
  }
  return result
}

function normalizeSerializedNode(value: unknown): SerializedLexicalNode {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type || value.type.length > 100 ||
    !Number.isInteger(value.version) || (value.version as number) < 0) {
    throw new Error('Policy content embed node is malformed')
  }
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    throw new Error('Policy content embed node is malformed')
  }
  if (json.length > MAX_POLICY_CONTENT_EMBED_JSON) throw new Error('Policy content embed exceeds the size limit')
  return JSON.parse(json) as SerializedLexicalNode
}

function normalizeInsert(value: unknown): string | PolicyLexicalEmbed {
  if (typeof value === 'string') {
    if (!value) throw new Error('Policy content contains an empty text segment')
    return value
  }
  if (!isRecord(value) || !exactKeys(value, embedKeys) || value.schemaVersion !== 1 || value.kind !== 'lexical-node') {
    throw new Error('Policy content embed is malformed')
  }
  return { schemaVersion: 1, kind: 'lexical-node', node: normalizeSerializedNode(value.node) }
}

export function normalizePolicyContentDelta(value: unknown): PolicyContentDelta {
  if (!Array.isArray(value) || value.length > MAX_POLICY_CONTENT_SEGMENTS) {
    throw new Error('Policy content delta is malformed or exceeds the segment limit')
  }
  let length = 0
  const result = value.map((candidate) => {
    if (!isRecord(candidate) || !exactKeys(candidate, segmentKeys) || candidate.insert === undefined) {
      throw new Error('Policy content segment is malformed')
    }
    const insert = normalizeInsert(candidate.insert)
    length += typeof insert === 'string' ? insert.length : 1
    if (length > MAX_POLICY_CONTENT_CODE_UNITS) throw new Error('Policy content exceeds the size limit')
    const attributes = normalizeAttributes(candidate.attributes)
    return Object.keys(attributes).length ? { insert, attributes } : { insert }
  })
  return result
}

function stablePolicyStatus(value: unknown): StablePolicyStatus {
  if (!statuses.has(value as StablePolicyStatus)) throw new Error('Policy content status is invalid')
  return value as StablePolicyStatus
}

function assertPolicyContentAttributes(shared: Y.Text): StablePolicyStatus {
  const attributes = shared.getAttributes() as Record<string, unknown>
  if (!exactKeys(attributes, ['schemaVersion', 'status']) || attributes.schemaVersion !== POLICY_CONTENT_SCHEMA_VERSION) {
    throw new Error('Policy content record attributes are malformed')
  }
  return stablePolicyStatus(attributes.status)
}

export function readPolicyContent(doc: Y.Doc, policyId: string): PolicyContentDelta | null {
  const version = getPolicyContentIndex(doc).get(policyId)
  if (version === undefined) return null
  if (version !== POLICY_CONTENT_SCHEMA_VERSION) throw new Error('Policy content schema version is unsupported')
  const shared = getPolicyContentText(doc, policyId)
  assertPolicyContentAttributes(shared)
  return normalizePolicyContentDelta(shared.toDelta())
}

export function readPolicyContentStatus(doc: Y.Doc, policyId: string): StablePolicyStatus | null {
  if (readPolicyContent(doc, policyId) === null) return null
  return assertPolicyContentAttributes(getPolicyContentText(doc, policyId))
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function atoms(delta: PolicyContentDelta): PolicyContentAtom[] {
  const result: PolicyContentAtom[] = []
  for (const { insert, attributes = {} } of delta) {
    if (typeof insert !== 'string') result.push({ insert, attributes })
    else for (let index = 0; index < insert.length; index += 1) {
      result.push({ insert: insert.slice(index, index + 1), attributes })
    }
  }
  return result
}

function sameInsert(left: PolicyContentAtom, right: PolicyContentAtom): boolean {
  return typeof left.insert === 'string' && typeof right.insert === 'string'
    ? left.insert === right.insert
    : stableJson(left.insert) === stableJson(right.insert)
}

function sameAttributes(left: PolicyTextAttributes, right: PolicyTextAttributes): boolean {
  return stableJson(left) === stableJson(right)
}

function writeAttributes(attributes: PolicyTextAttributes): Record<string, unknown> {
  return {
    detail: attributes.detail ?? null,
    format: attributes.format ?? null,
    mode: attributes.mode ?? null,
    style: attributes.style ?? null,
  }
}

function insertAtoms(shared: Y.Text, index: number, values: PolicyContentAtom[]): void {
  let offset = index
  for (let cursor = 0; cursor < values.length;) {
    const first = values[cursor]
    if (typeof first.insert !== 'string') {
      shared.insertEmbed(offset, first.insert, writeAttributes(first.attributes))
      offset += 1
      cursor += 1
      continue
    }
    let text = first.insert
    let end = cursor + 1
    while (end < values.length && typeof values[end].insert === 'string' &&
      sameAttributes(first.attributes, values[end].attributes)) {
      text += values[end].insert as string
      end += 1
    }
    shared.insert(offset, text, writeAttributes(first.attributes))
    offset += text.length
    cursor = end
  }
}

function applyAttributeChanges(shared: Y.Text, target: PolicyContentAtom[]): void {
  const current = atoms(normalizePolicyContentDelta(shared.toDelta()))
  if (current.length !== target.length || current.some((item, index) => !sameInsert(item, target[index]))) {
    throw new Error('Policy content structure changed during update')
  }
  let start = 0
  while (start < target.length) {
    if (sameAttributes(current[start].attributes, target[start].attributes)) {
      start += 1
      continue
    }
    const attributes = target[start].attributes
    let end = start + 1
    while (end < target.length && !sameAttributes(current[end].attributes, target[end].attributes) &&
      sameAttributes(attributes, target[end].attributes)) end += 1
    shared.format(start, end - start, writeAttributes(attributes))
    start = end
  }
}

export function initializePolicyContent(
  doc: Y.Doc,
  policyId: string,
  value: unknown,
  options: InitializePolicyContentOptions = {},
): PolicyContentDelta {
  const next = normalizePolicyContentDelta(value)
  const status = stablePolicyStatus(options.status ?? 'draft')
  const existing = readPolicyContent(doc, policyId)
  if (existing) {
    if (stableJson(existing) !== stableJson(next) || readPolicyContentStatus(doc, policyId) !== status) {
      throw new Error('Policy content is already initialized differently')
    }
    return existing
  }
  const shared = getPolicyContentText(doc, policyId)
  if (shared.length !== 0 || Object.keys(shared.getAttributes()).length !== 0) throw new Error('Unindexed policy content exists')
  doc.transact(() => {
    shared.setAttribute('schemaVersion', POLICY_CONTENT_SCHEMA_VERSION)
    shared.setAttribute('status', status)
    insertAtoms(shared, 0, atoms(next))
    getPolicyContentIndex(doc).set(policyId, POLICY_CONTENT_SCHEMA_VERSION)
  }, options.origin ?? 'syzygy-policy-content-initialize')
  return next
}

export function updatePolicyContentStatus(
  doc: Y.Doc,
  policyId: string,
  statusValue: unknown,
  origin: unknown = 'syzygy-policy-content-status',
): StablePolicyStatus {
  const status = stablePolicyStatus(statusValue)
  if (readPolicyContent(doc, policyId) === null) throw new Error('Policy content is not initialized')
  doc.transact(() => getPolicyContentText(doc, policyId).setAttribute('status', status), origin)
  return status
}

export function updatePolicyContent(
  doc: Y.Doc,
  policyId: string,
  value: unknown,
  origin: unknown = 'syzygy-policy-content-update',
): PolicyContentDelta {
  const next = normalizePolicyContentDelta(value)
  const current = readPolicyContent(doc, policyId)
  if (!current) throw new Error('Policy content is not initialized')
  const currentAtoms = atoms(current)
  const nextAtoms = atoms(next)
  let prefix = 0
  while (prefix < currentAtoms.length && prefix < nextAtoms.length && sameInsert(currentAtoms[prefix], nextAtoms[prefix])) {
    prefix += 1
  }
  let suffix = 0
  while (suffix < currentAtoms.length - prefix && suffix < nextAtoms.length - prefix &&
    sameInsert(currentAtoms[currentAtoms.length - suffix - 1], nextAtoms[nextAtoms.length - suffix - 1])) {
    suffix += 1
  }
  doc.transact(() => {
    const remove = currentAtoms.length - prefix - suffix
    if (remove) getPolicyContentText(doc, policyId).delete(prefix, remove)
    insertAtoms(getPolicyContentText(doc, policyId), prefix, nextAtoms.slice(prefix, nextAtoms.length - suffix))
    applyAttributeChanges(getPolicyContentText(doc, policyId), nextAtoms)
  }, origin)
  return next
}

export function policyContentFingerprint(value: unknown): string {
  return stableJson(normalizePolicyContentDelta(value))
}
