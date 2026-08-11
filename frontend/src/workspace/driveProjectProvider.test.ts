import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProjectCollaborationProvider,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'
import {
  bytesToBase64,
  DriveProjectProvider,
  type DriveProjectRemote,
} from './driveProjectProvider'
import { getProjectSharedTypes } from './projectModel'
import { createScenario, readScenario, updateScenarioTurn } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'

class ImmediateLocalProvider implements ProjectCollaborationProvider {
  readonly awareness: Awareness
  constructor(readonly doc: Y.Doc) {
    this.awareness = new Awareness(doc)
  }
  connect(): void {}
  async whenReady(): Promise<void> {}
  disconnect(): void { this.awareness.setLocalState(null) }
  async destroy(): Promise<void> { this.awareness.destroy() }
  on(_type: ProjectProviderEvent, _callback: ProjectProviderListener): void {}
  off(_type: ProjectProviderEvent, _callback: ProjectProviderListener): void {}
}

class FakeDriveHub implements DriveProjectRemote {
  private updates: Array<{ id: string; updateBase64: string }> = []
  private nextId = 1

  async pull(_projectId: string, _documentId: string, knownUpdateIds: string[]) {
    const known = new Set(knownUpdateIds)
    return { updates: this.updates.filter((update) => !known.has(update.id)) }
  }

  async push(_projectId: string, _documentId: string, _clientId: string, updateBase64: string) {
    const existing = this.updates.find((update) => update.updateBase64 === updateBase64)
    if (existing) return { updateId: existing.id }
    const update = { id: `drive-update-${this.nextId++}`, updateBase64 }
    this.updates.push(update)
    return { updateId: update.id }
  }
}

const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'drive-project-test',
  documentId: 'drive-document-test',
  title: 'Drive convergence test',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'drive', workspaceId: 'workspace-test' },
}

const providers: DriveProjectProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()))
})

function provider(doc: Y.Doc, hub: DriveProjectRemote): DriveProjectProvider {
  const value = new DriveProjectProvider(doc, manifest, hub, new ImmediateLocalProvider(doc))
  providers.push(value)
  return value
}

describe('DriveProjectProvider', () => {
  it('converges two installations through immutable updates and reconnect merging', async () => {
    const hub = new FakeDriveHub()
    const docA = new Y.Doc({ guid: manifest.documentId })
    const docB = new Y.Doc({ guid: manifest.documentId })
    const providerA = provider(docA, hub)
    const providerB = provider(docB, hub)

    providerA.connect()
    await providerA.whenReady()
    docA.getMap('research').set('primary', 'alpha')
    await providerA.syncNow()

    providerB.connect()
    await providerB.whenReady()
    expect(docB.getMap('research').get('primary')).toBe('alpha')

    providerB.disconnect()
    docA.getMap('research').set('primary-offline', 'left')
    docB.getMap('research').set('secondary-offline', 'right')
    await providerA.syncNow()

    providerB.connect()
    await providerB.whenReady()
    await providerA.syncNow()

    expect(docA.getMap('research').toJSON()).toEqual({
      primary: 'alpha',
      'primary-offline': 'left',
      'secondary-offline': 'right',
    })
    expect(docB.getMap('research').toJSON()).toEqual(docA.getMap('research').toJSON())
    expect(Y.encodeStateVector(docB)).toEqual(Y.encodeStateVector(docA))
  })

  it('migrates a legacy scenario only after the initial remote pull and republishes v2 state', async () => {
    const hub = new FakeDriveHub()
    const legacy = new Y.Doc({ guid: manifest.documentId })
    const scenarios = getProjectSharedTypes(legacy).scenarios
    createScenario(scenarios, {
      id: 'drive-legacy', title: 'Drive legacy', background: '', authorId: 'author-a', timestamp: 1,
      editId: 'drive-legacy-create', turns: [{ id: 'drive-legacy-turn', role: 'user', content: 'First', editId: 'drive-first' }],
    })
    updateScenarioTurn(scenarios, {
      scenarioId: 'drive-legacy', turnId: 'drive-legacy-turn', role: 'assistant', content: 'Second',
      authorId: 'author-b', timestamp: 2, editId: 'drive-second', expectedCurrentEditId: 'drive-first',
    })
    const record = Array.from(scenarios.values())[0] as Y.Map<unknown>
    const turn = Array.from((record.get('turns') as Y.Map<unknown>).values())[0] as Y.Map<unknown>
    const revisions = turn.get('revisions') as Y.Map<Record<string, unknown>>
    for (const [storageKey, revision] of revisions.entries()) {
      const { parentEditIds: _parents, source: _source, ...legacyRevision } = revision
      revisions.set(storageKey, legacyRevision)
    }
    turn.delete('headEditId')
    record.set('schemaVersion', 1)
    await hub.push(manifest.id, manifest.documentId, 'legacy-seed', bytesToBase64(Y.encodeStateAsUpdate(legacy)))

    const firstDoc = new Y.Doc({ guid: manifest.documentId })
    const first = provider(firstDoc, hub)
    first.connect()
    await first.whenReady()
    expect(readScenario(getProjectSharedTypes(firstDoc).scenarios, 'drive-legacy')?.turns[0]).toMatchObject({
      headEditId: 'drive-second', tipEditIds: ['drive-second'], content: 'Second',
    })

    const secondDoc = new Y.Doc({ guid: manifest.documentId })
    const second = provider(secondDoc, hub)
    second.connect()
    await second.whenReady()
    expect(readScenario(getProjectSharedTypes(secondDoc).scenarios, 'drive-legacy'))
      .toEqual(readScenario(getProjectSharedTypes(firstDoc).scenarios, 'drive-legacy'))
  })

  it('fails readiness closed when Drive returns malformed update bytes', async () => {
    const remote: DriveProjectRemote = {
      async pull() {
        return { updates: [{ id: 'bad-update', updateBase64: 'not base64' }] }
      },
      async push() {
        throw new Error('push should not run')
      },
    }
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, remote)
    value.connect()
    await expect(value.whenReady()).rejects.toThrow(/invalid Yjs update encoding/)
  })
})
