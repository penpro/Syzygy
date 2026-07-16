import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import {
  commitPolicyVersion,
  createPolicyVersion,
  listPolicyVersions,
  readPolicyVersion,
  readPolicyVersionHead,
  type CreatePolicyVersionInput,
} from './policyVersionModel'

const manifest = createProjectManifest({ id: 'version-project', documentId: 'version-document', timestamp: 1 })
const rootInput: CreatePolicyVersionInput = {
  projectId: manifest.id,
  blocks: [
    { kind: 'heading1', text: 'Research policy' },
    { kind: 'policy', policyId: 'evidence-rule', status: 'review', text: 'Cite primary evidence.\r\nState uncertainty.' },
  ],
  scenarioIds: ['scenario-b', 'scenario-a'],
  participantId: 'participant-1',
  displayName: 'Original Name',
  createdAt: 10,
  note: 'Initial review\r\ncheckpoint',
}
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}

describe('immutable policy version model', () => {
  it('creates a canonical content-addressed version and replays identical saves idempotently', async () => {
    const doc = createProjectDocument(manifest)
    const versions = getProjectSharedTypes(doc).versions
    const created = await createPolicyVersion(versions, rootInput)
    const replayed = await createPolicyVersion(versions, { ...rootInput, scenarioIds: ['scenario-a', 'scenario-b'] })

    expect(created.versionId).toMatch(/^[a-f0-9]{64}$/)
    expect(replayed.versionId).toBe(created.versionId)
    expect(versions.size).toBe(1)
    expect(created.scenarioIds).toEqual(['scenario-a', 'scenario-b'])
    expect(created.policy.blocks[1].text).toBe('Cite primary evidence.\nState uncertainty.')
    expect(created.note).toBe('Initial review\ncheckpoint')
  })

  it('detects storage mutation and returns detached snapshots', async () => {
    const doc = createProjectDocument(manifest)
    const versions = getProjectSharedTypes(doc).versions
    const created = await createPolicyVersion(versions, rootInput)
    created.policy.blocks[0].text = 'Mutated caller copy'
    created.author.displayName = 'Mutated caller name'
    expect((await readPolicyVersion(versions, created.versionId))?.policy.blocks[0].text).toBe('Research policy')
    expect((await readPolicyVersion(versions, created.versionId))?.author.displayName).toBe('Original Name')

    const stored = versions.get(created.versionId) as string
    versions.set(created.versionId, stored.replace('Research policy', 'Tampered policy'))
    await expect(readPolicyVersion(versions, created.versionId)).resolves.toBeNull()
  })

  it('preserves historical attribution when a participant later changes display name', async () => {
    const doc = createProjectDocument(manifest)
    const versions = getProjectSharedTypes(doc).versions
    const root = await createPolicyVersion(versions, rootInput)
    const child = await createPolicyVersion(versions, {
      ...rootInput,
      parentVersionId: root.versionId,
      displayName: 'Current Name',
      createdAt: 20,
      blocks: [...rootInput.blocks, { kind: 'paragraph', text: 'Added after review.' }],
    })

    expect((await readPolicyVersion(versions, root.versionId))?.author).toEqual({ participantId: 'participant-1', displayName: 'Original Name' })
    expect(child.author).toEqual({ participantId: 'participant-1', displayName: 'Current Name' })
    expect(child.parentVersionId).toBe(root.versionId)
  })

  it('converges independently created child versions under reordered duplicate delivery', async () => {
    const origin = createProjectDocument(manifest)
    const root = await createPolicyVersion(getProjectSharedTypes(origin).versions, rootInput)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    const leftVersion = await createPolicyVersion(getProjectSharedTypes(left).versions, {
      ...rootInput, parentVersionId: root.versionId, createdAt: 30,
      blocks: [...rootInput.blocks, { kind: 'paragraph', text: 'Left branch.' }],
    })
    const rightVersion = await createPolicyVersion(getProjectSharedTypes(right).versions, {
      ...rootInput, parentVersionId: root.versionId, createdAt: 31,
      blocks: [...rootInput.blocks, { kind: 'paragraph', text: 'Right branch.' }],
    })

    let expectedFingerprint = ''
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      const updates = seed % 2
        ? [...leftUpdates, ...rightUpdates, ...leftUpdates]
        : [...rightUpdates].reverse().concat([...leftUpdates].reverse(), rightUpdates)
      updates.forEach((update) => applyProjectUpdate(merged, update))
      expect((await listPolicyVersions(getProjectSharedTypes(merged).versions)).map((version) => version.versionId)).toEqual([
        root.versionId, leftVersion.versionId, rightVersion.versionId,
      ])
      expectedFingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(expectedFingerprint)
    }
  })

  it('preserves a canonical version that appears during commit preparation when draft mutation rolls back', async () => {
    const doc = createProjectDocument(manifest)
    const { metadata, versions } = getProjectSharedTypes(doc)
    const root = await commitPolicyVersion(versions, metadata, {
      ...rootInput,
      expectedHeadVersionId: null,
    })
    const candidateInput = {
      ...rootInput,
      expectedHeadVersionId: root.versionId,
      createdAt: 99,
      blocks: [...rootInput.blocks, { kind: 'paragraph' as const, text: 'Prepared concurrently.' }],
    }
    const peer = replica(doc)
    const peerVersions = getProjectSharedTypes(peer).versions
    const candidate = await createPolicyVersion(peerVersions, {
      ...candidateInput,
      parentVersionId: root.versionId,
    })
    const canonical = peerVersions.get(candidate.versionId)
    expect(typeof canonical).toBe('string')

    await expect(commitPolicyVersion(
      versions,
      metadata,
      candidateInput,
      () => versions.set(candidate.versionId, canonical),
      {
        apply: () => {
          throw new Error('synthetic draft mutation failure')
        },
        rollback: () => undefined,
      },
    )).rejects.toThrow('synthetic draft mutation failure')

    expect(versions.get(candidate.versionId)).toBe(canonical)
    expect(versions.size).toBe(2)
    expect(readPolicyVersionHead(metadata)).toBe(root.versionId)
  })

  it('rejects missing parents, duplicate scenario references, and non-canonical peer records', async () => {
    const doc = createProjectDocument(manifest)
    const versions = getProjectSharedTypes(doc).versions
    await expect(createPolicyVersion(versions, { ...rootInput, parentVersionId: '0'.repeat(64) })).rejects.toThrow('Parent policy version not found or invalid')
    await expect(createPolicyVersion(versions, { ...rootInput, scenarioIds: ['same', 'same'] })).rejects.toThrow('Invalid policy version scenario references')
    await expect(createPolicyVersion(versions, {
      ...rootInput,
      blocks: [
        { kind: 'policy', policyId: 'duplicate', status: 'draft', text: 'First.' },
        { kind: 'policy', policyId: 'duplicate', status: 'review', text: 'Second.' },
      ],
    })).rejects.toThrow('Policy version contains duplicate policy block IDs')
    const root = await createPolicyVersion(versions, rootInput)
    await expect(createPolicyVersion(versions, { ...rootInput, projectId: 'another-project', parentVersionId: root.versionId, createdAt: 12 }))
      .rejects.toThrow('Parent policy version belongs to another project')
    versions.set('1'.repeat(64), '{"schemaVersion":1,"unknown":true}')
    await expect(readPolicyVersion(versions, '1'.repeat(64))).resolves.toBeNull()
  })
})
