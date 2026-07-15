import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createScenario, deleteScenario, deleteScenarioTurn } from './scenarioModel'
import {
  createScenarioAnnotation, inspectScenarioAnnotations, readScenarioAnnotations,
  setScenarioAnnotationResolution, updateScenarioAnnotation,
} from './scenarioAnnotationModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'annotation-project', documentId: 'annotation-document', timestamp: 1 })
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}
const seedScenario = (doc: Y.Doc) => createScenario(getProjectSharedTypes(doc).scenarios, {
  id: 'review-scenario', title: 'Review scenario', background: '', authorId: 'researcher-1',
  timestamp: 10, editId: 'create-review-scenario',
  turns: [{ id: 'answer-turn', role: 'assistant', content: 'Draft answer.', editId: 'create-answer-turn' }],
})
const shuffled = <T,>(values: T[], seed: number): T[] => {
  const result = [...values]
  let state = seed >>> 0
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const target = state % (index + 1)
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}
const shared = (doc: Y.Doc) => getProjectSharedTypes(doc)

describe('collaborative scenario annotation model', () => {
  it('retains note edits plus flag resolve and reopen lifecycle attribution', () => {
    const doc = createProjectDocument(manifest)
    seedScenario(doc)
    const { discussions, scenarios } = shared(doc)
    const note = createScenarioAnnotation(discussions, scenarios, {
      annotationId: 'method-note', eventId: 'create-method-note', scenarioId: 'review-scenario', kind: 'note',
      body: 'Check the method.', authorId: 'alice', displayName: 'Alice', timestamp: 20,
    })
    const edited = updateScenarioAnnotation(discussions, scenarios, {
      annotationId: note.id, eventId: 'edit-method-note', scenarioId: note.scenarioId,
      expectedCurrentEventId: note.currentEventId, body: 'Check the sampling method.',
      authorId: 'bob', displayName: 'Bob', timestamp: 21,
    })
    expect(edited).toMatchObject({ body: 'Check the sampling method.', createdBy: 'alice', lastActionBy: 'bob', status: 'open' })
    const flag = createScenarioAnnotation(discussions, scenarios, {
      annotationId: 'unsupported-claim', eventId: 'create-unsupported-claim', scenarioId: 'review-scenario',
      turnId: 'answer-turn', kind: 'flag', body: 'Citation is missing.', authorId: 'alice', displayName: 'Alice', timestamp: 22,
    })
    const resolved = setScenarioAnnotationResolution(discussions, scenarios, {
      annotationId: flag.id, eventId: 'resolve-unsupported-claim', scenarioId: flag.scenarioId,
      expectedCurrentEventId: flag.currentEventId, resolved: true, authorId: 'carol', displayName: 'Carol', timestamp: 23,
    })
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'carol', resolvedAt: 23 })
    const reopened = setScenarioAnnotationResolution(discussions, scenarios, {
      annotationId: flag.id, eventId: 'reopen-unsupported-claim', scenarioId: flag.scenarioId,
      expectedCurrentEventId: resolved.currentEventId, resolved: false, authorId: 'dana', displayName: 'Dana', timestamp: 24,
    })
    expect(reopened).toMatchObject({ status: 'open', resolvedBy: null, resolvedAt: null, lastActionBy: 'dana' })
    expect(reopened.events.map((event) => event.action)).toEqual(['create', 'resolve', 'reopen'])
  })

  it('converges disconnected first notes without namespace replacement across seeded deliveries', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    createScenarioAnnotation(shared(left).discussions, shared(left).scenarios, {
      annotationId: 'left-note', eventId: 'create-left-note', scenarioId: 'review-scenario', kind: 'note', body: 'Left note.',
      authorId: 'left', displayName: 'Left', timestamp: 30,
    })
    createScenarioAnnotation(shared(right).discussions, shared(right).scenarios, {
      annotationId: 'right-note', eventId: 'create-right-note', scenarioId: 'review-scenario', kind: 'note', body: 'Right note.',
      authorId: 'right', displayName: 'Right', timestamp: 31,
    })
    let fingerprint = ''
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...leftUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      expect(readScenarioAnnotations(shared(merged).discussions, 'review-scenario')?.map((item) => item.id)).toEqual(['left-note', 'right-note'])
      fingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(fingerprint)
    }
  })

  it('retains concurrent edit and resolve branches and deterministically projects one current lifecycle', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const created = createScenarioAnnotation(shared(origin).discussions, shared(origin).scenarios, {
      annotationId: 'branching-flag', eventId: 'create-branching-flag', scenarioId: 'review-scenario', kind: 'flag',
      body: 'Needs review.', authorId: 'alice', displayName: 'Alice', timestamp: 20,
    })
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    updateScenarioAnnotation(shared(left).discussions, shared(left).scenarios, {
      annotationId: created.id, eventId: 'left-edit', scenarioId: created.scenarioId,
      expectedCurrentEventId: created.currentEventId, body: 'Needs source review.', authorId: 'left', displayName: 'Left', timestamp: 40,
    })
    setScenarioAnnotationResolution(shared(right).discussions, shared(right).scenarios, {
      annotationId: created.id, eventId: 'right-resolve', scenarioId: created.scenarioId,
      expectedCurrentEventId: created.currentEventId, resolved: true, authorId: 'right', displayName: 'Right', timestamp: 41,
    })
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...rightUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      const annotation = readScenarioAnnotations(shared(merged).discussions, 'review-scenario')![0]
      expect(annotation).toMatchObject({ status: 'resolved', currentEventId: 'right-resolve', resolvedBy: 'right', body: 'Needs review.' })
      expect(annotation.events.map((event) => event.eventId)).toEqual(['create-branching-flag', 'left-edit', 'right-resolve'])
    }
  })

  it('rejects stale lifecycle changes and treats exact event replay idempotently', () => {
    const doc = createProjectDocument(manifest)
    seedScenario(doc)
    const { discussions, scenarios } = shared(doc)
    const created = createScenarioAnnotation(discussions, scenarios, {
      annotationId: 'guarded-note', eventId: 'create-guarded-note', scenarioId: 'review-scenario', kind: 'note',
      body: 'Original.', authorId: 'alice', displayName: 'Alice', timestamp: 50,
    })
    const input = { annotationId: created.id, eventId: 'edit-guarded-note', scenarioId: created.scenarioId,
      expectedCurrentEventId: created.currentEventId, body: 'Edited.', authorId: 'bob', displayName: 'Bob', timestamp: 51 }
    expect(updateScenarioAnnotation(discussions, scenarios, input).body).toBe('Edited.')
    expect(updateScenarioAnnotation(discussions, scenarios, input).events).toHaveLength(2)
    expect(() => updateScenarioAnnotation(discussions, scenarios, {
      ...input, eventId: 'stale-edit', body: 'Stale.',
    })).toThrow('Scenario annotation revision conflict')
    expect(() => updateScenarioAnnotation(discussions, scenarios, {
      ...input, body: 'Conflicting replay.',
    })).toThrow('Scenario annotation event ID was reused')
  })

  it('fails closed on colliding annotation identity and reports missing scenario or turn targets', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    createScenarioAnnotation(shared(left).discussions, shared(left).scenarios, {
      annotationId: 'colliding-note', eventId: 'left-create', scenarioId: 'review-scenario', kind: 'note', body: 'Left.',
      authorId: 'left', displayName: 'Left', timestamp: 60,
    })
    createScenarioAnnotation(shared(right).discussions, shared(right).scenarios, {
      annotationId: 'colliding-note', eventId: 'right-create', scenarioId: 'review-scenario', kind: 'note', body: 'Right.',
      authorId: 'right', displayName: 'Right', timestamp: 61,
    })
    const merged = replica(origin)
    applyProjectUpdate(merged, encodeProjectState(left))
    applyProjectUpdate(merged, encodeProjectState(right))
    expect(readScenarioAnnotations(shared(merged).discussions, 'review-scenario')).toBeNull()
    expect(inspectScenarioAnnotations(shared(merged).discussions, shared(merged).scenarios)).toMatchObject({ healthy: false, invalidRecords: 1 })

    const targetDoc = createProjectDocument(manifest)
    seedScenario(targetDoc)
    createScenarioAnnotation(shared(targetDoc).discussions, shared(targetDoc).scenarios, {
      annotationId: 'turn-note', eventId: 'create-turn-note', scenarioId: 'review-scenario', turnId: 'answer-turn',
      kind: 'note', body: 'Turn note.', authorId: 'alice', displayName: 'Alice', timestamp: 62,
    })
    shared(targetDoc).discussions.set('future-discussion-type', { ignoredByAnnotationProjection: true })
    deleteScenarioTurn(shared(targetDoc).scenarios, 'review-scenario', 'answer-turn')
    expect(inspectScenarioAnnotations(shared(targetDoc).discussions, shared(targetDoc).scenarios).issues).toEqual([
      'Scenario annotation targets missing turn review-scenario/answer-turn',
    ])
    deleteScenario(shared(targetDoc).scenarios, 'review-scenario')
    expect(inspectScenarioAnnotations(shared(targetDoc).discussions, shared(targetDoc).scenarios).orphanScenarioIds).toEqual(['review-scenario'])
  })
})
