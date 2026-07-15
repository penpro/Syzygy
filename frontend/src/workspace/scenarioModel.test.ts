import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import {
  addScenarioTurn,
  createScenario,
  deleteScenario,
  deleteScenarioTurn,
  inspectScenarioGraph,
  listScenarios,
  readScenario,
  updateScenario,
  updateScenarioTurn,
} from './scenarioModel'

const manifest = createProjectManifest({ id: 'scenario-project', documentId: 'scenario-document', timestamp: 1 })
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}
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
const seedScenario = (doc: Y.Doc) => createScenario(getProjectSharedTypes(doc).scenarios, {
  id: 'source-review', title: 'Source review', background: 'A claim needs verification.',
  authorId: 'researcher-1', timestamp: 10, editId: 'create-source-review',
  turns: [
    { id: 'turn-question', role: 'user', content: 'What supports this claim?', editId: 'create-turn-question' },
    { id: 'turn-answer', role: 'assistant', content: 'One secondary source.', editId: 'create-turn-answer' },
  ],
})

describe('collaborative scenario model', () => {
  it('supports lifecycle CRUD, attributed multi-turn revisions, and branch lineage', () => {
    const doc = createProjectDocument(manifest)
    const scenarios = getProjectSharedTypes(doc).scenarios
    const root = seedScenario(doc)
    expect(root.turns.map((turn) => [turn.role, turn.content])).toEqual([
      ['user', 'What supports this claim?'], ['assistant', 'One secondary source.'],
    ])
    updateScenarioTurn(scenarios, {
      scenarioId: root.id, turnId: 'turn-answer', role: 'assistant', content: 'Two primary sources support it.',
      authorId: 'researcher-2', timestamp: 20, editId: 'revise-turn-answer',
    })
    addScenarioTurn(scenarios, {
      scenarioId: root.id, turnId: 'turn-followup', role: 'user', content: 'What remains uncertain?',
      authorId: 'researcher-2', timestamp: 21, editId: 'create-turn-followup',
    })
    updateScenario(scenarios, {
      id: root.id, authorId: 'researcher-2', timestamp: 22, editId: 'ready-source-review', changes: { status: 'ready' },
    })
    createScenario(scenarios, {
      id: 'source-review-branch', title: 'Source review — skeptical branch', background: 'Challenge source independence.',
      parentScenarioId: root.id, authorId: 'researcher-3', timestamp: 23, editId: 'create-skeptical-branch',
    })
    const updated = readScenario(scenarios, root.id)!
    expect(updated.status).toBe('ready')
    expect(updated.turns[1]).toMatchObject({ content: 'Two primary sources support it.', createdBy: 'researcher-1' })
    expect(updated.turns[1].revisions.map((revision) => revision.authorId)).toEqual(['researcher-1', 'researcher-2'])
    expect(inspectScenarioGraph(scenarios)).toMatchObject({ healthy: true, scenarioCount: 2, roots: ['source-review'] })
    deleteScenarioTurn(scenarios, root.id, 'turn-followup')
    expect(readScenario(scenarios, root.id)?.turns.map((turn) => turn.id)).toEqual(['turn-question', 'turn-answer'])
    expect(deleteScenario(scenarios, 'source-review-branch')).toBe(true)
    expect(listScenarios(scenarios).map((scenario) => scenario.id)).toEqual(['source-review'])
  })

  it('converges concurrent field edits and ordered turn additions across seeded duplicate deliveries', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    updateScenario(getProjectSharedTypes(left).scenarios, {
      id: 'source-review', authorId: 'researcher-left', timestamp: 30, editId: 'left-title', changes: { title: 'Independent source review' },
    })
    addScenarioTurn(getProjectSharedTypes(left).scenarios, {
      scenarioId: 'source-review', turnId: 'left-turn', role: 'user', content: 'Are the sources independent?',
      authorId: 'researcher-left', timestamp: 31, editId: 'create-left-turn',
    })
    updateScenario(getProjectSharedTypes(right).scenarios, {
      id: 'source-review', authorId: 'researcher-right', timestamp: 32, editId: 'right-background', changes: { background: 'A disputed claim needs verification.' },
    })
    addScenarioTurn(getProjectSharedTypes(right).scenarios, {
      scenarioId: 'source-review', turnId: 'right-turn', role: 'assistant', content: 'Check funding and shared datasets.',
      authorId: 'researcher-right', timestamp: 33, editId: 'create-right-turn',
    })

    let expectedFingerprint = ''
    let expectedTurnOrder: string[] = []
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...rightUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      const scenario = readScenario(getProjectSharedTypes(merged).scenarios, 'source-review')!
      expect(scenario.title).toBe('Independent source review')
      expect(scenario.background).toBe('A disputed claim needs verification.')
      expect(scenario.edits.map((edit) => edit.editId)).toEqual([
        'create-source-review', 'left-title', 'right-background',
      ])
      expectedTurnOrder = expectedTurnOrder.length ? expectedTurnOrder : scenario.turns.map((turn) => turn.id)
      expect(scenario.turns.map((turn) => turn.id)).toEqual(expectedTurnOrder)
      expect(new Set(expectedTurnOrder)).toEqual(new Set(['turn-question', 'turn-answer', 'left-turn', 'right-turn']))
      expectedFingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(expectedFingerprint)
    }
  })

  it('keeps top-level deletion authoritative over a concurrent nested turn revision', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    deleteScenario(getProjectSharedTypes(left).scenarios, 'source-review')
    updateScenarioTurn(getProjectSharedTypes(right).scenarios, {
      scenarioId: 'source-review', turnId: 'turn-answer', role: 'assistant', content: 'Late nested revision.',
      authorId: 'researcher-right', timestamp: 40, editId: 'late-turn-revision',
    })
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...leftUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      expect(readScenario(getProjectSharedTypes(merged).scenarios, 'source-review')).toBeNull()
    }
  })

  it('fails closed when disconnected peers reuse one public turn identity', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    addScenarioTurn(getProjectSharedTypes(left).scenarios, {
      scenarioId: 'source-review', turnId: 'colliding-turn', role: 'user', content: 'Left content.',
      authorId: 'researcher-left', timestamp: 50, editId: 'left-colliding-turn',
    })
    addScenarioTurn(getProjectSharedTypes(right).scenarios, {
      scenarioId: 'source-review', turnId: 'colliding-turn', role: 'assistant', content: 'Right content.',
      authorId: 'researcher-right', timestamp: 51, editId: 'right-colliding-turn',
    })
    const merged = replica(origin)
    applyProjectUpdate(merged, encodeProjectState(left))
    applyProjectUpdate(merged, encodeProjectState(right))
    const scenarios = getProjectSharedTypes(merged).scenarios
    expect(readScenario(scenarios, 'source-review')).toBeNull()
    expect(inspectScenarioGraph(scenarios)).toMatchObject({ healthy: false, invalidRecords: 1 })
  })

  it('fails closed when disconnected peers reuse one public scenario identity', () => {
    const origin = createProjectDocument(manifest)
    const left = replica(origin)
    const right = replica(origin)
    createScenario(getProjectSharedTypes(left).scenarios, {
      id: 'colliding-scenario', title: 'Left scenario', background: 'Left.',
      authorId: 'researcher-left', timestamp: 50, editId: 'left-scenario-create',
    })
    createScenario(getProjectSharedTypes(right).scenarios, {
      id: 'colliding-scenario', title: 'Right scenario', background: 'Right.',
      authorId: 'researcher-right', timestamp: 51, editId: 'right-scenario-create',
    })
    const merged = replica(origin)
    applyProjectUpdate(merged, encodeProjectState(left))
    applyProjectUpdate(merged, encodeProjectState(right))
    const scenarios = getProjectSharedTypes(merged).scenarios
    expect(readScenario(scenarios, 'colliding-scenario')).toBeNull()
    expect(inspectScenarioGraph(scenarios)).toMatchObject({ healthy: false, invalidRecords: 2, scenarioCount: 0 })
  })

  it('round-trips a valid branch graph through a Yjs export and reports missing parents', () => {
    const source = createProjectDocument(manifest)
    seedScenario(source)
    createScenario(getProjectSharedTypes(source).scenarios, {
      id: 'source-review-branch', title: 'Branch', background: '', parentScenarioId: 'source-review',
      authorId: 'researcher-2', timestamp: 20, editId: 'create-branch',
    })
    const restored = replica(source)
    expect(inspectScenarioGraph(getProjectSharedTypes(restored).scenarios)).toEqual(
      inspectScenarioGraph(getProjectSharedTypes(source).scenarios),
    )
    deleteScenario(getProjectSharedTypes(restored).scenarios, 'source-review')
    expect(inspectScenarioGraph(getProjectSharedTypes(restored).scenarios).issues).toContain(
      'Scenario source-review-branch has missing parent source-review',
    )
  })

  it('rejects unknown record fields and malformed turn order without throwing', () => {
    const doc = createProjectDocument(manifest)
    seedScenario(doc)
    const scenarios = getProjectSharedTypes(doc).scenarios
    const record = Array.from(scenarios.values()).find((value) => value instanceof Y.Map && value.get('id') === 'source-review') as Y.Map<unknown>
    record.set('ambientAuthority', true)
    expect(() => readScenario(scenarios, 'source-review')).not.toThrow()
    expect(readScenario(scenarios, 'source-review')).toBeNull()
    record.delete('ambientAuthority')
    ;(record.get('turnOrder') as Y.Array<string>).push(['missing-storage-key'])
    expect(readScenario(scenarios, 'source-review')).toBeNull()
  })
})
