import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes } from './projectModel'
import { createProjectManifest } from './schema'
import { createHeuristic } from './heuristicsModel'
import {
  createHeuristicExample,
  inspectHeuristicExamples,
  listActiveHeuristicExamples,
  readHeuristicExampleHistories,
  removeHeuristicExample,
} from './heuristicExampleModel'

const manifest = createProjectManifest({ id: 'example-project', documentId: 'example-document', timestamp: 1 })
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}
function seeded() {
  const doc = createProjectDocument(manifest)
  createHeuristic(getProjectSharedTypes(doc).heuristics, {
    id: 'evidence-quality', title: 'Evidence quality', guidance: 'Cite primary evidence.', priority: 'required',
    authorId: 'researcher-1', timestamp: 1, editId: 'create-heuristic',
  })
  return doc
}
const add = (doc: Y.Doc, suffix: string, polarity: 'positive' | 'negative', body = `${suffix} example`) => {
  const { discussions, heuristics } = getProjectSharedTypes(doc)
  return createHeuristicExample(discussions, heuristics, {
    eventId: `event-${suffix}`, exampleId: `example-${suffix}`, heuristicId: 'evidence-quality',
    polarity, body, participantId: `researcher-${suffix}`, displayName: `Researcher ${suffix}`, timestamp: 10,
  })
}

describe('collaborative heuristic positive and negative examples', () => {
  it('converges concurrent positive and negative additions across duplicate delivery orders', () => {
    const origin = seeded()
    const left = replica(origin)
    const right = replica(origin)
    add(left, 'positive', 'positive', 'A claim cites a primary source and states uncertainty.')
    add(right, 'negative', 'negative', 'A claim presents an unsupported estimate as settled fact.')
    for (let order = 0; order < 40; order += 1) {
      const merged = replica(origin)
      const updates = order % 2
        ? [encodeProjectState(left), encodeProjectState(right), encodeProjectState(left)]
        : [encodeProjectState(right), encodeProjectState(left), encodeProjectState(right)]
      updates.forEach((update) => applyProjectUpdate(merged, update))
      expect(listActiveHeuristicExamples(getProjectSharedTypes(merged).discussions, 'evidence-quality')
        .map(({ id, polarity }) => [id, polarity])).toEqual([
          ['example-negative', 'negative'], ['example-positive', 'positive'],
        ])
      expect(inspectHeuristicExamples(getProjectSharedTypes(merged).discussions, getProjectSharedTypes(merged).heuristics))
        .toMatchObject({ healthy: true, exampleCount: 2, positiveCount: 1, negativeCount: 1 })
    }
  })

  it('retains attributed removal history and converges concurrent exact-parent removals', () => {
    const origin = seeded()
    const example = add(origin, 'remove', 'positive')
    const left = replica(origin)
    const right = replica(origin)
    for (const [doc, suffix] of [[left, 'left'], [right, 'right']] as const) {
      const { discussions, heuristics } = getProjectSharedTypes(doc)
      removeHeuristicExample(discussions, heuristics, {
        eventId: `remove-${suffix}`, exampleId: example.id, heuristicId: example.heuristicId,
        expectedCurrentEventId: example.currentEventId, participantId: `researcher-${suffix}`,
        displayName: `${suffix} researcher`, timestamp: 20,
      })
    }
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftHistory = readHeuristicExampleHistories(getProjectSharedTypes(left).discussions, example.heuristicId)![0]
    const rightHistory = readHeuristicExampleHistories(getProjectSharedTypes(right).discussions, example.heuristicId)![0]
    expect(rightHistory).toEqual(leftHistory)
    expect(leftHistory.status).toBe('removed')
    expect(leftHistory.events.map(({ eventId }) => eventId)).toEqual(['event-remove', 'remove-left', 'remove-right'])
    expect(listActiveHeuristicExamples(getProjectSharedTypes(left).discussions, example.heuristicId)).toEqual([])
  })

  it('replays exact events and rejects reused identity without changing content', () => {
    const doc = seeded()
    const first = add(doc, 'replay', 'negative', 'Secret example canary.')
    const { discussions, heuristics } = getProjectSharedTypes(doc)
    expect(createHeuristicExample(discussions, heuristics, {
      eventId: 'event-replay', exampleId: 'example-replay', heuristicId: 'evidence-quality',
      polarity: 'negative', body: 'Secret example canary.', participantId: 'researcher-replay',
      displayName: 'Researcher replay', timestamp: 10,
    })).toEqual(first)
    expect(() => createHeuristicExample(discussions, heuristics, {
      eventId: 'event-replay', exampleId: 'example-other', heuristicId: 'evidence-quality',
      polarity: 'positive', body: 'Conflicting body.', participantId: 'researcher-replay',
      displayName: 'Researcher replay', timestamp: 10,
    })).toThrow('event ID was reused')
    expect(readHeuristicExampleHistories(discussions, 'evidence-quality')?.[0].body).toBe('Secret example canary.')
  })

  it('fails closed on disconnected root collision and hostile bucket mutation', () => {
    const origin = seeded()
    const left = replica(origin)
    const right = replica(origin)
    add(left, 'collision', 'positive', 'Left body.')
    const { discussions: rightDiscussions, heuristics: rightHeuristics } = getProjectSharedTypes(right)
    createHeuristicExample(rightDiscussions, rightHeuristics, {
      eventId: 'event-other-root', exampleId: 'example-collision', heuristicId: 'evidence-quality',
      polarity: 'negative', body: 'Right body.', participantId: 'researcher-right', displayName: 'Right', timestamp: 11,
    })
    applyProjectUpdate(left, encodeProjectState(right))
    expect(readHeuristicExampleHistories(getProjectSharedTypes(left).discussions, 'evidence-quality')).toBeNull()

    const bucket = Array.from(getProjectSharedTypes(right).discussions.values()).find((value) => value instanceof Y.Map) as Y.Map<unknown>
    bucket.set('ambient', 'hostile')
    expect(inspectHeuristicExamples(getProjectSharedTypes(right).discussions, rightHeuristics).healthy).toBe(false)
  })

  it('rejects missing heuristics, invalid identity, control bytes, and oversized bodies before mutation', () => {
    const doc = seeded()
    const { discussions, heuristics } = getProjectSharedTypes(doc)
    const base = {
      eventId: 'event-invalid', exampleId: 'example-invalid', heuristicId: 'missing', polarity: 'positive' as const,
      body: 'Body.', participantId: 'researcher', displayName: 'Researcher', timestamp: 1,
    }
    expect(() => createHeuristicExample(discussions, heuristics, base)).toThrow('Heuristic not found')
    expect(() => createHeuristicExample(discussions, heuristics, { ...base, heuristicId: 'evidence-quality', body: 'bad\u0000body' })).toThrow('Invalid')
    expect(() => createHeuristicExample(discussions, heuristics, { ...base, heuristicId: 'evidence-quality', body: 'x'.repeat(100_001) })).toThrow('Invalid')
    expect(discussions.size).toBe(0)
  })
})
