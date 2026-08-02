import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'
import {
  addScenarioTurn,
  createScenario,
  listScenarios,
  readScenario,
  updateScenario,
  updateScenarioTurn,
} from './scenarioModel'
import {
  createScenarioPack,
  decodeScenarioPack,
  importScenarioPack,
  SCENARIO_PACK_FORMAT,
  selectScenarioClosure,
} from './scenarioPack'

const manifest = createProjectManifest({ id: 'pack-project', documentId: 'pack-document', timestamp: 1 })

function seedGraph() {
  const doc = createProjectDocument(manifest)
  const scenarios = getProjectSharedTypes(doc).scenarios
  createScenario(scenarios, {
    id: 'root-scenario', title: 'Root scenario', background: 'Original evidence.',
    authorId: 'researcher-a', timestamp: 10, editId: 'create-root',
    turns: [{ id: 'root-turn', role: 'user', content: 'What is known?', editId: 'create-root-turn' }],
  })
  updateScenarioTurn(scenarios, {
    scenarioId: 'root-scenario', turnId: 'root-turn', role: 'user', content: 'What is independently verified?',
    authorId: 'researcher-b', timestamp: 11, editId: 'revise-root-turn', expectedCurrentEditId: 'create-root-turn',
  })
  updateScenario(scenarios, {
    id: 'root-scenario', authorId: 'researcher-b', timestamp: 12,
    editId: 'ready-root', changes: { status: 'ready', background: 'Two independent sources.' },
  })
  createScenario(scenarios, {
    id: 'branch-scenario', title: 'Skeptical branch', background: 'Challenge independence.',
    parentScenarioId: 'root-scenario', authorId: 'researcher-c', timestamp: 13, editId: 'create-branch',
  })
  addScenarioTurn(scenarios, {
    scenarioId: 'branch-scenario', turnId: 'branch-turn', role: 'system', content: 'Audit funding links.',
    authorId: 'researcher-c', timestamp: 14, editId: 'create-branch-turn',
  })
  return doc
}

async function encodedPack(selectedScenarioIds?: string[]) {
  const doc = seedGraph()
  try {
    return await createScenarioPack({
      packId: 'pack-001', title: 'Source independence scenarios',
      description: 'Reusable scenario authoring history.', license: 'CC0-1.0',
      source: {
        projectId: manifest.id, documentId: manifest.documentId, projectTitle: 'Pack project',
        exportedBy: 'researcher-a', exportedByDisplayName: 'Researcher A', exportedAt: 100,
      },
      scenarios: listScenarios(getProjectSharedTypes(doc).scenarios), selectedScenarioIds,
    })
  } finally {
    doc.destroy()
  }
}

describe('portable scenario packs', () => {
  it('round-trips a branch graph with ordered turns and full edit attribution', async () => {
    const text = await encodedPack()
    const pack = await decodeScenarioPack(text)
    expect(pack).toMatchObject({ format: SCENARIO_PACK_FORMAT, schemaVersion: 1, license: 'CC0-1.0' })
    expect(pack.scenarios.map((scenario) => scenario.id)).toEqual(['branch-scenario', 'root-scenario'])

    const destination = createProjectDocument(createProjectManifest({
      id: 'different-project', documentId: 'different-document', timestamp: 2,
    }))
    const target = getProjectSharedTypes(destination).scenarios
    expect(importScenarioPack(target, pack)).toEqual({
      addedScenarioIds: ['branch-scenario', 'root-scenario'], existingScenarioIds: [],
    })
    expect(listScenarios(target)).toEqual(pack.scenarios)
    expect(readScenario(target, 'root-scenario')?.turns[0].revisions.map((revision) => revision.editId)).toEqual([
      'create-root-turn', 'revise-root-turn',
    ])
    expect(readScenario(target, 'root-scenario')?.edits.map((edit) => edit.authorId)).toEqual([
      'researcher-a', 'researcher-b',
    ])
  })

  it('automatically includes ancestors for a selected branch', async () => {
    const pack = await decodeScenarioPack(await encodedPack(['branch-scenario']))
    expect(pack.scenarios.map((scenario) => scenario.id)).toEqual(['branch-scenario', 'root-scenario'])
    const source = seedGraph()
    expect(selectScenarioClosure(listScenarios(getProjectSharedTypes(source).scenarios), ['root-scenario'])
      .map((scenario) => scenario.id)).toEqual(['root-scenario'])
  })

  it('is idempotent for exact duplicates', async () => {
    const pack = await decodeScenarioPack(await encodedPack())
    const destination = createProjectDocument(createProjectManifest({ id: 'idempotent', documentId: 'idem-doc', timestamp: 2 }))
    const target = getProjectSharedTypes(destination).scenarios
    importScenarioPack(target, pack)
    const fingerprint = projectStateFingerprint(destination)
    expect(importScenarioPack(target, pack)).toEqual({
      addedScenarioIds: [], existingScenarioIds: ['branch-scenario', 'root-scenario'],
    })
    expect(projectStateFingerprint(destination)).toBe(fingerprint)
  })

  it('aborts atomically on a same-ID/different-content collision', async () => {
    const pack = await decodeScenarioPack(await encodedPack())
    const destination = createProjectDocument(createProjectManifest({ id: 'collision', documentId: 'collision-doc', timestamp: 2 }))
    const target = getProjectSharedTypes(destination).scenarios
    createScenario(target, {
      id: 'branch-scenario', title: 'Conflicting local branch', background: '',
      authorId: 'local-researcher', timestamp: 1, editId: 'local-create',
    })
    const before = projectStateFingerprint(destination)
    expect(() => importScenarioPack(target, pack)).toThrow('Scenario ID collision: branch-scenario')
    expect(projectStateFingerprint(destination)).toBe(before)
    expect(readScenario(target, 'root-scenario')).toBeNull()
  })

  it('rejects tampering, unknown authority, future schemas, and malformed graphs', async () => {
    const text = await encodedPack()
    const tampered = JSON.parse(text)
    tampered.title = 'Tampered title'
    await expect(decodeScenarioPack(JSON.stringify(tampered))).rejects.toThrow('checksum does not match')

    const unknown = JSON.parse(text)
    unknown.networkAuthority = true
    await expect(decodeScenarioPack(JSON.stringify(unknown))).rejects.toThrow('unknown or missing fields')

    const future = JSON.parse(text)
    future.schemaVersion = 2
    await expect(decodeScenarioPack(JSON.stringify(future))).rejects.toThrow('Unsupported scenario pack')

    const missingParent = JSON.parse(text)
    missingParent.scenarios = missingParent.scenarios.filter((scenario: { id: string }) => scenario.id !== 'root-scenario')
    await expect(decodeScenarioPack(JSON.stringify(missingParent))).rejects.toThrow('missing parent')
  })
})
