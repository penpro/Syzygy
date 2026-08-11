import * as Y from 'yjs'

export const SCENARIO_SCHEMA_VERSION = 2 as const
export const LEGACY_SCENARIO_SCHEMA_VERSION = 1 as const
export type ScenarioStatus = 'draft' | 'ready' | 'archived'
export type ScenarioTurnRole = 'system' | 'user' | 'assistant'
export type ScenarioTurnRevisionSource = 'create' | 'edit' | 'reconcile' | 'migration-v1'

export interface ScenarioTurnRevision {
  editId: string
  role: ScenarioTurnRole
  content: string
  authorId: string
  timestamp: number
  parentEditIds: string[]
  source: ScenarioTurnRevisionSource
}

export interface ScenarioTurn {
  id: string
  createdBy: string
  createdAt: number
  role: ScenarioTurnRole
  content: string
  headEditId: string
  tipEditIds: string[]
  revisions: ScenarioTurnRevision[]
}

export interface ScenarioEdit {
  editId: string
  authorId: string
  timestamp: number
  fields: Array<'title' | 'background' | 'status'>
  changes: Partial<Pick<ResearchScenario, 'title' | 'background' | 'status'>>
}

export interface ResearchScenario {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION
  id: string
  title: string
  background: string
  status: ScenarioStatus
  parentScenarioId: string | null
  createdBy: string
  createdAt: number
  turns: ScenarioTurn[]
  edits: ScenarioEdit[]
}

export interface CreateScenarioInput {
  id: string
  title: string
  background: string
  status?: ScenarioStatus
  parentScenarioId?: string | null
  authorId: string
  timestamp: number
  editId: string
  turns?: Array<{ id: string; role: ScenarioTurnRole; content: string; editId: string }>
}

export interface UpdateScenarioInput {
  id: string
  authorId: string
  timestamp: number
  editId: string
  changes: Partial<Pick<ResearchScenario, 'title' | 'background' | 'status'>>
}

export interface AddScenarioTurnInput {
  scenarioId: string
  turnId: string
  role: ScenarioTurnRole
  content: string
  authorId: string
  timestamp: number
  editId: string
}

export interface UpdateScenarioTurnInput extends AddScenarioTurnInput {
  expectedCurrentEditId: string
}

export interface ReconcileScenarioTurnInput extends AddScenarioTurnInput {
  expectedCurrentEditId: string
  expectedTipEditIds: string[]
}

const statuses = new Set<ScenarioStatus>(['draft', 'ready', 'archived'])
const roles = new Set<ScenarioTurnRole>(['system', 'user', 'assistant'])
const revisionSources = new Set<ScenarioTurnRevisionSource>(['create', 'edit', 'reconcile', 'migration-v1'])
const MAX_SCENARIOS = 10_000
const MAX_TURNS = 1_000
const MAX_EDITS = 10_000
const MAX_REVISIONS_PER_TURN = 10_000
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000]/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const exactYKeys = (value: Y.Map<unknown>, expected: string[]) =>
  Array.from(value.keys()).sort().join(',') === [...expected].sort().join(',')
const storageKey = (collection: Y.Map<unknown>, publicId: string) => `${collection.doc?.clientID ?? 'detached'}:${publicId}`
const scenarioEntries = (collection: Y.Map<unknown>, id: string) => Array.from(collection.entries())
  .filter(([, value]) => value instanceof Y.Map && value.get('id') === id) as Array<[string, Y.Map<unknown>]>
const scenarioRecord = (collection: Y.Map<unknown>, id: string): Y.Map<unknown> | null => {
  const matches = scenarioEntries(collection, id)
  return matches.length === 1 ? matches[0][1] : null
}
const transact = (collection: Y.Map<unknown>, operation: () => void) => {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenarios')
  else operation()
}

function validateIdentity(id: string, authorId: string, timestamp: number, editId: string): void {
  if (!stableId(id)) throw new Error('Invalid scenario identity')
  if (!stableId(authorId)) throw new Error('Invalid scenario author identity')
  if (!validTimestamp(timestamp)) throw new Error('Invalid scenario timestamp')
  if (!stableId(editId)) throw new Error('Invalid scenario edit identity')
}

function validTurnRevision(value: unknown): value is ScenarioTurnRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['editId', 'role', 'content', 'authorId', 'timestamp', 'parentEditIds', 'source'])) return false
  const revision = value as Partial<ScenarioTurnRevision>
  return stableId(revision.editId) && typeof revision.role === 'string' && roles.has(revision.role as ScenarioTurnRole) &&
    validText(revision.content, 200_000, true) && stableId(revision.authorId) && validTimestamp(revision.timestamp) &&
    Array.isArray(revision.parentEditIds) && revision.parentEditIds.length <= MAX_REVISIONS_PER_TURN &&
    revision.parentEditIds.every((parentId) => stableId(parentId)) &&
    new Set(revision.parentEditIds).size === revision.parentEditIds.length &&
    typeof revision.source === 'string' && revisionSources.has(revision.source as ScenarioTurnRevisionSource)
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function canonicalScenarioTurnRevision(revision: ScenarioTurnRevision): string {
  if (!validTurnRevision(revision)) throw new Error('Scenario turn revision event is invalid')
  return JSON.stringify({
    editId: revision.editId,
    role: revision.role,
    content: revision.content,
    authorId: revision.authorId,
    timestamp: revision.timestamp,
    parentEditIds: [...revision.parentEditIds],
    source: revision.source,
  })
}

export async function scenarioTurnRevisionSha256(revision: ScenarioTurnRevision): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalScenarioTurnRevision(revision)),
  )
  return encodeBase64Url(new Uint8Array(digest))
}

export function canonicalScenarioEdit(edit: ScenarioEdit): string {
  if (!validScenarioEdit(edit)) throw new Error('Scenario edit event is invalid')
  return JSON.stringify({
    editId: edit.editId,
    authorId: edit.authorId,
    timestamp: edit.timestamp,
    fields: [...edit.fields],
    changes: Object.fromEntries(edit.fields.map((field) => [field, edit.changes[field]])),
  })
}

export async function scenarioEditSha256(edit: ScenarioEdit): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalScenarioEdit(edit)),
  )
  return encodeBase64Url(new Uint8Array(digest))
}

const compareRevisions = (left: ScenarioTurnRevision, right: ScenarioTurnRevision) =>
  left.timestamp - right.timestamp || left.editId.localeCompare(right.editId) || left.authorId.localeCompare(right.authorId)

function orderedRevisionGraph(values: unknown[]): { revisions: ScenarioTurnRevision[]; tipEditIds: string[] } | null {
  if (!values.every(validTurnRevision)) return null
  const revisions = values.map((revision) => ({ ...revision, parentEditIds: [...revision.parentEditIds] }))
  const byId = new Map(revisions.map((revision) => [revision.editId, revision]))
  if (byId.size !== revisions.length) return null
  const children = new Map(revisions.map((revision) => [revision.editId, [] as string[]]))
  const indegree = new Map(revisions.map((revision) => [revision.editId, revision.parentEditIds.length]))
  const referenced = new Set<string>()
  for (const revision of revisions) {
    if (revision.parentEditIds.includes(revision.editId) ||
      revision.parentEditIds.some((parentId) => !byId.has(parentId))) return null
    if (revision.source === 'create' && revision.parentEditIds.length !== 0) return null
    if (revision.source === 'edit' && revision.parentEditIds.length !== 1) return null
    if (revision.source === 'reconcile' && revision.parentEditIds.length < 2) return null
    if (revision.source === 'migration-v1' && revision.parentEditIds.length > 1) return null
    for (const parentId of revision.parentEditIds) {
      referenced.add(parentId)
      children.get(parentId)!.push(revision.editId)
    }
  }
  const ready = revisions.filter((revision) => revision.parentEditIds.length === 0).sort(compareRevisions)
  const ordered: ScenarioTurnRevision[] = []
  while (ready.length > 0) {
    const revision = ready.shift()!
    ordered.push(revision)
    for (const childId of children.get(revision.editId)!.sort()) {
      const remaining = indegree.get(childId)! - 1
      indegree.set(childId, remaining)
      if (remaining === 0) {
        ready.push(byId.get(childId)!)
        ready.sort(compareRevisions)
      }
    }
  }
  if (ordered.length !== revisions.length) return null
  return {
    revisions: ordered,
    tipEditIds: revisions.map((revision) => revision.editId).filter((editId) => !referenced.has(editId)).sort(),
  }
}

function validScenarioEdit(value: unknown): value is ScenarioEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['editId', 'authorId', 'timestamp', 'fields', 'changes'])) return false
  const edit = value as Partial<ScenarioEdit>
  if (!stableId(edit.editId) || !stableId(edit.authorId) || !validTimestamp(edit.timestamp) || !Array.isArray(edit.fields) ||
    edit.fields.length === 0 || new Set(edit.fields).size !== edit.fields.length ||
    !edit.fields.every((field) => ['title', 'background', 'status'].includes(field))) return false
  const changes = edit.changes
  return !!changes && typeof changes === 'object' && !Array.isArray(changes) &&
    Object.keys(changes).length === edit.fields.length &&
    edit.fields.every((field) => Object.prototype.hasOwnProperty.call(changes, field)) &&
    (changes.title === undefined || validText(changes.title, 200)) &&
    (changes.background === undefined || validText(changes.background, 50_000, true)) &&
    (changes.status === undefined || statuses.has(changes.status))
}

function createTurnMap(collection: Y.Map<unknown>, input: AddScenarioTurnInput): [string, Y.Map<unknown>] {
  validateIdentity(input.turnId, input.authorId, input.timestamp, input.editId)
  if (!roles.has(input.role)) throw new Error('Invalid scenario turn role')
  if (!validText(input.content, 200_000, true)) throw new Error('Invalid scenario turn content')
  const key = storageKey(collection, input.turnId)
  const turn = new Y.Map<unknown>()
  const revisions = new Y.Map<ScenarioTurnRevision>()
  const revision: ScenarioTurnRevision = {
    editId: input.editId, role: input.role, content: input.content, authorId: input.authorId,
    timestamp: input.timestamp, parentEditIds: [], source: 'create',
  }
  turn.set('id', input.turnId)
  turn.set('createdBy', input.authorId)
  turn.set('createdAt', input.timestamp)
  turn.set('headEditId', input.editId)
  turn.set('revisions', revisions)
  revisions.set(storageKey(collection, input.editId), revision)
  return [key, turn]
}

export function createScenario(collection: Y.Map<unknown>, input: CreateScenarioInput): ResearchScenario {
  validateIdentity(input.id, input.authorId, input.timestamp, input.editId)
  if (scenarioEntries(collection, input.id).length > 0) throw new Error('Scenario already exists')
  if (collection.size >= MAX_SCENARIOS) throw new Error('Scenario collection limit reached')
  if (!validText(input.title, 200)) throw new Error('Invalid scenario title')
  if (!validText(input.background, 50_000, true)) throw new Error('Invalid scenario background')
  const status = input.status ?? 'draft'
  if (!statuses.has(status)) throw new Error('Invalid scenario status')
  const parentScenarioId = input.parentScenarioId ?? null
  if (parentScenarioId !== null) {
    if (!stableId(parentScenarioId) || parentScenarioId === input.id || !readScenario(collection, parentScenarioId)) {
      throw new Error('Scenario parent is missing or invalid')
    }
  }
  const initialTurns = input.turns ?? []
  if (!Array.isArray(initialTurns) || initialTurns.length > MAX_TURNS ||
    new Set(initialTurns.map((turn) => turn.id)).size !== initialTurns.length ||
    new Set(initialTurns.map((turn) => turn.editId)).size !== initialTurns.length) throw new Error('Invalid initial scenario turns')

  const record = new Y.Map<unknown>()
  const turns = new Y.Map<unknown>()
  const turnOrder = new Y.Array<string>()
  const edits = new Y.Map<ScenarioEdit>()
  const createEdit: ScenarioEdit = {
    editId: input.editId, authorId: input.authorId, timestamp: input.timestamp,
    fields: ['title', 'background', 'status'], changes: { title: input.title, background: input.background, status },
  }
  const turnEntries = initialTurns.map((turn) => createTurnMap(collection, {
    scenarioId: input.id, turnId: turn.id, role: turn.role, content: turn.content,
    authorId: input.authorId, timestamp: input.timestamp, editId: turn.editId,
  }))
  transact(collection, () => {
    record.set('schemaVersion', SCENARIO_SCHEMA_VERSION)
    record.set('id', input.id)
    record.set('title', input.title)
    record.set('background', input.background)
    record.set('status', status)
    record.set('parentScenarioId', parentScenarioId)
    record.set('createdBy', input.authorId)
    record.set('createdAt', input.timestamp)
    record.set('turns', turns)
    record.set('turnOrder', turnOrder)
    record.set('edits', edits)
    edits.set(storageKey(collection, input.editId), createEdit)
    turnEntries.forEach(([key, turn]) => turns.set(key, turn))
    if (turnEntries.length) turnOrder.push(turnEntries.map(([key]) => key))
    collection.set(storageKey(collection, input.id), record)
  })
  return readScenario(collection, input.id)!
}

export function updateScenario(collection: Y.Map<unknown>, input: UpdateScenarioInput): ResearchScenario {
  validateIdentity(input.id, input.authorId, input.timestamp, input.editId)
  const current = readScenario(collection, input.id)
  const record = scenarioRecord(collection, input.id)
  if (!current || !(record instanceof Y.Map)) throw new Error('Scenario not found or invalid')
  const edits = record.get('edits')
  if (!(edits instanceof Y.Map)) throw new Error('Scenario edit history is invalid')
  const fields = (['title', 'background', 'status'] as const).filter((field) => input.changes[field] !== undefined)
  if (!fields.length) throw new Error('Scenario update has no changes')
  if (input.changes.title !== undefined && !validText(input.changes.title, 200)) throw new Error('Invalid scenario title')
  if (input.changes.background !== undefined && !validText(input.changes.background, 50_000, true)) throw new Error('Invalid scenario background')
  if (input.changes.status !== undefined && !statuses.has(input.changes.status)) throw new Error('Invalid scenario status')
  const changes = Object.fromEntries(fields.map((field) => [field, input.changes[field]])) as ScenarioEdit['changes']
  const edit: ScenarioEdit = { editId: input.editId, authorId: input.authorId, timestamp: input.timestamp, fields, changes }
  const previous = Array.from(edits.values()).find((candidate) => !!candidate && typeof candidate === 'object' && candidate.editId === input.editId)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(edit)) throw new Error('Scenario edit ID was reused')
    return current
  }
  if (edits.size >= MAX_EDITS) throw new Error('Scenario edit history limit reached')
  transact(collection, () => {
    fields.forEach((field) => record.set(field, input.changes[field]))
    edits.set(storageKey(collection, input.editId), edit)
  })
  return readScenario(collection, input.id)!
}

export function addScenarioTurn(collection: Y.Map<unknown>, input: AddScenarioTurnInput): ResearchScenario {
  const scenario = readScenario(collection, input.scenarioId)
  const record = scenarioRecord(collection, input.scenarioId)
  if (!scenario || !(record instanceof Y.Map)) throw new Error('Scenario not found or invalid')
  if (scenario.turns.some((turn) => turn.id === input.turnId)) throw new Error('Scenario turn already exists')
  if (scenario.turns.length >= MAX_TURNS) throw new Error('Scenario turn limit reached')
  const turns = record.get('turns')
  const order = record.get('turnOrder')
  if (!(turns instanceof Y.Map) || !(order instanceof Y.Array)) throw new Error('Scenario turns are invalid')
  const [key, turn] = createTurnMap(collection, input)
  transact(collection, () => { turns.set(key, turn); order.push([key]) })
  return readScenario(collection, input.scenarioId)!
}

export function updateScenarioTurn(collection: Y.Map<unknown>, input: UpdateScenarioTurnInput): ResearchScenario {
  validateIdentity(input.turnId, input.authorId, input.timestamp, input.editId)
  if (!stableId(input.expectedCurrentEditId) || !roles.has(input.role) || !validText(input.content, 200_000, true)) {
    throw new Error('Invalid scenario turn revision')
  }
  const scenario = readScenario(collection, input.scenarioId)
  const record = scenarioRecord(collection, input.scenarioId)
  if (!scenario || !(record instanceof Y.Map)) throw new Error('Scenario not found or invalid')
  const currentTurn = scenario.turns.find((turn) => turn.id === input.turnId)
  if (!currentTurn) throw new Error('Scenario turn not found or identity is ambiguous')
  const turns = record.get('turns')
  if (!(turns instanceof Y.Map)) throw new Error('Scenario turns are invalid')
  const matches = Array.from(turns.values()).filter((turn) => turn instanceof Y.Map && turn.get('id') === input.turnId) as Y.Map<unknown>[]
  if (matches.length !== 1) throw new Error('Scenario turn not found or identity is ambiguous')
  const revisions = matches[0].get('revisions')
  if (!(revisions instanceof Y.Map)) throw new Error('Scenario turn revisions are invalid')
  const revision: ScenarioTurnRevision = {
    editId: input.editId, role: input.role, content: input.content, authorId: input.authorId,
    timestamp: input.timestamp, parentEditIds: [input.expectedCurrentEditId], source: 'edit',
  }
  const previous = Array.from(revisions.values()).find((candidate) => !!candidate && typeof candidate === 'object' && candidate.editId === input.editId)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(revision)) throw new Error('Scenario turn edit ID was reused')
    return scenario
  }
  if (currentTurn.headEditId !== input.expectedCurrentEditId) throw new Error('Scenario turn revision conflict')
  if (currentTurn.tipEditIds.length !== 1) throw new Error('Scenario turn has sibling revisions that require reconciliation')
  if (revisions.size >= MAX_REVISIONS_PER_TURN) throw new Error('Scenario turn revision limit reached')
  transact(collection, () => {
    revisions.set(storageKey(collection, input.editId), revision)
    matches[0].set('headEditId', input.editId)
  })
  return readScenario(collection, input.scenarioId)!
}

export function reconcileScenarioTurn(collection: Y.Map<unknown>, input: ReconcileScenarioTurnInput): ResearchScenario {
  validateIdentity(input.turnId, input.authorId, input.timestamp, input.editId)
  if (!stableId(input.expectedCurrentEditId) || !roles.has(input.role) || !validText(input.content, 200_000, true) ||
    !Array.isArray(input.expectedTipEditIds) || input.expectedTipEditIds.length < 2 ||
    input.expectedTipEditIds.length > MAX_REVISIONS_PER_TURN ||
    input.expectedTipEditIds.some((editId) => !stableId(editId)) ||
    new Set(input.expectedTipEditIds).size !== input.expectedTipEditIds.length) {
    throw new Error('Invalid scenario turn reconciliation')
  }
  const scenario = readScenario(collection, input.scenarioId)
  const record = scenarioRecord(collection, input.scenarioId)
  if (!scenario || !(record instanceof Y.Map)) throw new Error('Scenario not found or invalid')
  const currentTurn = scenario.turns.find((turn) => turn.id === input.turnId)
  if (!currentTurn) throw new Error('Scenario turn not found or identity is ambiguous')
  const turns = record.get('turns')
  if (!(turns instanceof Y.Map)) throw new Error('Scenario turns are invalid')
  const matches = Array.from(turns.values()).filter((turn) => turn instanceof Y.Map && turn.get('id') === input.turnId) as Y.Map<unknown>[]
  if (matches.length !== 1) throw new Error('Scenario turn not found or identity is ambiguous')
  const revisions = matches[0].get('revisions')
  if (!(revisions instanceof Y.Map)) throw new Error('Scenario turn revisions are invalid')
  const parentEditIds = [...input.expectedTipEditIds].sort()
  const revision: ScenarioTurnRevision = {
    editId: input.editId, role: input.role, content: input.content, authorId: input.authorId,
    timestamp: input.timestamp, parentEditIds, source: 'reconcile',
  }
  const previous = Array.from(revisions.values()).find((candidate) => !!candidate && typeof candidate === 'object' && candidate.editId === input.editId)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(revision)) throw new Error('Scenario turn edit ID was reused')
    return scenario
  }
  if (currentTurn.headEditId !== input.expectedCurrentEditId ||
    JSON.stringify(currentTurn.tipEditIds) !== JSON.stringify(parentEditIds)) {
    throw new Error('Scenario turn reconciliation conflict')
  }
  if (revisions.size >= MAX_REVISIONS_PER_TURN) throw new Error('Scenario turn revision limit reached')
  transact(collection, () => {
    revisions.set(storageKey(collection, input.editId), revision)
    matches[0].set('headEditId', input.editId)
  })
  return readScenario(collection, input.scenarioId)!
}

export function readScenarioTurnRevision(
  collection: Y.Map<unknown>,
  scenarioId: string,
  turnId: string,
  editId: string,
): ScenarioTurnRevision | null {
  if (!stableId(scenarioId) || !stableId(turnId) || !stableId(editId)) return null
  const scenario = readScenario(collection, scenarioId)
  const turn = scenario?.turns.find((candidate) => candidate.id === turnId)
  const revision = turn?.revisions.find((candidate) => candidate.editId === editId)
  return revision ? { ...revision, parentEditIds: [...revision.parentEditIds] } : null
}

export function readScenarioEdit(
  collection: Y.Map<unknown>,
  scenarioId: string,
  editId: string,
): ScenarioEdit | null {
  if (!stableId(scenarioId) || !stableId(editId)) return null
  const scenario = readScenario(collection, scenarioId)
  const edit = scenario?.edits.find((candidate) => candidate.editId === editId)
  return edit ? { ...edit, fields: [...edit.fields], changes: { ...edit.changes } } : null
}
export function deleteScenarioTurn(collection: Y.Map<unknown>, scenarioId: string, turnId: string): ResearchScenario {
  const record = scenarioRecord(collection, scenarioId)
  if (!readScenario(collection, scenarioId) || !(record instanceof Y.Map) || !stableId(turnId)) throw new Error('Scenario or turn is invalid')
  const turns = record.get('turns') as Y.Map<unknown>
  const order = record.get('turnOrder') as Y.Array<string>
  const matches = Array.from(turns.entries()).filter(([, turn]) => turn instanceof Y.Map && turn.get('id') === turnId)
  if (matches.length !== 1) throw new Error('Scenario turn not found or identity is ambiguous')
  const key = matches[0][0]
  const index = order.toArray().indexOf(key)
  transact(collection, () => { turns.delete(key); if (index >= 0) order.delete(index, 1) })
  return readScenario(collection, scenarioId)!
}

export function deleteScenario(collection: Y.Map<unknown>, id: string): boolean {
  if (!stableId(id)) throw new Error('Invalid scenario identity')
  const matches = scenarioEntries(collection, id)
  transact(collection, () => matches.forEach(([key]) => collection.delete(key)))
  return matches.length > 0
}

interface LegacyScenarioTurnRevision {
  editId: string
  role: ScenarioTurnRole
  content: string
  authorId: string
  timestamp: number
}

interface LegacyScenarioTurn {
  id: string
  createdBy: string
  createdAt: number
  revisions: LegacyScenarioTurnRevision[]
}

function validLegacyTurnRevision(value: unknown): value is LegacyScenarioTurnRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['editId', 'role', 'content', 'authorId', 'timestamp'])) return false
  const revision = value as Partial<LegacyScenarioTurnRevision>
  return stableId(revision.editId) && typeof revision.role === 'string' && roles.has(revision.role as ScenarioTurnRole) &&
    validText(revision.content, 200_000, true) && stableId(revision.authorId) && validTimestamp(revision.timestamp)
}

function readLegacyTurn(value: unknown): LegacyScenarioTurn | null {
  if (!(value instanceof Y.Map) || !exactYKeys(value, ['id', 'createdBy', 'createdAt', 'revisions'])) return null
  const id = value.get('id')
  const createdBy = value.get('createdBy')
  const createdAt = value.get('createdAt')
  const revisions = value.get('revisions')
  if (!stableId(id) || !stableId(createdBy) || !validTimestamp(createdAt) || !(revisions instanceof Y.Map) ||
    revisions.size === 0 || revisions.size > MAX_REVISIONS_PER_TURN) return null
  const revisionList = Array.from(revisions.values())
  if (!revisionList.every(validLegacyTurnRevision) ||
    new Set(revisionList.map((revision) => revision.editId)).size !== revisionList.length) return null
  return {
    id, createdBy, createdAt,
    revisions: revisionList.map((revision) => ({ ...revision })).sort((left, right) =>
      left.timestamp - right.timestamp || left.editId.localeCompare(right.editId) || left.authorId.localeCompare(right.authorId)),
  }
}

function readTurn(value: unknown): ScenarioTurn | null {
  if (!(value instanceof Y.Map) || !exactYKeys(value, ['id', 'createdBy', 'createdAt', 'headEditId', 'revisions'])) return null
  const id = value.get('id')
  const createdBy = value.get('createdBy')
  const createdAt = value.get('createdAt')
  const headEditId = value.get('headEditId')
  const revisions = value.get('revisions')
  if (!stableId(id) || !stableId(createdBy) || !validTimestamp(createdAt) || !stableId(headEditId) ||
    !(revisions instanceof Y.Map) || revisions.size === 0 || revisions.size > MAX_REVISIONS_PER_TURN) return null
  const graph = orderedRevisionGraph(Array.from(revisions.values()))
  if (!graph || !graph.tipEditIds.includes(headEditId)) return null
  const current = graph.revisions.find((revision) => revision.editId === headEditId)
  if (!current) return null
  return {
    id, createdBy, createdAt, role: current.role, content: current.content,
    headEditId, tipEditIds: graph.tipEditIds, revisions: graph.revisions,
  }
}

function readLegacyScenario(collection: Y.Map<unknown>, id: string): {
  id: string; parentScenarioId: string | null; turns: LegacyScenarioTurn[]
} | null {
  const record = scenarioRecord(collection, id)
  if (!(record instanceof Y.Map) || !exactYKeys(record, [
    'schemaVersion', 'id', 'title', 'background', 'status', 'parentScenarioId', 'createdBy', 'createdAt', 'turns', 'turnOrder', 'edits',
  ])) return null
  const schemaVersion = record.get('schemaVersion')
  const storedId = record.get('id')
  const title = record.get('title')
  const background = record.get('background')
  const status = record.get('status')
  const parentScenarioId = record.get('parentScenarioId')
  const createdBy = record.get('createdBy')
  const createdAt = record.get('createdAt')
  const turns = record.get('turns')
  const order = record.get('turnOrder')
  const edits = record.get('edits')
  if (schemaVersion !== LEGACY_SCENARIO_SCHEMA_VERSION || storedId !== id || !validText(title, 200) ||
    !validText(background, 50_000, true) || typeof status !== 'string' || !statuses.has(status as ScenarioStatus) ||
    (parentScenarioId !== null && !stableId(parentScenarioId)) || !stableId(createdBy) || !validTimestamp(createdAt) ||
    !(turns instanceof Y.Map) || turns.size > MAX_TURNS || !(order instanceof Y.Array) || order.length !== turns.size ||
    !(edits instanceof Y.Map) || edits.size === 0 || edits.size > MAX_EDITS) return null
  const orderKeys = order.toArray()
  if (!orderKeys.every((key) => typeof key === 'string' && turns.has(key)) || new Set(orderKeys).size !== orderKeys.length ||
    new Set(turns.keys()).size !== orderKeys.length) return null
  const turnList = orderKeys.map((key) => readLegacyTurn(turns.get(key)))
  if (turnList.some((turn) => turn === null) ||
    new Set(turnList.map((turn) => turn!.id)).size !== turnList.length) return null
  const editList = Array.from(edits.values())
  if (!editList.every(validScenarioEdit) || new Set(editList.map((edit) => edit.editId)).size !== editList.length) return null
  return { id, parentScenarioId: parentScenarioId as string | null, turns: turnList as LegacyScenarioTurn[] }
}

export interface ScenarioCollectionMigrationResult {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION
  upgradedScenarioIds: string[]
  existingScenarioIds: string[]
}

export function migrateScenarioCollectionToV2(collection: Y.Map<unknown>): ScenarioCollectionMigrationResult {
  if (collection.size > MAX_SCENARIOS) throw new Error('Scenario collection limit reached')
  const ids = Array.from(collection.values()).map((value) => value instanceof Y.Map ? value.get('id') : null)
  if (ids.some((id) => !stableId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Scenario migration found invalid or ambiguous identities')
  }
  const projected = (ids as string[]).map((id) => {
    const record = scenarioRecord(collection, id)!
    const schemaVersion = record.get('schemaVersion')
    const current = schemaVersion === SCENARIO_SCHEMA_VERSION ? readScenario(collection, id) : null
    const legacy = schemaVersion === LEGACY_SCENARIO_SCHEMA_VERSION ? readLegacyScenario(collection, id) : null
    if (!current && !legacy) throw new Error('Scenario ' + id + ' cannot be migrated safely')
    return { id, parentScenarioId: current ? current.parentScenarioId : legacy!.parentScenarioId, legacy }
  })
  const byId = new Map(projected.map((scenario) => [scenario.id, scenario]))
  for (const scenario of projected) {
    const seen = new Set([scenario.id])
    let parentId = scenario.parentScenarioId
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error('Scenario ' + scenario.id + ' has cyclic ancestry')
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) throw new Error('Scenario ' + scenario.id + ' has missing parent ' + parentId)
      parentId = parent.parentScenarioId
    }
  }
  const upgrades = projected.filter((scenario) => scenario.legacy !== null)
  transact(collection, () => {
    for (const { id, legacy } of upgrades) {
      const record = scenarioRecord(collection, id)!
      const turns = record.get('turns') as Y.Map<unknown>
      for (const legacyTurn of legacy!.turns) {
        const turn = Array.from(turns.values()).find(
          (candidate) => candidate instanceof Y.Map && candidate.get('id') === legacyTurn.id,
        ) as Y.Map<unknown>
        const revisions = turn.get('revisions') as Y.Map<unknown>
        const ordered = legacyTurn.revisions
        for (const [key, value] of revisions.entries()) {
          const revision = value as LegacyScenarioTurnRevision
          const index = ordered.findIndex((candidate) => candidate.editId === revision.editId)
          revisions.set(key, {
            ...revision,
            parentEditIds: index === 0 ? [] : [ordered[index - 1].editId],
            source: 'migration-v1',
          } satisfies ScenarioTurnRevision)
        }
        turn.set('headEditId', ordered[ordered.length - 1].editId)
      }
      record.set('schemaVersion', SCENARIO_SCHEMA_VERSION)
    }
  })
  const graph = inspectScenarioGraph(collection)
  if (!graph.healthy || graph.scenarioCount !== projected.length) {
    throw new Error('Scenario migration produced an invalid graph')
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    upgradedScenarioIds: upgrades.map((scenario) => scenario.id).sort(),
    existingScenarioIds: projected.filter((scenario) => scenario.legacy === null).map((scenario) => scenario.id).sort(),
  }
}

export function readScenario(collection: Y.Map<unknown>, id: string): ResearchScenario | null {
  if (!stableId(id)) return null
  const record = scenarioRecord(collection, id)
  if (!(record instanceof Y.Map) || !exactYKeys(record, [
    'schemaVersion', 'id', 'title', 'background', 'status', 'parentScenarioId', 'createdBy', 'createdAt', 'turns', 'turnOrder', 'edits',
  ])) return null
  const schemaVersion = record.get('schemaVersion')
  const storedId = record.get('id')
  const title = record.get('title')
  const background = record.get('background')
  const status = record.get('status')
  const parentScenarioId = record.get('parentScenarioId')
  const createdBy = record.get('createdBy')
  const createdAt = record.get('createdAt')
  const turns = record.get('turns')
  const order = record.get('turnOrder')
  const edits = record.get('edits')
  if (schemaVersion !== SCENARIO_SCHEMA_VERSION || storedId !== id || !validText(title, 200) ||
    !validText(background, 50_000, true) || typeof status !== 'string' || !statuses.has(status as ScenarioStatus) ||
    (parentScenarioId !== null && !stableId(parentScenarioId)) || !stableId(createdBy) || !validTimestamp(createdAt) ||
    !(turns instanceof Y.Map) || turns.size > MAX_TURNS || !(order instanceof Y.Array) || order.length !== turns.size ||
    !(edits instanceof Y.Map) || edits.size === 0 || edits.size > MAX_EDITS) return null
  const orderKeys = order.toArray()
  if (!orderKeys.every((key) => typeof key === 'string' && turns.has(key)) || new Set(orderKeys).size !== orderKeys.length ||
    new Set(turns.keys()).size !== orderKeys.length) return null
  const turnList = orderKeys.map((key) => readTurn(turns.get(key)))
  if (turnList.some((turn) => turn === null)) return null
  const detachedTurns = turnList as ScenarioTurn[]
  if (new Set(detachedTurns.map((turn) => turn.id)).size !== detachedTurns.length) return null
  const editList = Array.from(edits.values())
  if (!editList.every(validScenarioEdit) || new Set(editList.map((edit) => edit.editId)).size !== editList.length) return null
  const detachedEdits = editList.map((edit) => ({ ...edit, fields: [...edit.fields], changes: { ...edit.changes } })).sort((left, right) =>
    left.timestamp - right.timestamp || left.editId.localeCompare(right.editId) || left.authorId.localeCompare(right.authorId))
  return {
    schemaVersion, id, title, background, status: status as ScenarioStatus,
    parentScenarioId: parentScenarioId as string | null, createdBy, createdAt,
    turns: detachedTurns, edits: detachedEdits,
  }
}

function canonicalSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalSnapshotJson(child)}`).join(',')}`
  }
  return JSON.stringify(value)
}

export interface ScenarioSnapshotImportResult {
  addedScenarioIds: string[]
  existingScenarioIds: string[]
}

function snapshotRecord(collection: Y.Map<unknown>, scenario: ResearchScenario): [string, Y.Map<unknown>] {
  const record = new Y.Map<unknown>()
  const turns = new Y.Map<unknown>()
  const turnOrder = new Y.Array<string>()
  const edits = new Y.Map<ScenarioEdit>()
  record.set('schemaVersion', scenario.schemaVersion)
  record.set('id', scenario.id)
  record.set('title', scenario.title)
  record.set('background', scenario.background)
  record.set('status', scenario.status)
  record.set('parentScenarioId', scenario.parentScenarioId)
  record.set('createdBy', scenario.createdBy)
  record.set('createdAt', scenario.createdAt)
  record.set('turns', turns)
  record.set('turnOrder', turnOrder)
  record.set('edits', edits)
  for (const turn of scenario.turns) {
    const turnRecord = new Y.Map<unknown>()
    const revisions = new Y.Map<ScenarioTurnRevision>()
    turnRecord.set('id', turn.id)
    turnRecord.set('createdBy', turn.createdBy)
    turnRecord.set('createdAt', turn.createdAt)
    turnRecord.set('headEditId', turn.headEditId)
    turnRecord.set('revisions', revisions)
    for (const revision of turn.revisions) {
      revisions.set(storageKey(collection, revision.editId), { ...revision, parentEditIds: [...revision.parentEditIds] })
    }
    const key = storageKey(collection, turn.id)
    turns.set(key, turnRecord)
    turnOrder.push([key])
  }
  for (const edit of scenario.edits) {
    edits.set(storageKey(collection, edit.editId), {
      ...edit, fields: [...edit.fields], changes: { ...edit.changes },
    })
  }
  return [storageKey(collection, scenario.id), record]
}

function validateScenarioSnapshots(scenarios: ResearchScenario[]): ResearchScenario[] {
  if (!Array.isArray(scenarios) || scenarios.length > MAX_SCENARIOS) {
    throw new Error('Scenario pack exceeds the scenario limit')
  }
  if (!scenarios.every((scenario) => !!scenario && typeof scenario === 'object' && !Array.isArray(scenario))) {
    throw new Error('Scenario pack contains an invalid scenario')
  }
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) {
    throw new Error('Scenario pack contains duplicate scenario IDs')
  }
  const scratch = new Y.Doc()
  try {
    const collection = scratch.getMap<unknown>('scenarios')
    for (const scenario of scenarios) {
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        throw new Error('Scenario pack contains an invalid scenario')
      }
      const [key, record] = snapshotRecord(collection, scenario)
      collection.set(key, record)
    }
    const graph = inspectScenarioGraph(collection)
    if (!graph.healthy || graph.scenarioCount !== scenarios.length) {
      throw new Error(`Scenario pack graph is invalid: ${graph.issues.join('; ') || 'scenario count mismatch'}`)
    }
    const normalized = scenarios.map((scenario) => readScenario(collection, scenario.id))
    if (normalized.some((scenario) => scenario === null)) throw new Error('Scenario pack contains invalid authoring history')
    normalized.forEach((scenario, index) => {
      if (canonicalSnapshotJson(scenario) !== canonicalSnapshotJson(scenarios[index])) {
        throw new Error(`Scenario ${scenarios[index].id} is not in canonical lossless form`)
      }
    })
    return normalized as ResearchScenario[]
  } finally {
    scratch.destroy()
  }
}

/**
 * Atomically imports canonical scenario authoring snapshots into an existing collaborative map.
 * Exact duplicates are idempotent. Any same-ID/different-content collision aborts before mutation.
 */
export function importScenarioSnapshots(
  collection: Y.Map<unknown>, scenarios: ResearchScenario[],
): ScenarioSnapshotImportResult {
  const normalized = validateScenarioSnapshots(scenarios)
  const currentGraph = inspectScenarioGraph(collection)
  if (!currentGraph.healthy) {
    throw new Error(`Existing scenario graph is invalid: ${currentGraph.issues.join('; ')}`)
  }
  const existingScenarioIds: string[] = []
  const additions: ResearchScenario[] = []
  for (const scenario of normalized) {
    const existing = readScenario(collection, scenario.id)
    if (existing) {
      if (canonicalSnapshotJson(existing) !== canonicalSnapshotJson(scenario)) {
        throw new Error(`Scenario ID collision: ${scenario.id}`)
      }
      existingScenarioIds.push(scenario.id)
    } else {
      additions.push(scenario)
    }
  }
  if (collection.size + additions.length > MAX_SCENARIOS) {
    throw new Error('Scenario collection limit reached')
  }
  const prepared = additions.map((scenario) => snapshotRecord(collection, scenario))
  for (const [key] of prepared) {
    if (collection.has(key)) throw new Error(`Scenario storage collision: ${key}`)
  }
  const operation = () => prepared.forEach(([key, record]) => collection.set(key, record))
  if (collection.doc) collection.doc.transact(operation, 'syzygy-scenario-pack-import')
  else operation()
  return {
    addedScenarioIds: additions.map((scenario) => scenario.id),
    existingScenarioIds,
  }
}

export function listScenarios(collection: Y.Map<unknown>): ResearchScenario[] {
  if (collection.size > MAX_SCENARIOS) return []
  const ids = Array.from(new Set(Array.from(collection.values())
    .filter((value): value is Y.Map<unknown> => value instanceof Y.Map && stableId(value.get('id')))
    .map((value) => value.get('id') as string))).sort()
  return ids.map((id) => readScenario(collection, id))
    .filter((scenario): scenario is ResearchScenario => scenario !== null)
}

export function inspectScenarioGraph(collection: Y.Map<unknown>) {
  const scenarios = listScenarios(collection)
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const issues: string[] = []
  const invalidRecords = collection.size - scenarios.length
  if (invalidRecords) issues.push(`${invalidRecords} scenario record(s) failed validation`)
  for (const scenario of scenarios) {
    const seen = new Set([scenario.id])
    let parentId = scenario.parentScenarioId
    while (parentId !== null) {
      if (seen.has(parentId)) { issues.push(`Scenario ${scenario.id} has cyclic ancestry`); break }
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) { issues.push(`Scenario ${scenario.id} has missing parent ${parentId}`); break }
      parentId = parent.parentScenarioId
    }
  }
  return {
    healthy: issues.length === 0,
    scenarioCount: scenarios.length,
    invalidRecords,
    roots: scenarios.filter((scenario) => scenario.parentScenarioId === null).map((scenario) => scenario.id).sort(),
    edges: scenarios.filter((scenario) => scenario.parentScenarioId !== null)
      .map((scenario) => ({ parentScenarioId: scenario.parentScenarioId!, scenarioId: scenario.id }))
      .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
    issues,
  }
}
