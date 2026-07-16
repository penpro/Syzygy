import * as Y from 'yjs'
import { LocalProjectProvider } from './localProvider'
import { applyProjectUpdate, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { parseProjectManifest, type ResearchProjectManifest } from './schema'

export const PROJECT_ARCHIVE_FORMAT = 'syzygy-project-archive' as const
export const PROJECT_ARCHIVE_SCHEMA_VERSION = 1 as const
export const PROJECT_ARCHIVE_EXTENSION = '.syzygy-project.json' as const

const MAX_ARCHIVE_UPDATE_BYTES = 25_000_000
export const PROJECT_ARCHIVE_MAX_FILE_BYTES = 36_000_000
const MAX_ARCHIVE_TEXT_CHARS = PROJECT_ARCHIVE_MAX_FILE_BYTES
const MAX_MANIFEST_ID = 200
const MAX_PROJECT_TITLE = 20_000
const encoder = new TextEncoder()
const sha256Pattern = /^[a-f0-9]{64}$/
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

interface ProjectArchiveDocument {
  encoding: 'yjs-update-v1-base64'
  byteLength: number
  sha256: string
  updateBase64: string
}

interface ProjectArchivePayload {
  format: typeof PROJECT_ARCHIVE_FORMAT
  schemaVersion: typeof PROJECT_ARCHIVE_SCHEMA_VERSION
  exportedAt: number
  manifest: ResearchProjectManifest
  document: ProjectArchiveDocument
}

interface ProjectArchiveEnvelope extends ProjectArchivePayload {
  archiveSha256: string
}

export interface DecodedProjectArchive {
  manifest: ResearchProjectManifest
  sourceManifest: ResearchProjectManifest
  doc: Y.Doc
  updateSha256: string
  updateByteLength: number
  exportedAt: number
}

const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')

function normalizedManifest(value: unknown): ResearchProjectManifest {
  const parsed = parseProjectManifest(value)
  const expected = ['schemaVersion', 'id', 'title', 'documentId', 'createdAt', 'updatedAt', 'transport']
  if (parsed.archivedAt !== undefined) expected.push('archivedAt')
  if (!exactKeys(parsed, expected)) throw new Error('Project archive manifest contains unsupported fields')
  if (parsed.id.length > MAX_MANIFEST_ID || parsed.documentId.length > MAX_MANIFEST_ID) {
    throw new Error('Project archive identity exceeds the size limit')
  }
  if (parsed.title.length > MAX_PROJECT_TITLE) throw new Error('Project archive title exceeds the size limit')
  if (parsed.transport.kind === 'local') {
    if (!exactKeys(parsed.transport, ['kind'])) throw new Error('Project archive local transport is malformed')
  } else if (!exactKeys(parsed.transport, ['kind', 'workspaceId']) || parsed.transport.workspaceId.length > MAX_MANIFEST_ID) {
    throw new Error('Project archive Drive transport is malformed')
  }
  return {
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    title: parsed.title,
    documentId: parsed.documentId,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    ...(parsed.archivedAt === undefined ? {} : { archivedAt: parsed.archivedAt }),
    transport: parsed.transport.kind === 'local'
      ? { kind: 'local' }
      : { kind: 'drive', workspaceId: parsed.transport.workspaceId },
  }
}

function localImportManifest(source: ResearchProjectManifest): ResearchProjectManifest {
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    title: source.title,
    documentId: source.documentId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    transport: { kind: 'local' },
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(bytes.byteLength)
  ownedBytes.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', ownedBytes.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const sha256Text = (value: string) => sha256(encoder.encode(value))

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !base64Pattern.test(value)) {
    throw new Error('Project archive document encoding is invalid')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('Project archive document encoding is invalid')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function canonicalPayload(payload: ProjectArchivePayload): string {
  return JSON.stringify({
    format: payload.format,
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    manifest: normalizedManifest(payload.manifest),
    document: {
      encoding: payload.document.encoding,
      byteLength: payload.document.byteLength,
      sha256: payload.document.sha256,
      updateBase64: payload.document.updateBase64,
    },
  })
}

function assertDocumentIdentity(doc: Y.Doc, manifest: ResearchProjectManifest): void {
  if (doc.guid !== manifest.documentId) throw new Error('Project archive document identity does not match its manifest')
  const { metadata } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== manifest.id || metadata.get('schemaVersion') !== manifest.schemaVersion) {
    throw new Error('Project archive shared metadata does not match its manifest')
  }
}

export async function createProjectArchive(
  manifestValue: ResearchProjectManifest,
  doc: Y.Doc,
  exportedAt = Date.now(),
): Promise<string> {
  const manifest = normalizedManifest(manifestValue)
  if (!Number.isFinite(exportedAt) || exportedAt < 0) throw new Error('Project archive export time is invalid')
  assertDocumentIdentity(doc, manifest)
  const update = encodeProjectState(doc)
  if (update.byteLength === 0 || update.byteLength > MAX_ARCHIVE_UPDATE_BYTES) {
    throw new Error('Project archive document exceeds the size limit')
  }
  const document: ProjectArchiveDocument = {
    encoding: 'yjs-update-v1-base64',
    byteLength: update.byteLength,
    sha256: await sha256(update),
    updateBase64: bytesToBase64(update),
  }
  const payload: ProjectArchivePayload = {
    format: PROJECT_ARCHIVE_FORMAT,
    schemaVersion: PROJECT_ARCHIVE_SCHEMA_VERSION,
    exportedAt,
    manifest,
    document,
  }
  const envelope: ProjectArchiveEnvelope = {
    ...payload,
    archiveSha256: await sha256Text(canonicalPayload(payload)),
  }
  return JSON.stringify(envelope, null, 2)
}

export async function decodeProjectArchive(text: string): Promise<DecodedProjectArchive> {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ARCHIVE_TEXT_CHARS) {
    throw new Error('Project archive is empty or exceeds the size limit')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Project archive is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !exactKeys(value, ['format', 'schemaVersion', 'exportedAt', 'manifest', 'document', 'archiveSha256'])) {
    throw new Error('Project archive envelope has an unsupported shape')
  }
  const envelope = value as Partial<ProjectArchiveEnvelope>
  if (envelope.format !== PROJECT_ARCHIVE_FORMAT || envelope.schemaVersion !== PROJECT_ARCHIVE_SCHEMA_VERSION) {
    throw new Error('Project archive format or schema version is unsupported')
  }
  if (typeof envelope.exportedAt !== 'number' || !Number.isFinite(envelope.exportedAt) || envelope.exportedAt < 0) {
    throw new Error('Project archive export time is invalid')
  }
  if (typeof envelope.archiveSha256 !== 'string' || !sha256Pattern.test(envelope.archiveSha256)) {
    throw new Error('Project archive checksum is invalid')
  }
  const sourceManifest = normalizedManifest(envelope.manifest)
  const document = envelope.document
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
    !exactKeys(document, ['encoding', 'byteLength', 'sha256', 'updateBase64']) ||
    document.encoding !== 'yjs-update-v1-base64' ||
    typeof document.byteLength !== 'number' || !Number.isSafeInteger(document.byteLength) ||
    document.byteLength <= 0 || document.byteLength > MAX_ARCHIVE_UPDATE_BYTES ||
    typeof document.sha256 !== 'string' || !sha256Pattern.test(document.sha256) ||
    typeof document.updateBase64 !== 'string') {
    throw new Error('Project archive document descriptor is invalid')
  }
  const payload: ProjectArchivePayload = {
    format: PROJECT_ARCHIVE_FORMAT,
    schemaVersion: PROJECT_ARCHIVE_SCHEMA_VERSION,
    exportedAt: envelope.exportedAt,
    manifest: sourceManifest,
    document: {
      encoding: document.encoding,
      byteLength: document.byteLength,
      sha256: document.sha256,
      updateBase64: document.updateBase64,
    },
  }
  if (await sha256Text(canonicalPayload(payload)) !== envelope.archiveSha256) {
    throw new Error('Project archive envelope checksum does not match')
  }
  const update = base64ToBytes(document.updateBase64)
  if (update.byteLength !== document.byteLength || await sha256(update) !== document.sha256) {
    throw new Error('Project archive document checksum does not match')
  }
  const doc = new Y.Doc({ guid: sourceManifest.documentId })
  try {
    applyProjectUpdate(doc, update)
  } catch {
    doc.destroy()
    throw new Error('Project archive contains an invalid Yjs update')
  }
  assertDocumentIdentity(doc, sourceManifest)
  return {
    manifest: localImportManifest(sourceManifest),
    sourceManifest,
    doc,
    updateSha256: document.sha256,
    updateByteLength: document.byteLength,
    exportedAt: envelope.exportedAt,
  }
}

export function assertProjectArchiveImportAvailable(
  manifest: ResearchProjectManifest,
  existingProjects: ResearchProjectManifest[],
): void {
  if (existingProjects.some((project) => project.id === manifest.id || project.documentId === manifest.documentId)) {
    throw new Error('This project already exists on this installation; archive import will not overwrite or fork it')
  }
}

export async function persistDecodedProjectArchive(decoded: DecodedProjectArchive): Promise<void> {
  const storageKey = `syzygy-project-v1:${decoded.manifest.id}`
  const before = projectStateFingerprint(decoded.doc)
  const provider = new LocalProjectProvider(decoded.doc, storageKey, decoded.manifest.id)
  try {
    provider.connect()
    await provider.whenReady()
    if (projectStateFingerprint(decoded.doc) !== before) {
      throw new Error('Local storage already contains different state for this project; import was not applied')
    }
    await provider.flush()
  } finally {
    await provider.destroy()
  }
}