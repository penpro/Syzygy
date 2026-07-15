import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { readPolicyVersionHead } from './policyVersionModel'
import { createProjectManifest } from './schema'
import { saveAutomationPolicyVersion, type SaveAutomationPolicyVersionInput } from './versionAutomation'
import type { AutomationEditorSnapshot } from './editorAutomationRegistry'

const manifest = createProjectManifest({ id: 'automation-version-project', documentId: 'automation-version-document', timestamp: 1 })
const snapshot: AutomationEditorSnapshot = {
  projectId: manifest.id,
  revision: 'lexical-session-1-abcd1234',
  text: '# Policy\n[policy:rule-1:review] Cite evidence.',
  blocks: [
    { kind: 'heading1', text: 'Policy' },
    { kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Cite evidence.' },
  ],
}
const input: SaveAutomationPolicyVersionInput = {
  expectedDocumentRevision: snapshot.revision,
  expectedHeadVersionId: null,
  participantId: 'participant-1',
  displayName: 'Researcher One',
  createdAt: 10,
  note: 'MCP checkpoint',
}

describe('automation policy version checkpoint', () => {
  it('saves the exact semantic editor revision as the immutable head', async () => {
    const doc = createProjectDocument(manifest)
    const saved = await saveAutomationPolicyVersion(doc, manifest.id, input, () => snapshot)
    const { metadata, versions } = getProjectSharedTypes(doc)
    expect(saved.documentRevision).toBe(snapshot.revision)
    expect(saved.version.policy.blocks).toEqual(snapshot.blocks)
    expect(saved.version.note).toBe('MCP checkpoint')
    expect(saved.changeNote).toBeNull()
    expect(readPolicyVersionHead(metadata)).toBe(saved.version.versionId)
    expect(versions.size).toBe(1)
  })

  it('rejects a stale document revision before hashing or mutation', async () => {
    const doc = createProjectDocument(manifest)
    await expect(saveAutomationPolicyVersion(doc, manifest.id, { ...input, expectedDocumentRevision: 'stale-revision' }, () => snapshot))
      .rejects.toThrow('Document revision conflict')
    expect(getProjectSharedTypes(doc).versions.size).toBe(0)
  })

  it('rechecks the live document inside the head transaction after asynchronous hashing', async () => {
    const doc = createProjectDocument(manifest)
    let reads = 0
    const read = () => {
      reads += 1
      return reads === 1 ? snapshot : { ...snapshot, revision: 'lexical-newer-2-efgh5678' }
    }
    await expect(saveAutomationPolicyVersion(doc, manifest.id, input, read)).rejects.toThrow('Document revision conflict')
    const { metadata, versions } = getProjectSharedTypes(doc)
    expect(versions.size).toBe(0)
    expect(readPolicyVersionHead(metadata)).toBeNull()
  })

  it('requires the exact immutable head and derives an engine-free change note', async () => {
    const doc = createProjectDocument(manifest)
    const root = await saveAutomationPolicyVersion(doc, manifest.id, input, () => snapshot)
    const changed = {
      ...snapshot,
      revision: 'lexical-session-2-bbbb2222',
      blocks: [...snapshot.blocks, { kind: 'paragraph' as const, text: 'State uncertainty.' }],
    }
    await expect(saveAutomationPolicyVersion(doc, manifest.id, {
      ...input, expectedDocumentRevision: changed.revision, createdAt: 20,
    }, () => changed)).rejects.toThrow('Policy version head conflict')
    const child = await saveAutomationPolicyVersion(doc, manifest.id, {
      ...input, expectedDocumentRevision: changed.revision, expectedHeadVersionId: root.version.versionId, createdAt: 20,
    }, () => changed)
    expect(child.version.parentVersionId).toBe(root.version.versionId)
    expect(child.changeNote).toBe('1 change: 1 added, 0 removed, 0 changed, 0 moved; 2 unchanged.')
  })
})
