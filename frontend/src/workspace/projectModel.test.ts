import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'project-1', documentId: 'document-1', title: 'Safety policy', timestamp: 10 })

function replicaFrom(source: Y.Doc): Y.Doc {
  const replica = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(replica, encodeProjectState(source))
  return replica
}

describe('project Yjs model', () => {
  it('converges concurrent offline edits applied in different orders with duplicates', () => {
    const origin = createProjectDocument(manifest)
    const left = replicaFrom(origin)
    const right = replicaFrom(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))

    getProjectSharedTypes(left).scenarios.set('scenario-left', { title: 'Left offline case' })
    getProjectSharedTypes(left).heuristics.set('clarity', { text: 'Use precise language' })
    getProjectSharedTypes(right).scenarios.set('scenario-right', { title: 'Right offline case' })
    getProjectSharedTypes(right).discussions.set('note-right', { text: 'Review the exception' })

    const mergedA = replicaFrom(origin)
    const mergedB = replicaFrom(origin)
    ;[...leftUpdates, ...rightUpdates, ...leftUpdates].forEach((update) => applyProjectUpdate(mergedA, update))
    ;[...rightUpdates].reverse().concat([...leftUpdates].reverse(), rightUpdates).forEach((update) => applyProjectUpdate(mergedB, update))

    expect(projectStateFingerprint(mergedA)).toBe(projectStateFingerprint(mergedB))
    expect(Array.from(getProjectSharedTypes(mergedA).scenarios.keys()).sort()).toEqual(['scenario-left', 'scenario-right'])
    expect(getProjectSharedTypes(mergedA).heuristics.has('clarity')).toBe(true)
    expect(getProjectSharedTypes(mergedA).discussions.has('note-right')).toBe(true)
  })

  it('round-trips every reserved shared collection in one update', () => {
    const source = createProjectDocument(manifest)
    const types = getProjectSharedTypes(source)
    types.settings.set('evaluationMode', 'manual')
    types.scenarios.set('scenario-1', { title: 'A difficult case' })
    types.heuristics.set('heuristic-1', { text: 'State limitations' })

    const restored = replicaFrom(source)
    const restoredTypes = getProjectSharedTypes(restored)
    expect(restoredTypes.metadata.get('projectId')).toBe('project-1')
    expect(restoredTypes.settings.get('evaluationMode')).toBe('manual')
    expect(restoredTypes.scenarios.get('scenario-1')).toEqual({ title: 'A difficult case' })
    expect(restoredTypes.heuristics.get('heuristic-1')).toEqual({ text: 'State limitations' })
  })
})
