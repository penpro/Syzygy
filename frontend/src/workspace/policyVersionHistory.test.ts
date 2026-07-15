import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import { commitPolicyVersion, listPolicyVersions, readPolicyVersion, readPolicyVersionHead, type CommitPolicyVersionInput } from './policyVersionModel'
import { deterministicChangeNote, diffPolicyVersions, restorePolicyVersion } from './policyVersionHistory'

const manifest = createProjectManifest({ id: 'history-project', documentId: 'history-document', timestamp: 1 })
const rootInput: CommitPolicyVersionInput = {
  projectId: manifest.id,
  expectedHeadVersionId: null,
  blocks: [
    { kind: 'heading1', text: 'Research policy' },
    { kind: 'policy', policyId: 'evidence-rule', status: 'draft', text: 'Cite evidence.' },
  ],
  scenarioIds: ['hard-case'],
  participantId: 'participant-1',
  displayName: 'Researcher One',
  createdAt: 10,
  note: 'Root',
}
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}

async function historyWithChild() {
  const doc = createProjectDocument(manifest)
  const { versions, metadata } = getProjectSharedTypes(doc)
  const root = await commitPolicyVersion(versions, metadata, rootInput)
  const child = await commitPolicyVersion(versions, metadata, {
    ...rootInput,
    expectedHeadVersionId: root.versionId,
    createdAt: 20,
    blocks: [
      { kind: 'heading1', text: 'Research policy' },
      { kind: 'policy', policyId: 'evidence-rule', status: 'review', text: 'Cite primary evidence.' },
      { kind: 'paragraph', text: 'Document uncertainty.' },
    ],
    note: 'Review changes',
  })
  return { doc, root, child }
}

describe('policy version history and deterministic diff', () => {
  it('commits against an exact head and rejects stale commits without creating an orphan', async () => {
    const doc = createProjectDocument(manifest)
    const { versions, metadata } = getProjectSharedTypes(doc)
    const root = await commitPolicyVersion(versions, metadata, rootInput)
    expect(readPolicyVersionHead(metadata)).toBe(root.versionId)
    await expect(commitPolicyVersion(versions, metadata, { ...rootInput, createdAt: 11 }))
      .rejects.toThrow('Policy version head conflict')
    expect(versions.size).toBe(1)
  })

  it('restores an old snapshot as a new child of the current head without rewriting history', async () => {
    const { doc, root, child } = await historyWithChild()
    const { versions, metadata } = getProjectSharedTypes(doc)
    const restored = await restorePolicyVersion(versions, metadata, {
      targetVersionId: root.versionId,
      expectedHeadVersionId: child.versionId,
      participantId: 'participant-2',
      displayName: 'Researcher Two',
      createdAt: 30,
    })

    expect(restored.versionId).not.toBe(root.versionId)
    expect(restored.parentVersionId).toBe(child.versionId)
    expect(restored.policy).toEqual(root.policy)
    expect(readPolicyVersionHead(metadata)).toBe(restored.versionId)
    expect((await readPolicyVersion(versions, root.versionId))?.note).toBe('Root')
    expect((await readPolicyVersion(versions, child.versionId))?.note).toBe('Review changes')
    expect(versions.size).toBe(3)
  })

  it('retains both concurrent restore branches and converges one deterministic head', async () => {
    const { doc: origin, root, child } = await historyWithChild()
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    const leftRestore = await restorePolicyVersion(getProjectSharedTypes(left).versions, getProjectSharedTypes(left).metadata, {
      targetVersionId: root.versionId, expectedHeadVersionId: child.versionId,
      participantId: 'participant-left', displayName: 'Left', createdAt: 30,
    })
    const rightRestore = await restorePolicyVersion(getProjectSharedTypes(right).versions, getProjectSharedTypes(right).metadata, {
      targetVersionId: root.versionId, expectedHeadVersionId: child.versionId,
      participantId: 'participant-right', displayName: 'Right', createdAt: 31,
    })

    let expectedFingerprint = ''
    let expectedHead = ''
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      const updates = seed % 2
        ? [...leftUpdates, ...rightUpdates, ...leftUpdates]
        : [...rightUpdates].reverse().concat([...leftUpdates].reverse(), rightUpdates)
      updates.forEach((update) => applyProjectUpdate(merged, update))
      const types = getProjectSharedTypes(merged)
      expect((await listPolicyVersions(types.versions)).map((version) => version.versionId)).toEqual([
        root.versionId, child.versionId, leftRestore.versionId, rightRestore.versionId,
      ])
      const head = readPolicyVersionHead(types.metadata)!
      expect([leftRestore.versionId, rightRestore.versionId]).toContain(head)
      expectedHead ||= head
      expect(head).toBe(expectedHead)
      expectedFingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(expectedFingerprint)
    }
  })

  it('produces a stable engine-free structured diff and change note', async () => {
    const { root, child } = await historyWithChild()
    const first = diffPolicyVersions(root, child)
    const second = diffPolicyVersions(root, child)
    expect(second).toEqual(first)
    expect(first).toMatchObject({ added: 1, removed: 0, changed: 1, moved: 0, unchanged: 1 })
    expect(first.changes.map((change) => [change.kind, change.identity])).toEqual([
      ['changed', 'policy:evidence-rule'],
      ['added', expect.stringMatching(/^content:paragraph:[a-f0-9]{8}:0$/)],
    ])
    expect(deterministicChangeNote(first)).toBe('2 changes: 1 added, 0 removed, 1 changed, 0 moved; 1 unchanged.')
  })

  it('fails closed when the restore target has been tampered with', async () => {
    const { doc, root, child } = await historyWithChild()
    const { versions, metadata } = getProjectSharedTypes(doc)
    versions.set(root.versionId, (versions.get(root.versionId) as string).replace('Research policy', 'Tampered'))
    await expect(restorePolicyVersion(versions, metadata, {
      targetVersionId: root.versionId, expectedHeadVersionId: child.versionId,
      participantId: 'participant-2', displayName: 'Researcher Two', createdAt: 30,
    })).rejects.toThrow('Restore target policy version not found or has invalid lineage')
    expect(readPolicyVersionHead(metadata)).toBe(child.versionId)
  })

  it('rejects a content-valid restore target whose immutable ancestor is missing', async () => {
    const { doc, root, child } = await historyWithChild()
    const { versions, metadata } = getProjectSharedTypes(doc)
    versions.delete(root.versionId)
    expect(await readPolicyVersion(versions, child.versionId)).not.toBeNull()
    await expect(restorePolicyVersion(versions, metadata, {
      targetVersionId: child.versionId, expectedHeadVersionId: child.versionId,
      participantId: 'participant-2', displayName: 'Researcher Two', createdAt: 30,
    })).rejects.toThrow('Restore target policy version not found or has invalid lineage')
    expect(readPolicyVersionHead(metadata)).toBe(child.versionId)
  })
})
