import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  mergePersisted,
  migrateLocalPolicyContentDocument,
  migratePersistedVersion,
  migrateScenarioDocument,
  PERSISTED_STORE_VERSION,
} from './migrations'
import { defaultSettings } from './seed'
import { createProjectManifest } from './workspace/schema'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './workspace/projectModel'
import { readPolicyContent, readPolicyContentStatus } from './workspace/policyContentModel'
import { createScenario, readScenario, updateScenarioTurn } from './workspace/scenarioModel'

const current = {
  settings: defaultSettings,
  experts: [],
  asks: [],
  projects: [],
  activeProjectId: null,
  untouchedRuntimeValue: 'current',
}

describe('persisted-store migrations', () => {
  it('rewrites older saves for the current transport-capable store and rejects future versions', () => {
    const saved = { settings: defaultSettings }
    expect(PERSISTED_STORE_VERSION).toBe(4)
    expect(migratePersistedVersion(saved, 2)).toBe(saved)
    expect(migratePersistedVersion(null, 2)).toEqual({})
    expect(() => migratePersistedVersion(saved, 5)).toThrow('unsupported persisted store version')
  })

  it('defaults legacy saves to local AI on but preserves an explicit opt-out', () => {
    const legacySettings = { ...defaultSettings } as Partial<typeof defaultSettings>
    delete legacySettings.localAiEnabled
    const legacy = mergePersisted({ settings: legacySettings, experts: [], asks: [] }, current)
    const optedOut = mergePersisted({ settings: { ...defaultSettings, localAiEnabled: false }, experts: [], asks: [] }, current)
    expect(legacy.settings.localAiEnabled).toBe(true)
    expect(optedOut.settings.localAiEnabled).toBe(false)
  })

  it('backfills a stable research identity and preserves an existing collaborator identity', () => {
    const legacySettings = { ...defaultSettings } as Partial<typeof defaultSettings>
    delete legacySettings.researcherId
    delete legacySettings.researcherName
    const migrated = mergePersisted({ settings: legacySettings, experts: [], asks: [] }, current)
    expect(migrated.settings.researcherId).toBe(defaultSettings.researcherId)
    expect(migrated.settings.researcherName).toBe('Local researcher')
    const preserved = mergePersisted({ settings: { ...defaultSettings, researcherName: 'Ada' }, experts: [], asks: [] }, current)
    expect(preserved.settings.researcherId).toBe(defaultSettings.researcherId)
    expect(preserved.settings.researcherName).toBe('Ada')
  })

  it('backfills project collections into a pre-workspace save idempotently', () => {
    const legacy = { settings: defaultSettings, experts: [], asks: [] }
    const once = mergePersisted(legacy, current)
    const twice = mergePersisted(once, current)
    expect(once.projects).toEqual([])
    expect(once.activeProjectId).toBeNull()
    expect(twice.projects).toEqual(once.projects)
    expect(twice.activeProjectId).toBe(once.activeProjectId)
  })

  it('preserves a canonical self-hosted binding through the v4 merge idempotently', () => {
    const project = {
      ...createProjectManifest({ id: 'self-hosted', documentId: 'self-hosted-doc', timestamp: 1 }),
      transport: {
        kind: 'websocket' as const,
        endpoint: 'ws://192.168.1.20:1234',
        roomId: 'room_' + 'a'.repeat(40),
      },
    }
    const once = mergePersisted({
      settings: defaultSettings, experts: [], asks: [], projects: [project], activeProjectId: project.id,
    }, current)
    const twice = mergePersisted(once, current)
    expect(once.projects).toEqual([project])
    expect(once.activeProjectId).toBe(project.id)
    expect(twice.projects).toEqual(once.projects)
  })

  it('migrates local policy content atomically and idempotently before sharing', () => {
    const manifest = createProjectManifest({ id: 'policy-migration', documentId: 'policy-migration-doc', timestamp: 1 })
    const doc = createProjectDocument(manifest)
    const seeds = [
      { policyId: 'policy-a', status: 'review' as const, delta: [{ insert: 'Alpha' }] },
      { policyId: 'policy-b', status: 'draft' as const, delta: [{ insert: 'Beta', attributes: { format: 1 } }] },
    ]
    expect(migrateLocalPolicyContentDocument(doc, seeds)).toEqual({ schemaVersion: 1, initialized: 2, existing: 0 })
    expect(migrateLocalPolicyContentDocument(doc, seeds)).toEqual({ schemaVersion: 1, initialized: 0, existing: 2 })
    expect(readPolicyContent(doc, 'policy-b')).toEqual(seeds[1].delta)
    expect(readPolicyContentStatus(doc, 'policy-a')).toBe('review')
    expect(getProjectSharedTypes(doc).metadata.get('policyContentSchemaVersion')).toBe(1)
  })

  it('rejects a conflicting policy-content migration before writing any pending seed', () => {
    const manifest = createProjectManifest({ id: 'policy-conflict', documentId: 'policy-conflict-doc', timestamp: 1 })
    const doc = createProjectDocument(manifest)
    migrateLocalPolicyContentDocument(doc, [{ policyId: 'policy-a', status: 'draft', delta: [{ insert: 'Original' }] }])
    expect(() => migrateLocalPolicyContentDocument(doc, [
      { policyId: 'policy-b', status: 'draft', delta: [{ insert: 'Must not be written' }] },
      { policyId: 'policy-a', status: 'draft', delta: [{ insert: 'Conflict' }] },
    ])).toThrow('conflicts')
    expect(readPolicyContent(doc, 'policy-b')).toBeNull()
    expect(getProjectSharedTypes(doc).policyContents.has('policy-b')).toBe(false)

    const future = new Y.Doc({ guid: 'future-policy-document' })
    getProjectSharedTypes(future).metadata.set('policyContentSchemaVersion', 99)
    expect(() => migrateLocalPolicyContentDocument(future, [])).toThrow('unsupported')
  })

  it('upgrades legacy scenario heads and parents atomically and idempotently', () => {
    const manifest = createProjectManifest({ id: 'scenario-migration', documentId: 'scenario-migration-doc', timestamp: 1 })
    const doc = createProjectDocument(manifest)
    const scenarios = getProjectSharedTypes(doc).scenarios
    createScenario(scenarios, {
      id: 'legacy-scenario', title: 'Legacy', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'create-legacy', turns: [{ id: 'legacy-turn', role: 'user', content: 'First', editId: 'legacy-first' }],
    })
    updateScenarioTurn(scenarios, {
      scenarioId: 'legacy-scenario', turnId: 'legacy-turn', role: 'user', content: 'Second',
      authorId: 'author-b', timestamp: 2, editId: 'legacy-second', expectedCurrentEditId: 'legacy-first',
    })
    const record = Array.from(scenarios.values())[0] as Y.Map<unknown>
    const turn = Array.from((record.get('turns') as Y.Map<unknown>).values())[0] as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<Record<string, unknown>>
    for (const [key, revision] of revisions.entries()) {
      const { parentEditIds: _parents, source: _source, ...legacy } = revision
      revisions.set(key, legacy)
    }
    turn.delete('headEditId')
    record.set('schemaVersion', 1)
    expect(readScenario(scenarios, 'legacy-scenario')).toBeNull()

    expect(migrateScenarioDocument(doc)).toEqual({
      schemaVersion: 2, upgradedScenarioIds: ['legacy-scenario'], existingScenarioIds: [],
    })
    expect(migrateScenarioDocument(doc)).toEqual({
      schemaVersion: 2, upgradedScenarioIds: [], existingScenarioIds: ['legacy-scenario'],
    })
    const migrated = readScenario(scenarios, 'legacy-scenario')!.turns[0]
    expect(migrated).toMatchObject({ headEditId: 'legacy-second', tipEditIds: ['legacy-second'], content: 'Second' })
    expect(migrated.revisions).toMatchObject([
      { editId: 'legacy-first', parentEditIds: [], source: 'migration-v1' },
      { editId: 'legacy-second', parentEditIds: ['legacy-first'], source: 'migration-v1' },
    ])
  })

  it('rejects hostile legacy scenario data before the first migration write', () => {
    const manifest = createProjectManifest({ id: 'scenario-migration-hostile', documentId: 'scenario-migration-hostile-doc', timestamp: 1 })
    const doc = createProjectDocument(manifest)
    const scenarios = getProjectSharedTypes(doc).scenarios
    createScenario(scenarios, {
      id: 'hostile-scenario', title: 'Hostile', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'create-hostile', turns: [{ id: 'hostile-turn', role: 'user', content: 'Body', editId: 'hostile-first' }],
    })
    const record = Array.from(scenarios.values())[0] as Y.Map<unknown>
    const turn = Array.from((record.get('turns') as Y.Map<unknown>).values())[0] as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<Record<string, unknown>>
    for (const [key, revision] of revisions.entries()) {
      const { parentEditIds: _parents, source: _source, ...legacy } = revision
      revisions.set(key, legacy)
    }
    turn.delete('headEditId')
    turn.set('ambientAuthority', { network: true })
    record.set('schemaVersion', 1)
    const before = Array.from(Y.encodeStateAsUpdate(doc))
    expect(() => migrateScenarioDocument(doc)).toThrow('cannot be migrated safely')
    expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(before)
    expect(record.get('schemaVersion')).toBe(1)

    const future = createProjectDocument(createProjectManifest({
      id: 'scenario-migration-future', documentId: 'scenario-migration-future-doc', timestamp: 1,
    }))
    const futureScenarios = getProjectSharedTypes(future).scenarios
    createScenario(futureScenarios, {
      id: 'future-scenario', title: 'Future', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'create-future',
    })
    const futureRecord = Array.from(futureScenarios.values())[0] as Y.Map<unknown>
    futureRecord.set('schemaVersion', 99)
    const futureBefore = Array.from(Y.encodeStateAsUpdate(future))
    expect(() => migrateScenarioDocument(future)).toThrow('cannot be migrated safely')
    expect(Array.from(Y.encodeStateAsUpdate(future))).toEqual(futureBefore)
  })

  it('converges deterministic migrations performed by disconnected peers', () => {
    const manifest = createProjectManifest({ id: 'scenario-migration-peers', documentId: 'scenario-migration-peers-doc', timestamp: 1 })
    const source = createProjectDocument(manifest)
    const scenarios = getProjectSharedTypes(source).scenarios
    createScenario(scenarios, {
      id: 'peer-legacy', title: 'Peer legacy', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'create-peer-legacy', turns: [{ id: 'peer-turn', role: 'user', content: 'First', editId: 'peer-first' }],
    })
    updateScenarioTurn(scenarios, {
      scenarioId: 'peer-legacy', turnId: 'peer-turn', role: 'assistant', content: 'Second',
      authorId: 'author-b', timestamp: 2, editId: 'peer-second', expectedCurrentEditId: 'peer-first',
    })
    const record = Array.from(scenarios.values())[0] as Y.Map<unknown>
    const turn = Array.from((record.get('turns') as Y.Map<unknown>).values())[0] as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<Record<string, unknown>>
    for (const [key, revision] of revisions.entries()) {
      const { parentEditIds: _parents, source: _source, ...legacy } = revision
      revisions.set(key, legacy)
    }
    turn.delete('headEditId')
    record.set('schemaVersion', 1)
    const left = new Y.Doc({ guid: source.guid })
    const right = new Y.Doc({ guid: source.guid })
    Y.applyUpdate(left, Y.encodeStateAsUpdate(source))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(source))
    migrateScenarioDocument(left)
    migrateScenarioDocument(right)
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    expect(projectStateFingerprint(left)).toBe(projectStateFingerprint(right))
    expect(readScenario(getProjectSharedTypes(left).scenarios, 'peer-legacy'))
      .toEqual(readScenario(getProjectSharedTypes(right).scenarios, 'peer-legacy'))
  })

  it('drops malformed manifests and selects a valid surviving project', () => {
    const project = createProjectManifest({ id: 'p-1', documentId: 'd-1', timestamp: 1 })
    const merged = mergePersisted(
      {
        settings: defaultSettings,
        experts: [],
        asks: [],
        projects: [{ schemaVersion: 99 }, project],
        activeProjectId: 'missing',
      },
      current,
    )
    expect(merged.projects).toEqual([project])
    expect(merged.activeProjectId).toBe('p-1')
  })
})
