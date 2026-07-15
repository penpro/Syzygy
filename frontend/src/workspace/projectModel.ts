import * as Y from 'yjs'
import type { ResearchProjectManifest } from './schema'

export const PROJECT_SHARED_TYPES = {
  metadata: 'project:metadata',
  scenarios: 'project:scenarios',
  heuristics: 'project:heuristics',
  versions: 'project:versions',
  discussions: 'project:discussions',
  settings: 'project:settings',
  editorRoot: 'root',
} as const

export interface ProjectSharedTypes {
  metadata: Y.Map<unknown>
  scenarios: Y.Map<unknown>
  heuristics: Y.Map<unknown>
  versions: Y.Map<unknown>
  discussions: Y.Map<unknown>
  settings: Y.Map<unknown>
  editorRoot: Y.XmlText
}

export function getProjectSharedTypes(doc: Y.Doc): ProjectSharedTypes {
  return {
    metadata: doc.getMap(PROJECT_SHARED_TYPES.metadata),
    scenarios: doc.getMap(PROJECT_SHARED_TYPES.scenarios),
    heuristics: doc.getMap(PROJECT_SHARED_TYPES.heuristics),
    versions: doc.getMap(PROJECT_SHARED_TYPES.versions),
    discussions: doc.getMap(PROJECT_SHARED_TYPES.discussions),
    settings: doc.getMap(PROJECT_SHARED_TYPES.settings),
    editorRoot: doc.get(PROJECT_SHARED_TYPES.editorRoot, Y.XmlText) as Y.XmlText,
  }
}

export function createProjectDocument(manifest: ResearchProjectManifest): Y.Doc {
  const doc = new Y.Doc({ guid: manifest.documentId })
  const { metadata } = getProjectSharedTypes(doc)
  doc.transact(() => {
    metadata.set('schemaVersion', manifest.schemaVersion)
    metadata.set('projectId', manifest.id)
    metadata.set('title', manifest.title)
    metadata.set('createdAt', manifest.createdAt)
  }, 'syzygy-project-bootstrap')
  return doc
}

export function encodeProjectState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc)
}

export function applyProjectUpdate(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(doc, update, 'syzygy-provider')
}

export function projectStateFingerprint(doc: Y.Doc): string {
  return Array.from(Y.encodeStateVector(doc)).join('.')
}
