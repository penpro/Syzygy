import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LocalProjectProvider } from './localProvider'
import {
  assertProjectArchiveImportAvailable,
  createProjectArchive,
  decodeProjectArchive,
  persistDecodedProjectArchive,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_MAX_FILE_BYTES,
  PROJECT_ARCHIVE_SCHEMA_VERSION,
} from './projectArchive'
import {
  createProjectDocument,
  getProjectSharedTypes,
  projectStateFingerprint,
} from './projectModel'
import { createPolicyVersion } from './policyVersionModel'
import { initializePolicyContent, readPolicyContent, readPolicyContentStatus } from './policyContentModel'
import { createProjectManifest, type ResearchProjectManifest } from './schema'
import { createScenario, readScenario } from './scenarioModel'

function manifest(suffix: string): ResearchProjectManifest {
  return {
    ...createProjectManifest({
      id: `portable-project-${suffix}`,
      documentId: `portable-document-${suffix}`,
      title: 'Portable policy research',
      timestamp: 10,
    }),
    archivedAt: 30,
    updatedAt: 30,
    transport: { kind: 'drive', workspaceId: 'source-drive-workspace' },
  }
}

async function fixture(suffix: string) {
  const project = manifest(suffix)
  const doc = createProjectDocument(project)
  const shared = getProjectSharedTypes(doc)
  createScenario(shared.scenarios, {
    id: 'scenario-1', title: 'Collaborator scenario', background: '', status: 'ready',
    authorId: 'researcher-1', timestamp: 10, editId: 'scenario-1-create',
  })
  shared.heuristics.set('heuristic-1', { title: 'Cite evidence', priority: 'required' })
  shared.discussions.set('discussion-1', { note: 'Review the counterexample.' })
  shared.settings.set('evaluationMode', 'adversarial')
  shared.editorRoot.insert(0, 'lexical-yjs-root-fixture')
  initializePolicyContent(doc, 'rule-1', [{ insert: 'Require cited ', attributes: { format: 1 } }, { insert: 'evidence.' }], {
    status: 'review',
  })
  await createPolicyVersion(shared.versions, {
    projectId: project.id,
    blocks: [
      { kind: 'heading1', text: 'Access policy' },
      { kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Require cited evidence.' },
    ],
    scenarioIds: ['scenario-1'],
    participantId: 'researcher-1',
    displayName: 'Ada',
    createdAt: 20,
    note: 'Portable checkpoint',
  })
  return { project, doc }
}

describe('portable project archive', () => {
  it('round-trips every shared collection with stable identity and a local import binding', async () => {
    const { project, doc } = await fixture('round-trip')
    const archive = await createProjectArchive(project, doc, 40)
    const repeated = await createProjectArchive(project, doc, 40)
    expect(repeated).toBe(archive)

    const decoded = await decodeProjectArchive(archive)
    expect(decoded.sourceManifest).toEqual(project)
    expect(decoded.manifest).toEqual({
      ...project,
      archivedAt: undefined,
      transport: { kind: 'local' },
    })
    expect(Object.prototype.hasOwnProperty.call(decoded.manifest, 'archivedAt')).toBe(false)
    expect(decoded.doc.guid).toBe(project.documentId)
    expect(projectStateFingerprint(decoded.doc)).toBe(projectStateFingerprint(doc))
    const restored = getProjectSharedTypes(decoded.doc)
    expect(readScenario(restored.scenarios, 'scenario-1')).toMatchObject({
      title: 'Collaborator scenario', status: 'ready',
    })
    expect(restored.heuristics.get('heuristic-1')).toEqual({ title: 'Cite evidence', priority: 'required' })
    expect(restored.discussions.get('discussion-1')).toEqual({ note: 'Review the counterexample.' })
    expect(restored.settings.get('evaluationMode')).toBe('adversarial')
    expect(restored.editorRoot.toString()).toContain('lexical-yjs-root-fixture')
    expect(restored.policyContents.get('rule-1')).toBe(1)
    expect(readPolicyContent(decoded.doc, 'rule-1')).toEqual([
      { insert: 'Require cited ', attributes: { format: 1 } },
      { insert: 'evidence.' },
    ])
    expect(readPolicyContentStatus(decoded.doc, 'rule-1')).toBe('review')
    expect(restored.versions.size).toBe(1)
  })

  it('strips a self-hosted bearer invitation from an independent offline archive', async () => {
    const { project, doc } = await fixture('self-hosted-redaction')
    const websocketProject: ResearchProjectManifest = {
      ...project,
      transport: {
        kind: 'websocket',
        endpoint: 'ws://192.168.1.20:1234',
        roomId: 'room_' + 's'.repeat(40),
      },
    }
    const archive = await createProjectArchive(websocketProject, doc, 40)
    const decoded = await decodeProjectArchive(archive)
    expect(decoded.sourceManifest.transport).toEqual({ kind: 'local' })
    expect(decoded.manifest.transport).toEqual({ kind: 'local' })
    expect(archive).not.toContain('192.168.1.20')
    expect(archive).not.toContain('room_')
  })

  it('rejects envelope corruption, future schemas, unknown fields, and identity mismatch', async () => {
    const { project, doc } = await fixture('corruption')
    const archive = await createProjectArchive(project, doc, 40)
    const corrupted = JSON.parse(archive)
    corrupted.manifest.title = 'Tampered after export'
    await expect(decodeProjectArchive(JSON.stringify(corrupted))).rejects.toThrow('envelope checksum')

    const future = JSON.parse(archive)
    future.schemaVersion = PROJECT_ARCHIVE_SCHEMA_VERSION + 1
    await expect(decodeProjectArchive(JSON.stringify(future))).rejects.toThrow('unsupported')

    const unknown = JSON.parse(archive)
    unknown.credentials = { token: 'must never be accepted' }
    await expect(decodeProjectArchive(JSON.stringify(unknown))).rejects.toThrow('unsupported shape')

    const unknownManifest = JSON.parse(archive)
    unknownManifest.manifest.credentials = { token: 'must never be accepted' }
    await expect(decodeProjectArchive(JSON.stringify(unknownManifest))).rejects.toThrow('unsupported fields')

    await expect(decodeProjectArchive(' '.repeat(PROJECT_ARCHIVE_MAX_FILE_BYTES + 1)))
      .rejects.toThrow('size limit')

    const wrongDoc = createProjectDocument(project)
    getProjectSharedTypes(wrongDoc).metadata.set('projectId', 'another-project')
    await expect(createProjectArchive(project, wrongDoc, 40)).rejects.toThrow('metadata does not match')
    expect(JSON.parse(archive)).toMatchObject({
      format: PROJECT_ARCHIVE_FORMAT,
      schemaVersion: PROJECT_ARCHIVE_SCHEMA_VERSION,
    })
    expect(archive).not.toContain('credentials')
    expect(archive).not.toContain('model-provider')
  })

  it('rejects same-install project or document identity collisions without forking', async () => {
    const project = manifest('collision')
    expect(() => assertProjectArchiveImportAvailable(project, [project])).toThrow('already exists')
    expect(() => assertProjectArchiveImportAvailable(project, [{
      ...project,
      id: 'different-project',
    }])).toThrow('already exists')
    expect(() => assertProjectArchiveImportAvailable(project, [])).not.toThrow()
  })

  it('persists an imported archive and reopens it from IndexedDB without a network provider', async () => {
    const suffix = `indexeddb-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { project, doc } = await fixture(suffix)
    const decoded = await decodeProjectArchive(await createProjectArchive(project, doc, 40))
    await persistDecodedProjectArchive(decoded)

    const key = `syzygy-project-v1:${project.id}`
    const reopenedDoc = new Y.Doc({ guid: project.documentId })
    const reopened = new LocalProjectProvider(reopenedDoc, key, project.id)
    reopened.connect()
    await reopened.whenReady()
    try {
      expect(projectStateFingerprint(reopenedDoc)).toBe(projectStateFingerprint(doc))
      expect(readScenario(getProjectSharedTypes(reopenedDoc).scenarios, 'scenario-1')).toMatchObject({
        title: 'Collaborator scenario', status: 'ready',
      })
      expect(getProjectSharedTypes(reopenedDoc).versions.size).toBe(1)
    } finally {
      await reopened.clearData()
      decoded.doc.destroy()
    }
  })

  it('refuses to merge an archive with different orphaned local state', async () => {
    const suffix = `orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { project, doc } = await fixture(suffix)
    const key = `syzygy-project-v1:${project.id}`
    const orphanDoc = new Y.Doc({ guid: project.documentId })
    const orphan = new LocalProjectProvider(orphanDoc, key, project.id)
    orphan.connect()
    await orphan.whenReady()
    getProjectSharedTypes(orphanDoc).scenarios.set('orphan-only', { title: 'Do not merge silently' })
    await orphan.flush()
    await orphan.destroy()

    const decoded = await decodeProjectArchive(await createProjectArchive(project, doc, 40))
    await expect(persistDecodedProjectArchive(decoded)).rejects.toThrow('different state')

    const cleanupDoc = new Y.Doc({ guid: project.documentId })
    const cleanup = new LocalProjectProvider(cleanupDoc, key, project.id)
    cleanup.connect()
    await expect(cleanup.whenReady()).rejects.toThrow('Scenario migration')
    await cleanup.clearData()
    decoded.doc.destroy()
  })
})
