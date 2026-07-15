import * as Y from 'yjs'

export const SCENARIO_SCHEMA_VERSION = 1 as const
export type ScenarioStatus = 'draft' | 'ready' | 'archived'
export type ScenarioTurnRole = 'system' | 'user' | 'assistant'

export interface ScenarioTurnRevision {
  editId: string
  role: ScenarioTurnRole
  content: string
  authorId: string
  timestamp: number
}

export interface ScenarioTurn {
  id: string
  createdBy: string
  createdAt: number
  role: ScenarioTurnRole
  content: string
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

const statuses = new Set<ScenarioStatus>(['draft', 'ready', 'archived'])
const roles = new Set<ScenarioTurnRole>(['system', 'user', 'assistant'])
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
    !exactKeys(value, ['editId', 'role', 'content', 'authorId', 'timestamp'])) return false
  const revision = value as Partial<ScenarioTurnRevision>
  return stableId(revision.editId) && typeof revision.role === 'string' && roles.has(revision.role as ScenarioTurnRole) &&
    validText(revision.content, 200_000, true) && stableId(revision.authorId) && validTimestamp(revision.timestamp)
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
  const revision = { editId: input.editId, role: input.role, content: input.content, authorId: input.authorId, timestamp: input.timestamp }
  turn.set('id', input.turnId)
  turn.set('createdBy', input.authorId)
  turn.set('createdAt', input.timestamp)
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

export function updateScenarioTurn(collection: Y.Map<unknown>, input: AddScenarioTurnInput): ResearchScenario {
  validateIdentity(input.turnId, input.authorId, input.timestamp, input.editId)
  if (!roles.has(input.role) || !validText(input.content, 200_000, true)) throw new Error('Invalid scenario turn revision')
  const record = scenarioRecord(collection, input.scenarioId)
  if (!readScenario(collection, input.scenarioId) || !(record instanceof Y.Map)) throw new Error('Scenario not found or invalid')
  const turns = record.get('turns')
  if (!(turns instanceof Y.Map)) throw new Error('Scenario turns are invalid')
  const matches = Array.from(turns.values()).filter((turn) => turn instanceof Y.Map && turn.get('id') === input.turnId) as Y.Map<unknown>[]
  if (matches.length !== 1) throw new Error('Scenario turn not found or identity is ambiguous')
  const revisions = matches[0].get('revisions')
  if (!(revisions instanceof Y.Map)) throw new Error('Scenario turn revisions are invalid')
  const revision: ScenarioTurnRevision = {
    editId: input.editId, role: input.role, content: input.content, authorId: input.authorId, timestamp: input.timestamp,
  }
  const previous = Array.from(revisions.values()).find((candidate) => !!candidate && typeof candidate === 'object' && candidate.editId === input.editId)
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(revision)) throw new Error('Scenario turn edit ID was reused')
    return readScenario(collection, input.scenarioId)!
  }
  if (revisions.size >= MAX_REVISIONS_PER_TURN) throw new Error('Scenario turn revision limit reached')
  transact(collection, () => revisions.set(storageKey(collection, input.editId), revision))
  return readScenario(collection, input.scenarioId)!
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

function readTurn(value: unknown): ScenarioTurn | null {
  if (!(value instanceof Y.Map) || !exactYKeys(value, ['id', 'createdBy', 'createdAt', 'revisions'])) return null
  const id = value.get('id')
  const createdBy = value.get('createdBy')
  const createdAt = value.get('createdAt')
  const revisions = value.get('revisions')
  if (!stableId(id) || !stableId(createdBy) || !validTimestamp(createdAt) || !(revisions instanceof Y.Map) ||
    revisions.size === 0 || revisions.size > MAX_REVISIONS_PER_TURN) return null
  const revisionList = Array.from(revisions.values())
  if (!revisionList.every(validTurnRevision) || new Set(revisionList.map((revision) => revision.editId)).size !== revisionList.length) return null
  const detached = revisionList.map((revision) => ({ ...revision })).sort((left, right) =>
    left.timestamp - right.timestamp || left.editId.localeCompare(right.editId) || left.authorId.localeCompare(right.authorId))
  const current = detached[detached.length - 1]
  return { id, createdBy, createdAt, role: current.role, content: current.content, revisions: detached }
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
