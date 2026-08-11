import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ProjectCollaborationProvider,
  ProjectProviderEvent,
  ProjectProviderListener,
} from './collaborationProvider'
import {
  base64ToBytes,
  bytesToBase64,
  DriveProjectProvider,
  type DriveProjectRemote,
} from './driveProjectProvider'
import { getProjectSharedTypes } from './projectModel'
import { createScenario, readScenario, updateScenarioTurn } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'
import type { DriveProjectTitleState } from '../tauri'
import { currentDriveProjectTitleState } from './driveProjectTitleStatus'

class ImmediateLocalProvider implements ProjectCollaborationProvider {
  readonly awareness: Awareness
  readonly capabilities = {
    realtime: false,
    awareness: false,
    durableLocal: true,
    remotePersistence: false,
    attachments: false,
  }
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
  pendingConcurrentUpdateBase64: string | null = null
  failNextArchiveCount = 0
  compactCallCount = 0
  titleUpdateCallCount = 0
  private nextTitleId = 1
  private titleState: DriveProjectTitleState = {
    projectId: 'drive-project-test',
    documentId: 'drive-document-test',
    baseTitle: 'Drive convergence test',
    title: 'Drive convergence test',
    revisionGuards: ['base-fixture'],
    conflict: false,
    eventCount: 0,
    activeEventCount: 0,
    snapshotCount: 0,
    tips: [],
  }

  get activeUpdateCount() {
    return this.updates.length
  }

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

  async compact(
    projectId: string,
    documentId: string,
    clientId: string,
    snapshotUpdateBase64: string,
    includedUpdateIds: string[],
  ) {
    this.compactCallCount += 1
    const snapshot = await this.push(projectId, documentId, clientId, snapshotUpdateBase64)
    if (this.pendingConcurrentUpdateBase64) {
      await this.push(projectId, documentId, 'concurrent', this.pendingConcurrentUpdateBase64)
      this.pendingConcurrentUpdateBase64 = null
    }
    const included = new Set(includedUpdateIds)
    const candidates = this.updates.filter((update) =>
      update.id !== snapshot.updateId && included.has(update.id))
    const failedArchiveCount = Math.min(this.failNextArchiveCount, candidates.length)
    this.failNextArchiveCount = 0
    const archived = candidates.slice(failedArchiveCount)
    const archivedIds = new Set(archived.map(({ id }) => id))
    const retainedConcurrentUpdateCount = this.updates.filter((update) =>
      update.id !== snapshot.updateId && !included.has(update.id)).length
    const activeUpdateCountBefore = this.updates.length
    this.updates = this.updates.filter((update) => !archivedIds.has(update.id))
    return {
      snapshotUpdateId: snapshot.updateId,
      snapshotByteLength: base64ToBytes(snapshotUpdateBase64).byteLength,
      activeUpdateCountBefore,
      activeUpdateCountAfter: this.updates.length,
      archivedUpdateCount: archived.length,
      failedArchiveCount,
      remainingIncludedUpdateCount: failedArchiveCount,
      retainedConcurrentUpdateCount,
      complete: failedArchiveCount === 0,
    }
  }

  async readTitle(_projectId: string, _documentId: string) {
    return structuredClone(this.titleState)
  }

  async compactTitle(
    _projectId: string,
    _documentId: string,
    expectedRevisionGuards: string[],
  ) {
    if (JSON.stringify(expectedRevisionGuards) !== JSON.stringify(this.titleState.revisionGuards)) {
      throw new Error('Drive project title changed while retaining history')
    }
    const activeEventCountBefore = this.titleState.activeEventCount
    this.titleState = {
      ...this.titleState,
      activeEventCount: 0,
      snapshotCount: this.titleState.eventCount > 0 ? 1 : 0,
    }
    return {
      snapshotRevision: 'retained-title-revision',
      retainedEventCount: this.titleState.eventCount,
      activeEventCountBefore,
      activeEventCountAfter: 0,
      archivedRecordCount: activeEventCountBefore,
      failedArchiveCount: 0,
      remainingRecordCount: 0,
      complete: true,
      state: structuredClone(this.titleState),
    }
  }

  async updateTitle(
    _projectId: string,
    _documentId: string,
    title: string,
    expectedRevisionGuards: string[],
    participantId: string,
    displayName: string,
    timestamp: number,
  ) {
    this.titleUpdateCallCount += 1
    if (JSON.stringify(expectedRevisionGuards) !== JSON.stringify(this.titleState.revisionGuards)) {
      if (!this.titleState.conflict && this.titleState.title === title) return structuredClone(this.titleState)
      throw new Error('Drive project title changed or gained a concurrent sibling')
    }
    const revision = `title-${this.nextTitleId++}`
    this.titleState = {
      ...this.titleState,
      title,
      revisionGuards: [revision],
      conflict: false,
      eventCount: this.titleState.eventCount + 1,
      activeEventCount: this.titleState.activeEventCount + 1,
      tips: [{
        revision,
        parentRevisions: expectedRevisionGuards.filter((guard) => !guard.startsWith('base-')),
        title,
        participantId,
        displayName,
        timestamp,
      }],
    }
    return structuredClone(this.titleState)
  }

  setConcurrentTitleTips(leftTitle: string, rightTitle: string) {
    this.titleState = {
      ...this.titleState,
      title: leftTitle,
      revisionGuards: ['tip-left', 'tip-right'],
      conflict: true,
      eventCount: this.titleState.eventCount + 2,
      activeEventCount: this.titleState.activeEventCount + 2,
      tips: [
        { revision: 'tip-left', parentRevisions: [], title: leftTitle, participantId: 'alice', displayName: 'Alice', timestamp: 10 },
        { revision: 'tip-right', parentRevisions: [], title: rightTitle, participantId: 'bob', displayName: 'Bob', timestamp: 11 },
      ],
    }
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

  it('compacts snapshot-first, retains a concurrent update, and lets a clean installation converge', async () => {
    const hub = new FakeDriveHub()
    const docA = new Y.Doc({ guid: manifest.documentId })
    const first = provider(docA, hub)
    first.connect()
    await first.whenReady()
    docA.getMap('research').set('before-compaction', 'retained')
    await first.syncNow()

    const concurrent = new Y.Doc({ guid: manifest.documentId })
    Y.applyUpdate(concurrent, Y.encodeStateAsUpdate(docA))
    concurrent.getMap('research').set('concurrent-during-compaction', 'retained too')
    hub.pendingConcurrentUpdateBase64 = bytesToBase64(Y.encodeStateAsUpdate(concurrent))

    const compacted = await first.compactNow()
    expect(compacted).toMatchObject({
      complete: true,
      failedArchiveCount: 0,
      retainedConcurrentUpdateCount: 1,
    })
    expect(compacted.archivedUpdateCount).toBeGreaterThan(0)
    expect(docA.getMap('research').toJSON()).toEqual({
      'before-compaction': 'retained',
      'concurrent-during-compaction': 'retained too',
    })

    const cleanDoc = new Y.Doc({ guid: manifest.documentId })
    const clean = provider(cleanDoc, hub)
    clean.connect()
    await clean.whenReady()
    expect(cleanDoc.getMap('research').toJSON()).toEqual(docA.getMap('research').toJSON())
    expect(Y.encodeStateVector(cleanDoc)).toEqual(Y.encodeStateVector(docA))
  })

  it('reports partial archival without losing state and safely retries it', async () => {
    const hub = new FakeDriveHub()
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, hub)
    value.connect()
    await value.whenReady()
    doc.getMap('research').set('must-survive', 'yes')
    await value.syncNow()
    hub.failNextArchiveCount = 1

    const partial = await value.compactNow()
    expect(partial.complete).toBe(false)
    expect(partial.failedArchiveCount).toBe(1)
    expect(partial.remainingIncludedUpdateCount).toBe(1)
    const retried = await value.compactNow()
    expect(retried.complete).toBe(true)
    expect(doc.getMap('research').get('must-survive')).toBe('yes')
    expect(hub.activeUpdateCount).toBeGreaterThan(0)
  })

  it('runs an exact-state guard after its final pull and before uploading a snapshot', async () => {
    const hub = new FakeDriveHub()
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, hub)
    value.connect()
    await value.whenReady()
    const remote = new Y.Doc({ guid: manifest.documentId })
    remote.getMap('research').set('arrived-before-snapshot', true)
    await hub.push(manifest.id, manifest.documentId, 'peer', bytesToBase64(Y.encodeStateAsUpdate(remote)))

    await expect(value.compactNow(() => {
      expect(doc.getMap('research').get('arrived-before-snapshot')).toBe(true)
      throw new Error('document revision conflict')
    })).rejects.toThrow('document revision conflict')
    expect(hub.compactCallCount).toBe(0)
  })

  it('publishes shared-title state, exposes siblings, and reconciles the exact tip set', async () => {
    const hub = new FakeDriveHub()
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, hub)
    value.connect()
    await value.whenReady()
    expect(currentDriveProjectTitleState(manifest.id)).toMatchObject({
      title: 'Drive convergence test', conflict: false, revisionGuards: ['base-fixture'],
    })

    const renamed = await value.updateTitle('Shared title', ['base-fixture'], 'alice', 'Alice')
    expect(renamed).toMatchObject({ title: 'Shared title', conflict: false, eventCount: 1 })

    hub.setConcurrentTitleTips('Left sibling', 'Right sibling')
    await value.syncNow()
    const conflicted = currentDriveProjectTitleState(manifest.id)
    expect(conflicted).toMatchObject({
      conflict: true,
      revisionGuards: ['tip-left', 'tip-right'],
      tips: [{ title: 'Left sibling' }, { title: 'Right sibling' }],
    })

    const reconciled = await value.updateTitle(
      'Reconciled title',
      conflicted?.revisionGuards ?? [],
      'carol',
      'Carol',
    )
    expect(reconciled).toMatchObject({ title: 'Reconciled title', conflict: false })
    expect(reconciled.tips[0].parentRevisions).toEqual(['tip-left', 'tip-right'])

    const retained = await value.compactTitleNow(reconciled.revisionGuards)
    expect(retained).toMatchObject({
      retainedEventCount: 4,
      activeEventCountBefore: 4,
      activeEventCountAfter: 0,
      archivedRecordCount: 4,
      complete: true,
      state: { title: 'Reconciled title', snapshotCount: 1 },
    })
    expect(currentDriveProjectTitleState(manifest.id)).toMatchObject({
      title: 'Reconciled title', eventCount: 4, activeEventCount: 0, snapshotCount: 1,
    })
  })

  it('refreshes title siblings before rejecting a stale rename without hiding either tip', async () => {
    const hub = new FakeDriveHub()
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, hub)
    value.connect()
    await value.whenReady()
    hub.setConcurrentTitleTips('Peer A', 'Peer B')

    await expect(value.updateTitle('Stale overwrite', ['base-fixture'], 'alice', 'Alice'))
      .rejects.toThrow(/concurrent sibling/)
    expect(currentDriveProjectTitleState(manifest.id)).toMatchObject({
      conflict: true,
      revisionGuards: ['tip-left', 'tip-right'],
    })
  })

  it('fails readiness closed when Drive returns malformed update bytes', async () => {
    const remote: DriveProjectRemote = {
      async pull() {
        return { updates: [{ id: 'bad-update', updateBase64: 'not base64' }] }
      },
      async push() {
        throw new Error('push should not run')
      },
      async compact() {
        throw new Error('compact should not run')
      },
      async readTitle() {
        throw new Error('title read should not run')
      },
      async compactTitle() {
        throw new Error('title compact should not run')
      },
      async updateTitle() {
        throw new Error('title update should not run')
      },
    }
    const doc = new Y.Doc({ guid: manifest.documentId })
    const value = provider(doc, remote)
    value.connect()
    await expect(value.whenReady()).rejects.toThrow(/invalid Yjs update encoding/)
  })
})
