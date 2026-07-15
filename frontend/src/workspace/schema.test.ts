import { describe, expect, it } from 'vitest'
import { createProjectManifest, isResearchProjectManifest, parseProjectManifest } from './schema'

describe('research project schema', () => {
  it('creates a stable versioned manifest', () => {
    const manifest = createProjectManifest({ id: 'project-1', documentId: 'doc-1', timestamp: 42 })
    expect(manifest).toEqual({
      schemaVersion: 1,
      id: 'project-1',
      title: 'Untitled research project',
      documentId: 'doc-1',
      createdAt: 42,
      updatedAt: 42,
      transport: { kind: 'local' },
    })
    expect(parseProjectManifest(manifest)).toBe(manifest)
  })

  it.each([
    null,
    {},
    { schemaVersion: 2 },
    { schemaVersion: 1, id: '', title: 'x', documentId: 'd', createdAt: 1, updatedAt: 1, transport: { kind: 'local' } },
    { schemaVersion: 1, id: 'p', title: 'x', documentId: 'd', createdAt: 1, updatedAt: 1, transport: { kind: 'drive' } },
  ])('rejects malformed or future manifests: %j', (candidate) => {
    expect(isResearchProjectManifest(candidate)).toBe(false)
    expect(() => parseProjectManifest(candidate)).toThrow(/invalid or unsupported/i)
  })

  it('keeps a temporarily blank title valid while the user is editing it', () => {
    const manifest = createProjectManifest({ id: 'project-1', documentId: 'doc-1', timestamp: 42 })
    expect(isResearchProjectManifest({ ...manifest, title: '' })).toBe(true)
  })
})
