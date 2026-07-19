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
})
