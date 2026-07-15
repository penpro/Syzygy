import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes } from './projectModel'
import { createScenario, deleteScenario } from './scenarioModel'
import {
  createScenarioLabel, inspectScenarioLabels, listScenarioIdsForLabel, readScenarioLabel,
  readScenarioLabelAssignment, renameScenarioLabel, setScenarioLabelAssignment,
} from './scenarioLabelModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'label-project', documentId: 'label-document', timestamp: 1 })
const shared = (doc: Y.Doc) => getProjectSharedTypes(doc)
const addScenario = (doc: Y.Doc, id: string) => createScenario(shared(doc).scenarios, {
  id, title: id, background: '', authorId: 'owner', timestamp: 2, editId: `create-${id}`,
})
const clone = (doc: Y.Doc) => {
  const copy = createProjectDocument(manifest)
  applyProjectUpdate(copy, encodeProjectState(doc))
  return copy
}
const merge = (base: Y.Doc, updates: Uint8Array[]) => {
  const merged = clone(base)
  updates.forEach((update) => applyProjectUpdate(merged, update))
  return merged
}
const permutations = (updates: Uint8Array[]) => Array.from({ length: 40 }, (_, seed) => {
  const ordered = seed % 2 ? [...updates].reverse() : [...updates]
  return seed % 3 ? ordered : [...ordered, ordered[0]]
})

describe('collaborative scenario labels', () => {
  it('creates, renames, assigns, removes, and filters labels with immutable history', () => {
    const doc = createProjectDocument(manifest)
    addScenario(doc, 'alpha')
    const label = createScenarioLabel(shared(doc).settings, {
      labelId: 'region-west', eventId: 'create-region-west', name: 'Western region', authorId: 'alice', timestamp: 3,
    })
    expect(createScenarioLabel(shared(doc).settings, {
      labelId: 'region-west', eventId: 'create-region-west', name: 'Western region', authorId: 'alice', timestamp: 3,
    }).events).toHaveLength(1)
    const renamed = renameScenarioLabel(shared(doc).settings, {
      labelId: label.id, eventId: 'rename-region-west', expectedCurrentEventId: label.currentEventId,
      name: 'Pacific region', authorId: 'bob', timestamp: 4,
    })
    const assigned = setScenarioLabelAssignment(shared(doc).settings, shared(doc).scenarios, {
      scenarioId: 'alpha', labelId: label.id, eventId: 'assign-alpha-west', expectedCurrentEventId: null,
      assigned: true, authorId: 'alice', timestamp: 5,
    })
    expect(setScenarioLabelAssignment(shared(doc).settings, shared(doc).scenarios, {
      scenarioId: 'alpha', labelId: label.id, eventId: 'assign-alpha-west', expectedCurrentEventId: null,
      assigned: true, authorId: 'alice', timestamp: 5,
    }).events).toHaveLength(1)
    expect(renamed).toMatchObject({ name: 'Pacific region', events: [{ action: 'create' }, { action: 'rename' }] })
    expect(listScenarioIdsForLabel(shared(doc).settings, label.id)).toEqual(['alpha'])
    const removed = setScenarioLabelAssignment(shared(doc).settings, shared(doc).scenarios, {
      scenarioId: 'alpha', labelId: label.id, eventId: 'remove-alpha-west',
      expectedCurrentEventId: assigned.currentEventId, assigned: false, authorId: 'bob', timestamp: 6,
    })
    expect(removed).toMatchObject({ assigned: false, events: [{ action: 'add' }, { action: 'remove' }] })
    expect(listScenarioIdsForLabel(shared(doc).settings, label.id)).toEqual([])
  })

  it('retains concurrent renames and selects one deterministic current name across deliveries', () => {
    const origin = createProjectDocument(manifest)
    const created = createScenarioLabel(shared(origin).settings, {
      labelId: 'evidence', eventId: 'create-evidence', name: 'Evidence', authorId: 'owner', timestamp: 2,
    })
    const left = clone(origin)
    const right = clone(origin)
    renameScenarioLabel(shared(left).settings, {
      labelId: 'evidence', eventId: 'rename-evidence-a', expectedCurrentEventId: created.currentEventId,
      name: 'Evidence required', authorId: 'alice', timestamp: 3,
    })
    renameScenarioLabel(shared(right).settings, {
      labelId: 'evidence', eventId: 'rename-evidence-z', expectedCurrentEventId: created.currentEventId,
      name: 'Evidence checked', authorId: 'bob', timestamp: 3,
    })
    const updates = [encodeProjectState(left), encodeProjectState(right)]
    for (const delivery of permutations(updates)) {
      const label = readScenarioLabel(shared(merge(origin, delivery)).settings, 'evidence')
      expect(label).toMatchObject({ name: 'Evidence checked', currentEventId: 'rename-evidence-z' })
      expect(label?.events.map((event) => event.eventId)).toEqual(['create-evidence', 'rename-evidence-a', 'rename-evidence-z'])
    }
  })

  it('converges disconnected assignments and filters every matching scenario', () => {
    const origin = createProjectDocument(manifest)
    addScenario(origin, 'alpha')
    addScenario(origin, 'beta')
    createScenarioLabel(shared(origin).settings, {
      labelId: 'priority', eventId: 'create-priority', name: 'Priority', authorId: 'owner', timestamp: 4,
    })
    const left = clone(origin)
    const right = clone(origin)
    setScenarioLabelAssignment(shared(left).settings, shared(left).scenarios, {
      scenarioId: 'alpha', labelId: 'priority', eventId: 'assign-alpha', expectedCurrentEventId: null,
      assigned: true, authorId: 'alice', timestamp: 5,
    })
    setScenarioLabelAssignment(shared(right).settings, shared(right).scenarios, {
      scenarioId: 'beta', labelId: 'priority', eventId: 'assign-beta', expectedCurrentEventId: null,
      assigned: true, authorId: 'bob', timestamp: 5,
    })
    for (const delivery of permutations([encodeProjectState(left), encodeProjectState(right)])) {
      expect(listScenarioIdsForLabel(shared(merge(origin, delivery)).settings, 'priority')).toEqual(['alpha', 'beta'])
    }
  })

  it('rejects stale rename and assignment events without changing history', () => {
    const doc = createProjectDocument(manifest)
    addScenario(doc, 'alpha')
    const label = createScenarioLabel(shared(doc).settings, {
      labelId: 'review', eventId: 'create-review', name: 'Review', authorId: 'owner', timestamp: 2,
    })
    const renamed = renameScenarioLabel(shared(doc).settings, {
      labelId: 'review', eventId: 'rename-review', expectedCurrentEventId: label.currentEventId,
      name: 'Needs review', authorId: 'alice', timestamp: 3,
    })
    expect(() => renameScenarioLabel(shared(doc).settings, {
      labelId: 'review', eventId: 'stale-rename', expectedCurrentEventId: label.currentEventId,
      name: 'Stale', authorId: 'bob', timestamp: 4,
    })).toThrow('Scenario label revision conflict')
    const assigned = setScenarioLabelAssignment(shared(doc).settings, shared(doc).scenarios, {
      scenarioId: 'alpha', labelId: 'review', eventId: 'assign-review', expectedCurrentEventId: null,
      assigned: true, authorId: 'alice', timestamp: 5,
    })
    expect(() => setScenarioLabelAssignment(shared(doc).settings, shared(doc).scenarios, {
      scenarioId: 'alpha', labelId: 'review', eventId: 'stale-remove', expectedCurrentEventId: null,
      assigned: false, authorId: 'bob', timestamp: 6,
    })).toThrow('Scenario label assignment revision conflict')
    expect(readScenarioLabel(shared(doc).settings, 'review')).toMatchObject({ currentEventId: renamed.currentEventId, events: [{}, {}] })
    expect(readScenarioLabelAssignment(shared(doc).settings, 'alpha', 'review')).toMatchObject({ currentEventId: assigned.currentEventId, events: [{}] })
  })

  it('fails closed on disconnected label identity collisions and reports orphan assignments', () => {
    const origin = createProjectDocument(manifest)
    addScenario(origin, 'alpha')
    const left = clone(origin)
    const right = clone(origin)
    createScenarioLabel(shared(left).settings, {
      labelId: 'collision', eventId: 'left-root', name: 'Left', authorId: 'alice', timestamp: 3,
    })
    createScenarioLabel(shared(right).settings, {
      labelId: 'collision', eventId: 'right-root', name: 'Right', authorId: 'bob', timestamp: 3,
    })
    expect(readScenarioLabel(shared(merge(origin, [encodeProjectState(left), encodeProjectState(right)])).settings, 'collision')).toBeNull()

    const target = createProjectDocument(manifest)
    addScenario(target, 'alpha')
    createScenarioLabel(shared(target).settings, {
      labelId: 'orphan-test', eventId: 'create-orphan-test', name: 'Orphan test', authorId: 'owner', timestamp: 3,
    })
    setScenarioLabelAssignment(shared(target).settings, shared(target).scenarios, {
      scenarioId: 'alpha', labelId: 'orphan-test', eventId: 'assign-orphan-test', expectedCurrentEventId: null,
      assigned: true, authorId: 'owner', timestamp: 4,
    })
    deleteScenario(shared(target).scenarios, 'alpha')
    expect(inspectScenarioLabels(shared(target).settings, shared(target).scenarios)).toMatchObject({
      healthy: false, labelCount: 1, assignmentCount: 1, orphanScenarioIds: ['alpha'],
    })
    shared(target).settings.set('scenario-labels:v1:malformed', 'invalid')
    expect(inspectScenarioLabels(shared(target).settings, shared(target).scenarios).invalidRecords).toBe(1)
  })
})
