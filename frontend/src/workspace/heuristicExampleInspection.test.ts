import { describe, expect, it } from 'vitest'
import { createHeuristic } from './heuristicsModel'
import { createHeuristicExample } from './heuristicExampleModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { inspectResearchState } from './researchStateInspection'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({
  id: 'heuristic-example-inspection',
  documentId: 'heuristic-example-inspection-document',
  timestamp: 1,
})

function documentWithExample() {
  const doc = createProjectDocument(manifest)
  const { discussions, heuristics } = getProjectSharedTypes(doc)
  createHeuristic(heuristics, {
    id: 'evidence-quality',
    title: 'Evidence quality',
    guidance: 'Require traceable evidence.',
    priority: 'required',
    authorId: 'researcher-1',
    timestamp: 2,
    editId: 'create-evidence-quality',
  })
  createHeuristicExample(discussions, heuristics, {
    eventId: 'example-add-1',
    exampleId: 'example-1',
    heuristicId: 'evidence-quality',
    polarity: 'positive',
    body: 'SECRET-HEURISTIC-EXAMPLE-BODY',
    participantId: 'researcher-1',
    displayName: 'SECRET-HEURISTIC-EXAMPLE-AUTHOR',
    timestamp: 3,
  })
  return doc
}

describe('heuristic example research inspection', () => {
  it('reports content-free counts without example bodies or attribution', async () => {
    const result = await inspectResearchState(documentWithExample(), manifest.id)
    expect(result.heuristicExamples).toEqual({
      exampleCount: 1,
      removedCount: 0,
      positiveCount: 1,
      negativeCount: 0,
      invalidRecords: 0,
      orphanHeuristicIds: [],
    })
    expect(result.selfCheck).toEqual({ healthy: true, issues: [] })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET-HEURISTIC-EXAMPLE-BODY')
    expect(serialized).not.toContain('SECRET-HEURISTIC-EXAMPLE-AUTHOR')
  })

  it('surfaces a malformed target bucket through the shared self-check', async () => {
    const doc = documentWithExample()
    const { discussions } = getProjectSharedTypes(doc)
    const bucket = Array.from(discussions.entries())
      .find(([key]) => key.startsWith('heuristic-examples:v1:'))?.[1]
    if (!bucket || typeof bucket !== 'object' || !('set' in bucket)) throw new Error('example bucket missing')
    ;(bucket as { set: (key: string, value: unknown) => void }).set('unexpected', true)

    const result = await inspectResearchState(doc, manifest.id)
    expect(result.heuristicExamples.invalidRecords).toBeGreaterThan(0)
    expect(result.selfCheck.healthy).toBe(false)
    expect(result.selfCheck.issues.join(' ')).toContain('heuristic example record(s) failed validation')
  })
})
