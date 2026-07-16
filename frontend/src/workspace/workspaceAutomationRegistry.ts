import type * as Y from 'yjs'

const documents = new Map<string, Y.Doc>()
const listeners = new Map<string, Set<ProjectDocumentListener>>()
type ProjectDocumentListener = (doc: Y.Doc | null) => void

function notify(projectId: string, doc: Y.Doc | null): void {
  listeners.get(projectId)?.forEach((listener) => listener(doc))
}

export function registerAutomationProjectDocument(projectId: string, doc: Y.Doc): () => void {
  documents.set(projectId, doc)
  notify(projectId, doc)
  return () => {
    if (documents.get(projectId) !== doc) return
    documents.delete(projectId)
    notify(projectId, null)
  }
}

export function subscribeAutomationProjectDocument(
  projectId: string,
  listener: ProjectDocumentListener,
): () => void {
  const projectListeners = listeners.get(projectId) ?? new Set<ProjectDocumentListener>()
  projectListeners.add(listener)
  listeners.set(projectId, projectListeners)
  listener(documents.get(projectId) ?? null)
  return () => {
    projectListeners.delete(listener)
    if (projectListeners.size === 0) listeners.delete(projectId)
  }
}

export function automationProjectDocumentReady(projectId: string): boolean {
  return documents.has(projectId)
}

export function getAutomationProjectDocument(projectId: string): Y.Doc {
  const doc = documents.get(projectId)
  if (!doc) throw new Error(`Project ${projectId} does not have a live collaboration document`)
  return doc
}
