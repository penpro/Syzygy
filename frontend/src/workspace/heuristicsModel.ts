import * as Y from 'yjs'

export const HEURISTIC_SCHEMA_VERSION = 1 as const
export type HeuristicPriority = 'required' | 'recommended' | 'watch'

export interface HeuristicEdit {
  editId: string
  authorId: string
  timestamp: number
  fields: Array<'title' | 'guidance' | 'priority' | 'enabled'>
  changes: Partial<Pick<ResearchHeuristic, 'title' | 'guidance' | 'priority' | 'enabled'>>
}

export interface ResearchHeuristic {
  schemaVersion: typeof HEURISTIC_SCHEMA_VERSION
  id: string
  title: string
  guidance: string
  priority: HeuristicPriority
  enabled: boolean
  createdBy: string
  createdAt: number
  edits: HeuristicEdit[]
}

export interface CreateHeuristicInput {
  id: string
  title: string
  guidance: string
  priority: HeuristicPriority
  enabled?: boolean
  authorId: string
  timestamp: number
  editId: string
}

export interface UpdateHeuristicInput {
  id: string
  editId: string
  authorId: string
  timestamp: number
  changes: Partial<Pick<ResearchHeuristic, 'title' | 'guidance' | 'priority' | 'enabled'>>
}

const priorities = new Set<HeuristicPriority>(['required', 'recommended', 'watch'])
const MAX_EDIT_HISTORY = 10_000
const validStableId = (value: string, max = 120) =>
  value.length <= max && /^[a-z][a-z0-9-]*$/.test(value)
const validActorId = (value: string) =>
  value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const validTimestamp = (value: number) => Number.isFinite(value) && value >= 0
const validTitle = (value: string) =>
  value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const validGuidance = (value: string) =>
  value.trim().length > 0 && value.length <= 10_000 && !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const asHeuristicMap = (value: unknown): Y.Map<unknown> | null => value instanceof Y.Map ? value : null
const editStorageKey = (collection: Y.Map<unknown>, editId: string) => `${collection.doc?.clientID ?? 'detached'}:${editId}`

function transact(collection: Y.Map<unknown>, operation: () => void): void {
  if (collection.doc) collection.doc.transact(operation, 'syzygy-heuristics')
  else operation()
}

function validateIdentity(id: string, editId: string, authorId: string, timestamp: number): void {
  if (!validStableId(id)) throw new Error('Invalid heuristic ID')
  if (!validStableId(editId)) throw new Error('Invalid heuristic edit ID')
  if (!validActorId(authorId)) throw new Error('Invalid heuristic author ID')
  if (!validTimestamp(timestamp)) throw new Error('Invalid heuristic timestamp')
}

function validStoredEdit(value: unknown): value is HeuristicEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const edit = value as Partial<HeuristicEdit>
  if (
    Object.keys(value).sort().join(',') !== 'authorId,changes,editId,fields,timestamp' ||
    typeof edit.editId !== 'string' || !validStableId(edit.editId) ||
    typeof edit.authorId !== 'string' || !validActorId(edit.authorId) ||
    typeof edit.timestamp !== 'number' || !validTimestamp(edit.timestamp) ||
    !Array.isArray(edit.fields) || edit.fields.length === 0 ||
    new Set(edit.fields).size !== edit.fields.length ||
    !edit.fields.every((field) => ['title', 'guidance', 'priority', 'enabled'].includes(field))
  ) return false
  const changes = edit.changes
  const validChanges = !!changes && typeof changes === 'object' && !Array.isArray(changes) &&
    Object.keys(changes).length === edit.fields.length &&
    edit.fields.every((field) => Object.prototype.hasOwnProperty.call(changes, field)) &&
    (changes.title === undefined || (typeof changes.title === 'string' && validTitle(changes.title))) &&
    (changes.guidance === undefined || (typeof changes.guidance === 'string' && validGuidance(changes.guidance))) &&
    (changes.priority === undefined || priorities.has(changes.priority)) &&
    (changes.enabled === undefined || typeof changes.enabled === 'boolean')
  return validChanges
}

export function createHeuristic(collection: Y.Map<unknown>, input: CreateHeuristicInput): ResearchHeuristic {
  validateIdentity(input.id, input.editId, input.authorId, input.timestamp)
  if (!validTitle(input.title)) throw new Error('Invalid heuristic title')
  if (!validGuidance(input.guidance)) throw new Error('Invalid heuristic guidance')
  if (!priorities.has(input.priority)) throw new Error('Invalid heuristic priority')
  if (collection.has(input.id)) throw new Error('Heuristic already exists')

  const record = new Y.Map<unknown>()
  const edits = new Y.Map<HeuristicEdit>()
  const edit: HeuristicEdit = {
    editId: input.editId,
    authorId: input.authorId,
    timestamp: input.timestamp,
    fields: ['title', 'guidance', 'priority', 'enabled'],
    changes: { title: input.title, guidance: input.guidance, priority: input.priority, enabled: input.enabled ?? true },
  }
  transact(collection, () => {
    record.set('schemaVersion', HEURISTIC_SCHEMA_VERSION)
    record.set('id', input.id)
    record.set('title', input.title)
    record.set('guidance', input.guidance)
    record.set('priority', input.priority)
    record.set('enabled', input.enabled ?? true)
    record.set('createdBy', input.authorId)
    record.set('createdAt', input.timestamp)
    record.set('edits', edits)
    edits.set(editStorageKey(collection, edit.editId), edit)
    collection.set(input.id, record)
  })
  return readHeuristic(collection, input.id)!
}

export function updateHeuristic(collection: Y.Map<unknown>, input: UpdateHeuristicInput): ResearchHeuristic {
  validateIdentity(input.id, input.editId, input.authorId, input.timestamp)
  const record = asHeuristicMap(collection.get(input.id))
  if (!record) throw new Error('Heuristic not found')
  const edits = record.get('edits')
  if (!(edits instanceof Y.Map)) throw new Error('Heuristic edit history is invalid')

  const fields = (['title', 'guidance', 'priority', 'enabled'] as const)
    .filter((field) => input.changes[field] !== undefined)
  if (fields.length === 0) throw new Error('Heuristic update has no changes')
  if (input.changes.title !== undefined && !validTitle(input.changes.title)) throw new Error('Invalid heuristic title')
  if (input.changes.guidance !== undefined && !validGuidance(input.changes.guidance)) throw new Error('Invalid heuristic guidance')
  if (input.changes.priority !== undefined && !priorities.has(input.changes.priority)) throw new Error('Invalid heuristic priority')
  if (input.changes.enabled !== undefined && typeof input.changes.enabled !== 'boolean') throw new Error('Invalid heuristic enabled state')

  const changes = Object.fromEntries(fields.map((field) => [field, input.changes[field]])) as HeuristicEdit['changes']
  const edit: HeuristicEdit = { editId: input.editId, authorId: input.authorId, timestamp: input.timestamp, fields, changes }
  const previous = Array.from(edits.values()).find((candidate) =>
    !!candidate && typeof candidate === 'object' && candidate.editId === input.editId,
  )
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(edit)) throw new Error('Heuristic edit ID was reused')
    return readHeuristic(collection, input.id)!
  }
  if (edits.size >= MAX_EDIT_HISTORY) throw new Error('Heuristic edit history limit reached')
  transact(collection, () => {
    for (const field of fields) record.set(field, input.changes[field])
    edits.set(editStorageKey(collection, edit.editId), edit)
  })
  return readHeuristic(collection, input.id)!
}

export function deleteHeuristic(collection: Y.Map<unknown>, id: string): boolean {
  if (!validStableId(id)) throw new Error('Invalid heuristic ID')
  const removed = collection.has(id)
  transact(collection, () => { collection.delete(id) })
  return removed
}

export function readHeuristic(collection: Y.Map<unknown>, id: string): ResearchHeuristic | null {
  if (!validStableId(id)) return null
  const record = asHeuristicMap(collection.get(id))
  if (!record) return null
  const edits = record.get('edits')
  const schemaVersion = record.get('schemaVersion')
  const storedId = record.get('id')
  const title = record.get('title')
  const guidance = record.get('guidance')
  const priority = record.get('priority')
  const enabled = record.get('enabled')
  const createdBy = record.get('createdBy')
  const createdAt = record.get('createdAt')
  if (
    schemaVersion !== HEURISTIC_SCHEMA_VERSION || storedId !== id || typeof title !== 'string' || !validTitle(title) ||
    typeof guidance !== 'string' || !validGuidance(guidance) || typeof priority !== 'string' || !priorities.has(priority as HeuristicPriority) ||
    typeof enabled !== 'boolean' || typeof createdBy !== 'string' || !validActorId(createdBy) ||
    typeof createdAt !== 'number' || !validTimestamp(createdAt) || !(edits instanceof Y.Map) || edits.size > MAX_EDIT_HISTORY
  ) return null
  const storedEdits = Array.from(edits.values())
  if (!storedEdits.every(validStoredEdit)) return null
  const editList = storedEdits.map((edit) => ({ ...edit, fields: [...edit.fields], changes: { ...edit.changes } })).sort((left, right) =>
    left.timestamp - right.timestamp || left.editId.localeCompare(right.editId),
  )
  if (editList.length === 0 || new Set(editList.map((edit) => edit.editId)).size !== editList.length) return null
  return { schemaVersion, id, title, guidance, priority: priority as HeuristicPriority, enabled, createdBy, createdAt, edits: editList }
}

export function listHeuristics(collection: Y.Map<unknown>): ResearchHeuristic[] {
  return Array.from(collection.keys()).sort().map((id) => readHeuristic(collection, id)).filter((value): value is ResearchHeuristic => value !== null)
}
