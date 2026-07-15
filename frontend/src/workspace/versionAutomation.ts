import type * as Y from 'yjs'
import type { AutomationEditorSnapshot } from './editorAutomationRegistry'
import { deterministicChangeNote, diffPolicyVersions } from './policyVersionHistory'
import { getProjectSharedTypes } from './projectModel'
import { commitPolicyVersion, readPolicyVersion, type PolicyVersion, type VersionPolicyBlock } from './policyVersionModel'

export interface SaveAutomationPolicyVersionInput {
  expectedDocumentRevision: string
  expectedHeadVersionId: string | null
  participantId: string
  displayName: string
  createdAt: number
  note?: string | null
}

export interface SaveAutomationPolicyVersionResult {
  documentRevision: string
  version: PolicyVersion
  changeNote: string | null
}

const versionBlock = (block: AutomationEditorSnapshot['blocks'][number]): VersionPolicyBlock => {
  if (block.kind === 'policy') {
    if (!block.policyId || !block.status) throw new Error('Live policy block is missing identity or status')
    return { kind: block.kind, text: block.text, policyId: block.policyId, status: block.status }
  }
  return { kind: block.kind, text: block.text }
}

export async function saveAutomationPolicyVersion(
  doc: Y.Doc,
  projectId: string,
  input: SaveAutomationPolicyVersionInput,
  readDocument: () => AutomationEditorSnapshot,
): Promise<SaveAutomationPolicyVersionResult> {
  const snapshot = readDocument()
  if (snapshot.projectId !== projectId) throw new Error('Live editor project identity does not match')
  if (snapshot.revision !== input.expectedDocumentRevision) throw new Error('Document revision conflict')
  const { metadata, versions } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== projectId) throw new Error('Live collaboration document project identity does not match')
  const parent = input.expectedHeadVersionId === null ? null : await readPolicyVersion(versions, input.expectedHeadVersionId)
  const version = await commitPolicyVersion(versions, metadata, {
    projectId,
    expectedHeadVersionId: input.expectedHeadVersionId,
    blocks: snapshot.blocks.map(versionBlock),
    scenarioIds: [],
    participantId: input.participantId,
    displayName: input.displayName,
    createdAt: input.createdAt,
    note: input.note,
  }, () => {
    const current = readDocument()
    if (current.projectId !== projectId || current.revision !== input.expectedDocumentRevision) {
      throw new Error('Document revision conflict')
    }
  })
  return {
    documentRevision: input.expectedDocumentRevision,
    version,
    changeNote: parent ? deterministicChangeNote(diffPolicyVersions(parent, version)) : null,
  }
}
