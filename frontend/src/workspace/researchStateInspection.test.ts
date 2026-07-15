import { describe, expect, it } from 'vitest'
import { createHeuristic } from './heuristicsModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { commitPolicyVersion } from './policyVersionModel'
import { inspectResearchState } from './researchStateInspection'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'inspection-project', documentId: 'inspection-document', timestamp: 1 })

async function populatedDocument() {
  const doc = createProjectDocument(manifest)
  const { heuristics, versions, metadata } = getProjectSharedTypes(doc)
  createHeuristic(heuristics, {
    id: 'evidence-quality', title: 'Evidence quality', guidance: 'Secret guidance is omitted.', priority: 'required',
    authorId: 'researcher-1', timestamp: 10, editId: 'create-evidence-quality',
  })
  const version = await commitPolicyVersion(versions, metadata, {
    projectId: manifest.id, expectedHeadVersionId: null,
    blocks: [{ kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Secret policy text is omitted.' }],
    participantId: 'researcher-1', displayName: 'Researcher One', createdAt: 11, note: 'Secret note is omitted.',
  })
  return { doc, version }
}

describe('research state inspection', () => {
  it('returns bounded metadata and a healthy integrity result without research bodies', async () => {
    const { doc, version } = await populatedDocument()
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.selfCheck).toEqual({ healthy: true, issues: [] })
    expect(result.heuristics).toMatchObject({ totalRecords: 1, validRecords: 1, invalidRecords: 0 })
    expect(result.versions).toMatchObject({ totalRecords: 1, validRecords: 1, invalidRecords: 0, headVersionId: version.versionId, headLineageDepth: 1 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('Secret guidance')
    expect(serialized).not.toContain('Secret policy text')
    expect(serialized).not.toContain('Secret note')
  })

  it('reports a tampered version and invalid head lineage without throwing', async () => {
    const { doc, version } = await populatedDocument()
    const { versions } = getProjectSharedTypes(doc)
    versions.set(version.versionId, (versions.get(version.versionId) as string).replace('Secret policy text', 'Tampered text'))
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.selfCheck.healthy).toBe(false)
    expect(result.versions).toMatchObject({ totalRecords: 1, validRecords: 0, invalidRecords: 1, headVersionId: version.versionId, headLineageDepth: 0 })
    expect(result.selfCheck.issues).toEqual([
      '1 version record(s) failed hash/schema validation',
      'The policy version head or its lineage is invalid',
    ])
  })

  it('reports a content-valid non-head record whose ancestor is missing', async () => {
    const { doc, version: root } = await populatedDocument()
    const { versions, metadata } = getProjectSharedTypes(doc)
    const child = await commitPolicyVersion(versions, metadata, {
      projectId: manifest.id, expectedHeadVersionId: root.versionId,
      blocks: [{ kind: 'paragraph', text: 'Child snapshot.' }],
      participantId: 'researcher-1', displayName: 'Researcher One', createdAt: 12,
    })
    versions.delete(root.versionId)
    const result = await inspectResearchState(doc, manifest.id)
    expect(result.versions).toMatchObject({
      totalRecords: 1, validRecords: 1, invalidRecords: 0, invalidLineageRecords: 1,
      headVersionId: child.versionId, headLineageDepth: 0,
    })
    expect(result.selfCheck.issues).toEqual([
      '1 version record(s) have missing, cross-project, or cyclic ancestry',
      'The policy version head or its lineage is invalid',
    ])
  })
})
