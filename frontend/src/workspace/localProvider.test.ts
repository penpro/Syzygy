import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { encodeProjectState, getProjectSharedTypes } from './projectModel'
import { LocalProjectProvider } from './localProvider'
import { createScenario, readScenario, updateScenarioTurn } from './scenarioModel'
import { automationProjectDocumentReady } from './workspaceAutomationRegistry'

const providers: LocalProjectProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.clearData().catch(() => undefined)))
})

describe('local project persistence provider', () => {
  it('reopens acknowledged project state from IndexedDB', async () => {
    const key = `syzygy-headless-${Date.now()}-${Math.random()}`
    const firstDoc = new Y.Doc({ guid: 'document-1' })
    const first = new LocalProjectProvider(firstDoc, key)
    providers.push(first)
    first.connect()
    expect(automationProjectDocumentReady('document-1')).toBe(false)
    await first.whenReady()
    expect(automationProjectDocumentReady('document-1')).toBe(true)
    const scenarios = getProjectSharedTypes(firstDoc).scenarios
    createScenario(scenarios, {
      id: 'persisted-scenario', title: 'Reopen me', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'persisted-create', turns: [{ id: 'persisted-turn', role: 'user', content: 'First', editId: 'persisted-first' }],
    })
    updateScenarioTurn(scenarios, {
      scenarioId: 'persisted-scenario', turnId: 'persisted-turn', role: 'assistant', content: 'Second',
      authorId: 'author-b', timestamp: 2, editId: 'persisted-second', expectedCurrentEditId: 'persisted-first',
    })
    const record = Array.from(scenarios.values())[0] as Y.Map<unknown>
    const turn = Array.from((record.get('turns') as Y.Map<unknown>).values())[0] as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<Record<string, unknown>>
    for (const [storageKey, revision] of revisions.entries()) {
      const { parentEditIds: _parents, source: _source, ...legacy } = revision
      revisions.set(storageKey, legacy)
    }
    turn.delete('headEditId')
    record.set('schemaVersion', 1)
    await first.flush()
    await first.destroy()
    expect(automationProjectDocumentReady('document-1')).toBe(false)
    providers.splice(providers.indexOf(first), 1)

    const reopenedDoc = new Y.Doc({ guid: 'document-1' })
    const reopened = new LocalProjectProvider(reopenedDoc, key)
    providers.push(reopened)
    reopened.connect()
    expect(automationProjectDocumentReady('document-1')).toBe(false)
    await reopened.whenReady()
    expect(automationProjectDocumentReady('document-1')).toBe(true)
    expect(readScenario(getProjectSharedTypes(reopenedDoc).scenarios, 'persisted-scenario')?.turns[0]).toMatchObject({
      headEditId: 'persisted-second', tipEditIds: ['persisted-second'], content: 'Second',
      revisions: [
        { editId: 'persisted-first', parentEditIds: [], source: 'migration-v1' },
        { editId: 'persisted-second', parentEditIds: ['persisted-first'], source: 'migration-v1' },
      ],
    })
  })

  it('rejects readiness and withholds automation when persisted scenario data cannot migrate', async () => {
    const key = `syzygy-hostile-${Date.now()}-${Math.random()}`
    const doc = new Y.Doc({ guid: 'document-hostile' })
    const scenario = new Y.Map<unknown>()
    scenario.set('schemaVersion', 1)
    scenario.set('id', 'hostile-scenario')
    scenario.set('unexpectedAuthority', { network: true })
    getProjectSharedTypes(doc).scenarios.set('hostile-record', scenario)
    const before = Array.from(encodeProjectState(doc))
    const provider = new LocalProjectProvider(doc, key)
    providers.push(provider)
    const statuses: unknown[] = []
    provider.on('status', (status) => statuses.push(status))

    provider.connect()
    await expect(provider.whenReady()).rejects.toThrow('cannot be migrated safely')
    expect(automationProjectDocumentReady('document-hostile')).toBe(false)
    expect(statuses).toContainEqual(expect.objectContaining({ status: 'error' }))
    expect(Array.from(encodeProjectState(doc))).toEqual(before)
    expect(scenario.get('schemaVersion')).toBe(1)
    expect(scenario.has('headEditId')).toBe(false)
  })
})
