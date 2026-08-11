import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LocalProjectProvider } from './localProvider'
import { createProjectArchive, decodeProjectArchive, persistDecodedProjectArchive } from './projectArchive'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { createProjectManifest } from './schema'
import {
  createScenario,
  deleteScenario,
  inspectScenarioGraph,
  listScenarios,
  readScenario,
  updateScenario,
} from './scenarioModel'

function branchedProject(suffix: string) {
  const manifest = {
    ...createProjectManifest({
      id: `scenario-archive-${suffix}`,
      documentId: `scenario-archive-document-${suffix}`,
      title: 'Branched scenario archive',
      timestamp: 1,
    }),
    transport: { kind: 'drive' as const, workspaceId: 'source-workspace' },
  }
  const doc = createProjectDocument(manifest)
  const { scenarios } = getProjectSharedTypes(doc)
  createScenario(scenarios, {
    id: 'root-case',
    title: 'Root case',
    background: 'Common policy question.',
    authorId: 'researcher-root',
    timestamp: 10,
    editId: 'create-root',
    turns: [{
      id: 'root-question', role: 'user', content: 'What is the governing rule?', editId: 'create-root-question',
    }],
  })
  createScenario(scenarios, {
    id: 'skeptical-branch',
    title: 'Skeptical branch',
    background: 'Challenge the evidence.',
    parentScenarioId: 'root-case',
    authorId: 'researcher-skeptic',
    timestamp: 11,
    editId: 'create-skeptical-branch',
    turns: [{
      id: 'skeptical-question', role: 'user', content: 'Is that source independent?', editId: 'create-skeptical-question',
    }],
  })
  createScenario(scenarios, {
    id: 'supporting-branch',
    title: 'Supporting branch',
    background: 'Request corroboration.',
    parentScenarioId: 'root-case',
    authorId: 'researcher-support',
    timestamp: 12,
    editId: 'create-supporting-branch',
  })
  createScenario(scenarios, {
    id: 'nested-branch',
    title: 'Nested challenge',
    background: 'Challenge the skeptical premise.',
    parentScenarioId: 'skeptical-branch',
    authorId: 'researcher-nested',
    timestamp: 13,
    editId: 'create-nested-branch',
  })
  updateScenario(scenarios, {
    id: 'skeptical-branch',
    authorId: 'researcher-reviewer',
    timestamp: 14,
    editId: 'mark-skeptical-ready',
    changes: { status: 'ready' },
  })
  return { manifest, doc }
}

function downgradeScenarioRecordsToV1(doc: Y.Doc) {
  const { scenarios } = getProjectSharedTypes(doc)
  doc.transact(() => {
    for (const scenario of scenarios.values()) {
      if (!(scenario instanceof Y.Map)) throw new Error('Expected scenario record')
      const turns = scenario.get('turns')
      if (!(turns instanceof Y.Map)) throw new Error('Expected scenario turns')
      for (const turn of turns.values()) {
        if (!(turn instanceof Y.Map)) throw new Error('Expected scenario turn')
        const revisions = turn.get('revisions')
        if (!(revisions instanceof Y.Map)) throw new Error('Expected scenario turn revisions')
        for (const [key, revision] of revisions.entries()) {
          if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
            throw new Error('Expected scenario turn revision')
          }
          const { parentEditIds: _parentEditIds, source: _source, ...legacyRevision } = revision as Record<string, unknown>
          revisions.set(key, legacyRevision)
        }
        turn.delete('headEditId')
      }
      scenario.set('schemaVersion', 1)
    }
  }, 'scenario-archive-v1-fixture')
}

describe('scenario branch graph portable archive', () => {
  it('survives export, local import persistence, and disconnected reopen with exact content and ancestry', async () => {
    const suffix = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { manifest, doc } = branchedProject(suffix)
    const sourceScenarios = listScenarios(getProjectSharedTypes(doc).scenarios)
    const sourceGraph = inspectScenarioGraph(getProjectSharedTypes(doc).scenarios)
    expect(sourceGraph).toEqual({
      healthy: true,
      scenarioCount: 4,
      invalidRecords: 0,
      roots: ['root-case'],
      edges: [
        { parentScenarioId: 'skeptical-branch', scenarioId: 'nested-branch' },
        { parentScenarioId: 'root-case', scenarioId: 'skeptical-branch' },
        { parentScenarioId: 'root-case', scenarioId: 'supporting-branch' },
      ],
      issues: [],
    })

    const decoded = await decodeProjectArchive(await createProjectArchive(manifest, doc, 20))
    expect(decoded.manifest.transport).toEqual({ kind: 'local' })
    expect(listScenarios(getProjectSharedTypes(decoded.doc).scenarios)).toEqual(sourceScenarios)
    expect(inspectScenarioGraph(getProjectSharedTypes(decoded.doc).scenarios)).toEqual(sourceGraph)
    await persistDecodedProjectArchive(decoded)

    const storageKey = `syzygy-project-v1:${manifest.id}`
    const reopenedDoc = new Y.Doc({ guid: manifest.documentId })
    const reopened = new LocalProjectProvider(reopenedDoc, storageKey, manifest.id)
    reopened.connect()
    await reopened.whenReady()
    try {
      expect(listScenarios(getProjectSharedTypes(reopenedDoc).scenarios)).toEqual(sourceScenarios)
      expect(inspectScenarioGraph(getProjectSharedTypes(reopenedDoc).scenarios)).toEqual(sourceGraph)
    } finally {
      await reopened.clearData()
      decoded.doc.destroy()
    }
  })

  it('does not launder a missing-parent integrity failure during archive import', async () => {
    const { manifest, doc } = branchedProject(`invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    deleteScenario(getProjectSharedTypes(doc).scenarios, 'root-case')
    const before = inspectScenarioGraph(getProjectSharedTypes(doc).scenarios)
    expect(before.healthy).toBe(false)
    expect(before.issues).toContain('Scenario skeptical-branch has missing parent root-case')
    expect(before.issues).toContain('Scenario supporting-branch has missing parent root-case')

    const decoded = await decodeProjectArchive(await createProjectArchive(manifest, doc, 20))
    expect(inspectScenarioGraph(getProjectSharedTypes(decoded.doc).scenarios)).toEqual(before)
    decoded.doc.destroy()
  })

  it('migrates a v1 branched archive exactly once when the imported project reopens', async () => {
    const suffix = `v1-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { manifest, doc } = branchedProject(suffix)
    downgradeScenarioRecordsToV1(doc)
    const sourceScenarios = getProjectSharedTypes(doc).scenarios
    expect(readScenario(sourceScenarios, 'root-case')).toBeNull()

    const decoded = await decodeProjectArchive(await createProjectArchive(manifest, doc, 20))
    const decodedScenarios = getProjectSharedTypes(decoded.doc).scenarios
    expect(readScenario(decodedScenarios, 'root-case')).toBeNull()
    await persistDecodedProjectArchive(decoded)

    const storageKey = `syzygy-project-v1:${manifest.id}`
    const reopenedDoc = new Y.Doc({ guid: manifest.documentId })
    const reopened = new LocalProjectProvider(reopenedDoc, storageKey, manifest.id)
    reopened.connect()
    await reopened.whenReady()
    try {
      const migrated = listScenarios(getProjectSharedTypes(reopenedDoc).scenarios)
      expect(migrated).toHaveLength(4)
      expect(migrated.every((scenario) => scenario.schemaVersion === 2)).toBe(true)
      expect(inspectScenarioGraph(getProjectSharedTypes(reopenedDoc).scenarios)).toMatchObject({
        healthy: true,
        scenarioCount: 4,
        invalidRecords: 0,
      })
      const rootQuestion = readScenario(getProjectSharedTypes(reopenedDoc).scenarios, 'root-case')?.turns[0]
      expect(rootQuestion).toMatchObject({
        headEditId: 'create-root-question',
        tipEditIds: ['create-root-question'],
      })
      expect(rootQuestion?.revisions).toEqual([
        expect.objectContaining({
          editId: 'create-root-question',
          parentEditIds: [],
          source: 'migration-v1',
        }),
      ])
    } finally {
      await reopened.clearData()
      decoded.doc.destroy()
    }
  })
})
