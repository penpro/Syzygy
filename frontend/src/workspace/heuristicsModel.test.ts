import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import { createHeuristic, deleteHeuristic, listHeuristics, readHeuristic, updateHeuristic } from './heuristicsModel'

const manifest = createProjectManifest({ id: 'heuristic-project', documentId: 'heuristic-document', timestamp: 1 })
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}
const seedHeuristic = (doc: Y.Doc) => createHeuristic(getProjectSharedTypes(doc).heuristics, {
  id: 'evidence-quality', title: 'Evidence quality', guidance: 'Cite primary evidence.', priority: 'required',
  authorId: 'researcher-1', timestamp: 10, editId: 'create-evidence-quality',
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

describe('collaborative heuristics model', () => {
  it('merges concurrent field edits and retains both edit attributions across seeded update orders', () => {
    const origin = createProjectDocument(manifest)
    seedHeuristic(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    updateHeuristic(getProjectSharedTypes(left).heuristics, {
      id: 'evidence-quality', editId: 'left-title', authorId: 'researcher-left', timestamp: 20,
      changes: { title: 'Evidence strength' },
    })
    updateHeuristic(getProjectSharedTypes(right).heuristics, {
      id: 'evidence-quality', editId: 'right-guidance', authorId: 'researcher-right', timestamp: 21,
      changes: { guidance: 'Cite primary evidence and state uncertainty.' },
    })

    let expectedFingerprint = ''
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...leftUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      const heuristic = readHeuristic(getProjectSharedTypes(merged).heuristics, 'evidence-quality')!
      expect(heuristic.title).toBe('Evidence strength')
      expect(heuristic.guidance).toBe('Cite primary evidence and state uncertainty.')
      expect(heuristic.edits.map((edit) => edit.editId)).toEqual(['create-evidence-quality', 'left-title', 'right-guidance'])
      expectedFingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(expectedFingerprint)
    }
  })

  it('converges concurrent add and delete-versus-edit without resurrection', () => {
    const origin = createProjectDocument(manifest)
    seedHeuristic(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    deleteHeuristic(getProjectSharedTypes(left).heuristics, 'evidence-quality')
    createHeuristic(getProjectSharedTypes(left).heuristics, {
      id: 'plain-language', title: 'Plain language', guidance: 'Prefer direct wording.', priority: 'recommended',
      authorId: 'researcher-left', timestamp: 30, editId: 'create-plain-language',
    })
    updateHeuristic(getProjectSharedTypes(right).heuristics, {
      id: 'evidence-quality', editId: 'late-edit', authorId: 'researcher-right', timestamp: 31,
      changes: { enabled: false },
    })
    createHeuristic(getProjectSharedTypes(right).heuristics, {
      id: 'distributional-impact', title: 'Distributional impact', guidance: 'Name affected groups.', priority: 'watch',
      authorId: 'researcher-right', timestamp: 32, editId: 'create-distributional-impact',
    })

    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...rightUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      expect(readHeuristic(getProjectSharedTypes(merged).heuristics, 'evidence-quality')).toBeNull()
      expect(listHeuristics(getProjectSharedTypes(merged).heuristics).map((item) => item.id)).toEqual([
        'distributional-impact', 'plain-language',
      ])
    }
  })

  it('fails invalid and replay-conflicting edits without changing shared state', () => {
    const doc = createProjectDocument(manifest)
    const heuristics = getProjectSharedTypes(doc).heuristics
    expect(() => createHeuristic(heuristics, {
      id: '../escape', title: 'Invalid', guidance: 'Invalid.', priority: 'required', authorId: 'user', timestamp: 1, editId: 'bad',
    })).toThrow('Invalid heuristic ID')
    expect(heuristics.size).toBe(0)
    seedHeuristic(doc)
    updateHeuristic(heuristics, {
      id: 'evidence-quality', editId: 'same-edit', authorId: 'user', timestamp: 40, changes: { enabled: false },
    })
    expect(() => updateHeuristic(heuristics, {
      id: 'evidence-quality', editId: 'same-edit', authorId: 'user', timestamp: 40, changes: { enabled: true },
    })).toThrow('Heuristic edit ID was reused')
    expect(readHeuristic(heuristics, 'evidence-quality')?.enabled).toBe(false)
  })

  it('returns detached edit history that callers cannot use to mutate shared state', () => {
    const doc = createProjectDocument(manifest)
    seedHeuristic(doc)
    const heuristics = getProjectSharedTypes(doc).heuristics
    const detached = readHeuristic(heuristics, 'evidence-quality')!
    detached.edits[0].changes.title = 'Mutated plugin copy'
    detached.edits[0].fields.push('enabled')

    const reread = readHeuristic(heuristics, 'evidence-quality')!
    expect(reread.edits[0].changes.title).toBe('Evidence quality')
    expect(reread.edits[0].fields).toEqual(['title', 'guidance', 'priority', 'enabled'])
  })

  it('fails closed without throwing when a peer supplies malformed edit fields', () => {
    const doc = createProjectDocument(manifest)
    seedHeuristic(doc)
    const heuristics = getProjectSharedTypes(doc).heuristics
    const record = heuristics.get('evidence-quality') as Y.Map<unknown>
    const edits = record.get('edits') as Y.Map<unknown>
    edits.set('malicious:edit', {
      editId: 'malicious-edit', authorId: 'malicious-peer', timestamp: 60,
      fields: { enabled: true }, changes: { enabled: true },
    })

    expect(() => readHeuristic(heuristics, 'evidence-quality')).not.toThrow()
    expect(readHeuristic(heuristics, 'evidence-quality')).toBeNull()
  })

  it('fails closed after disconnected peers independently reuse one edit ID', () => {
    const origin = createProjectDocument(manifest)
    seedHeuristic(origin)
    const left = replica(origin)
    const right = replica(origin)
    updateHeuristic(getProjectSharedTypes(left).heuristics, {
      id: 'evidence-quality', editId: 'colliding-edit', authorId: 'researcher-left', timestamp: 50,
      changes: { title: 'Left title' },
    })
    updateHeuristic(getProjectSharedTypes(right).heuristics, {
      id: 'evidence-quality', editId: 'colliding-edit', authorId: 'researcher-right', timestamp: 51,
      changes: { guidance: 'Right guidance.' },
    })
    const merged = replica(origin)
    applyProjectUpdate(merged, encodeProjectState(left))
    applyProjectUpdate(merged, encodeProjectState(right))
    expect(readHeuristic(getProjectSharedTypes(merged).heuristics, 'evidence-quality')).toBeNull()
    expect(listHeuristics(getProjectSharedTypes(merged).heuristics)).toEqual([])
  })
})
