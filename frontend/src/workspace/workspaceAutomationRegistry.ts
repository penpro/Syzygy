import type * as Y from 'yjs'

const documents = new Map<string, Y.Doc>()

export function registerAutomationProjectDocument(projectId: string, doc: Y.Doc): () => void {
  documents.set(projectId, doc)
  return () => {
    if (documents.get(projectId) === doc) documents.delete(projectId)
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
