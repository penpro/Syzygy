import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { readPolicyVersionHead } from './policyVersionModel'
import { createProjectManifest } from './schema'
import {
  restoreAutomationPolicyVersion,
  saveAutomationPolicyVersion,
  type SaveAutomationPolicyVersionInput,
} from './versionAutomation'
import type { AutomationDocumentBlock, AutomationEditorSnapshot } from './editorAutomationRegistry'

const manifest = createProjectManifest({ id: 'automation-version-project', documentId: 'automation-version-document', timestamp: 1 })
const snapshot: AutomationEditorSnapshot = {
  projectId: manifest.id,
  revision: 'lexical-session-1-abcd1234',
  text: '# Policy\n[policy:rule-1:review] Cite evidence.',
  blocks: [
    { kind: 'heading1', text: 'Policy' },
    { kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Cite evidence.' },
  ],
  scenarioIds: ['scenario-access'],
}
const input: SaveAutomationPolicyVersionInput = {
  expectedDocumentRevision: snapshot.revision,
  expectedHeadVersionId: null,
  participantId: 'participant-1',
  displayName: 'Researcher One',
  createdAt: 10,
  note: 'MCP checkpoint',
}

const changedSnapshot: AutomationEditorSnapshot = {
  ...snapshot,
  revision: 'lexical-session-2-bbbb2222',
  text: '# Policy\n[policy:rule-1:approved] Cite two independent sources.',
  blocks: [
    { kind: 'heading1', text: 'Policy' },
    { kind: 'policy', policyId: 'rule-1', status: 'approved', text: 'Cite two independent sources.' },
  ],
}

const cloneBlocks = (blocks: AutomationDocumentBlock[]): AutomationDocumentBlock[] =>
  blocks.map((block) => ({ ...block }))

async function seededRestoreHistory() {
  const doc = createProjectDocument(manifest)
  const root = await saveAutomationPolicyVersion(doc, manifest.id, input, () => snapshot)
  const child = await saveAutomationPolicyVersion(doc, manifest.id, {
    ...input,
    expectedDocumentRevision: changedSnapshot.revision,
    expectedHeadVersionId: root.version.versionId,
    createdAt: 20,
    note: 'Current draft',
  }, () => changedSnapshot)
  return { doc, root, child }
}

describe('automation policy version checkpoint', () => {
  it('saves the exact semantic editor revision as the immutable head', async () => {
    const doc = createProjectDocument(manifest)
    const saved = await saveAutomationPolicyVersion(doc, manifest.id, input, () => snapshot)
    const { metadata, versions } = getProjectSharedTypes(doc)
    expect(saved.documentRevision).toBe(snapshot.revision)
    expect(saved.version.policy.blocks).toEqual(snapshot.blocks)
    expect(saved.version.scenarioIds).toEqual(snapshot.scenarioIds)
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

  it('restores the live semantic draft and creates its new immutable head in one Yjs transaction', async () => {
    const { doc, root, child } = await seededRestoreHistory()
    const draft = doc.getArray<string>('restore-test-draft')
    draft.insert(0, [JSON.stringify(changedSnapshot.blocks)])
    let live: AutomationEditorSnapshot = { ...changedSnapshot, blocks: cloneBlocks(changedSnapshot.blocks) }
    let generation = 2
    const observed: Array<{ head: string | null; draft: string; versions: number }> = []
    doc.on('afterTransaction', (transaction) => {
      if (transaction.origin !== 'syzygy-policy-version-head') return
      const { metadata, versions } = getProjectSharedTypes(doc)
      observed.push({
        head: readPolicyVersionHead(metadata),
        draft: draft.get(0),
        versions: versions.size,
      })
    })
    const controller = {
      read: () => live,
      replaceBlocks: (expectedRevision: string, blocks: AutomationDocumentBlock[]) => {
        if (live.revision !== expectedRevision) throw new Error('test revision conflict')
        draft.delete(0, draft.length)
        draft.insert(0, [JSON.stringify(blocks)])
        generation += 1
        live = {
          projectId: manifest.id,
          revision: `lexical-restore-${generation}`,
          text: '',
          blocks: cloneBlocks(blocks),
          scenarioIds: [],
        }
        return live
      },
    }

    const restored = await restoreAutomationPolicyVersion(doc, manifest.id, {
      targetVersionId: root.version.versionId,
      expectedDocumentRevision: changedSnapshot.revision,
      expectedHeadVersionId: child.version.versionId,
      participantId: 'participant-1',
      displayName: 'Researcher One',
      createdAt: 30,
    }, controller)

    const { metadata, versions } = getProjectSharedTypes(doc)
    expect(restored.version.parentVersionId).toBe(child.version.versionId)
    expect(restored.version.policy.blocks).toEqual(root.version.policy.blocks)
    expect(restored.version.scenarioIds).toEqual(root.version.scenarioIds)
    expect(restored.document.blocks).toEqual(root.version.policy.blocks)
    expect(restored.changeNote).toBe('1 change: 0 added, 0 removed, 1 changed, 0 moved; 1 unchanged.')
    expect(readPolicyVersionHead(metadata)).toBe(restored.version.versionId)
    expect(versions.size).toBe(3)
    expect(observed).toEqual([{
      head: restored.version.versionId,
      draft: JSON.stringify(root.version.policy.blocks),
      versions: 3,
    }])
  })

  it('rolls the live draft and shared head back inside the same transaction when replacement fails', async () => {
    const { doc, root, child } = await seededRestoreHistory()
    const draft = doc.getArray<string>('restore-test-draft')
    draft.insert(0, [JSON.stringify(changedSnapshot.blocks)])
    let live: AutomationEditorSnapshot = { ...changedSnapshot, blocks: cloneBlocks(changedSnapshot.blocks) }
    let calls = 0
    const finalStates: Array<{ head: string | null; draft: string; versions: number }> = []
    doc.on('afterTransaction', (transaction) => {
      if (transaction.origin !== 'syzygy-policy-version-head') return
      const { metadata, versions } = getProjectSharedTypes(doc)
      finalStates.push({ head: readPolicyVersionHead(metadata), draft: draft.get(0), versions: versions.size })
    })
    const controller = {
      read: () => live,
      replaceBlocks: (expectedRevision: string, blocks: AutomationDocumentBlock[]) => {
        if (live.revision !== expectedRevision) throw new Error('test revision conflict')
        calls += 1
        draft.delete(0, draft.length)
        draft.insert(0, [JSON.stringify(blocks)])
        live = {
          projectId: manifest.id,
          revision: `lexical-rollback-${calls}`,
          text: '',
          blocks: cloneBlocks(blocks),
          scenarioIds: [],
        }
        if (calls === 1) throw new Error('synthetic editor failure')
        return live
      },
    }

    await expect(restoreAutomationPolicyVersion(doc, manifest.id, {
      targetVersionId: root.version.versionId,
      expectedDocumentRevision: changedSnapshot.revision,
      expectedHeadVersionId: child.version.versionId,
      participantId: 'participant-1',
      displayName: 'Researcher One',
      createdAt: 30,
    }, controller)).rejects.toThrow('synthetic editor failure')

    const { metadata, versions } = getProjectSharedTypes(doc)
    expect(calls).toBe(2)
    expect(live.blocks).toEqual(changedSnapshot.blocks)
    expect(draft.toArray()).toEqual([JSON.stringify(changedSnapshot.blocks)])
    expect(readPolicyVersionHead(metadata)).toBe(child.version.versionId)
    expect(versions.size).toBe(2)
    expect(finalStates).toEqual([{
      head: child.version.versionId,
      draft: JSON.stringify(changedSnapshot.blocks),
      versions: 2,
    }])
  })

  it('rejects stale restore input before invoking the editor mutation', async () => {
    const { doc, root, child } = await seededRestoreHistory()
    let replaceCalls = 0
    await expect(restoreAutomationPolicyVersion(doc, manifest.id, {
      targetVersionId: root.version.versionId,
      expectedDocumentRevision: 'stale-document',
      expectedHeadVersionId: child.version.versionId,
      participantId: 'participant-1',
      displayName: 'Researcher One',
      createdAt: 30,
    }, {
      read: () => changedSnapshot,
      replaceBlocks: () => {
        replaceCalls += 1
        return changedSnapshot
      },
    })).rejects.toThrow('Document revision conflict')
    expect(replaceCalls).toBe(0)
    expect(getProjectSharedTypes(doc).versions.size).toBe(2)
  })
})
