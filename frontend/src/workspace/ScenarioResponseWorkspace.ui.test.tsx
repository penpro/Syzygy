import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes } from './projectModel'
import { createScenario } from './scenarioModel'
import { readScenarioResponses, type ScenarioResponse, type ScenarioResponseRevision } from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'
import {
  createHumanScenarioResponse,
  editHumanScenarioResponse,
  ScenarioResponseWorkspaceContent,
  type ScenarioResponseWorkspaceContentProps,
} from './ScenarioResponseWorkspace'

const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-response-workspace',
  documentId: 'document-response-workspace',
  title: 'Response workspace',
  createdAt: 1,
  transport: { kind: 'local' },
  updatedAt: 1,
}

function seededDocument() {
  const doc = createProjectDocument(manifest)
  createScenario(getProjectSharedTypes(doc).scenarios, {
    id: 'scenario-response-ui',
    title: 'Shared response test',
    background: '',
    authorId: 'researcher-seed',
    timestamp: 1,
    editId: 'scenario-create',
  })
  return doc
}

function replica(source: Y.Doc) {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}

const identity = {
  authorId: 'researcher-1',
  authorDisplayName: 'Researcher One',
}

function createResponse(doc: Y.Doc) {
  return createHumanScenarioResponse(doc, {
    scenarioId: 'scenario-response-ui',
    responseId: 'response-1',
    revisionId: 'revision-root',
    content: 'Initial human response.',
    timestamp: 10,
    ...identity,
  })
}

function contentProps(overrides: Partial<ScenarioResponseWorkspaceContentProps> = {}): ScenarioResponseWorkspaceContentProps {
  return {
    responses: [],
    totalResponses: 0,
    page: 0,
    pageCount: 1,
    editSession: null,
    draft: '',
    conflict: false,
    writesDisabled: false,
    generationBusy: false,
    integrityIssues: [],
    error: '',
    onOpenCreate: vi.fn(),
    onOpenEdit: vi.fn(),
    onDraft: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    onCancel: vi.fn(),
    onRegenerate: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    ...overrides,
  }
}

describe('editable scenario response product workflow', () => {
  it('creates and edits a shared response with exact human attribution and retained lineage', () => {
    const doc = seededDocument()
    const created = createResponse(doc)
    expect(created).toMatchObject({
      currentRevisionId: 'revision-root',
      content: 'Initial human response.',
      createdBy: 'researcher-1',
      createdByDisplayName: 'Researcher One',
    })

    const edited = editHumanScenarioResponse(doc, {
      scenarioId: 'scenario-response-ui',
      responseId: 'response-1',
      revisionId: 'revision-edit',
      expectedCurrentRevisionId: 'revision-root',
      content: 'Researcher-edited response.',
      authorId: 'researcher-2',
      authorDisplayName: 'Researcher Two',
      timestamp: 20,
    })
    expect(edited).toMatchObject({
      currentRevisionId: 'revision-edit',
      content: 'Researcher-edited response.',
    })
    expect(edited.revisions).toEqual([
      expect.objectContaining({
        revisionId: 'revision-root',
        parentRevisionId: null,
        sourceKind: 'human',
        authorDisplayName: 'Researcher One',
        providerId: null,
        modelId: null,
        runId: null,
      }),
      expect.objectContaining({
        revisionId: 'revision-edit',
        parentRevisionId: 'revision-root',
        sourceKind: 'human',
        authorDisplayName: 'Researcher Two',
      }),
    ])
  })

  it('rejects a stale product save before mutating the shared document', () => {
    const doc = seededDocument()
    createResponse(doc)
    editHumanScenarioResponse(doc, {
      scenarioId: 'scenario-response-ui', responseId: 'response-1', revisionId: 'revision-current',
      expectedCurrentRevisionId: 'revision-root', content: 'Shared current response.', timestamp: 20, ...identity,
    })
    const before = Array.from(encodeProjectState(doc))
    expect(() => editHumanScenarioResponse(doc, {
      scenarioId: 'scenario-response-ui', responseId: 'response-1', revisionId: 'revision-stale',
      expectedCurrentRevisionId: 'revision-root', content: 'Stale overwrite.', timestamp: 30, ...identity,
    })).toThrow('revision conflict')
    expect(Array.from(encodeProjectState(doc))).toEqual(before)
    expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, 'scenario-response-ui')?.[0].content)
      .toBe('Shared current response.')
  })

  it('retains disconnected product edits as siblings and converges deterministically', () => {
    const base = seededDocument()
    createResponse(base)
    const left = replica(base)
    const right = replica(base)
    editHumanScenarioResponse(left, {
      scenarioId: 'scenario-response-ui', responseId: 'response-1', revisionId: 'revision-left',
      expectedCurrentRevisionId: 'revision-root', content: 'Left product edit.',
      authorId: 'researcher-left', authorDisplayName: 'Left Researcher', timestamp: 20,
    })
    editHumanScenarioResponse(right, {
      scenarioId: 'scenario-response-ui', responseId: 'response-1', revisionId: 'revision-right',
      expectedCurrentRevisionId: 'revision-root', content: 'Right product edit.',
      authorId: 'researcher-right', authorDisplayName: 'Right Researcher', timestamp: 20,
    })
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftResponse = readScenarioResponses(getProjectSharedTypes(left).discussions, 'scenario-response-ui')?.[0]
    const rightResponse = readScenarioResponses(getProjectSharedTypes(right).discussions, 'scenario-response-ui')?.[0]
    expect(leftResponse).toEqual(rightResponse)
    expect(leftResponse?.revisions.map(({ revisionId }) => revisionId)).toEqual([
      'revision-root', 'revision-left', 'revision-right',
    ])
    expect(leftResponse?.content).toBe('Right product edit.')
  })

  it('fails closed on hostile response history without adding a product write', () => {
    const doc = seededDocument()
    createResponse(doc)
    const bucket = Array.from(getProjectSharedTypes(doc).discussions.values())
      .find((value) => value instanceof Y.Map) as Y.Map<unknown>
    bucket.set('unexpected', true)
    const before = Array.from(encodeProjectState(doc))
    expect(() => createHumanScenarioResponse(doc, {
      scenarioId: 'scenario-response-ui', responseId: 'response-2', revisionId: 'revision-2',
      content: 'Must not be written.', timestamp: 30, ...identity,
    })).toThrow('history failed integrity checks')
    expect(Array.from(encodeProjectState(doc))).toEqual(before)
  })

  it('renders a no-AI authoring path and accessible empty state', () => {
    const html = renderToStaticMarkup(<ScenarioResponseWorkspaceContent {...contentProps()} />)
    expect(html).toContain('Shared scenario responses')
    expect(html).toContain('Write response')
    expect(html).toContain('Write one without AI')
    expect(html).toContain('nothing changes the policy draft')
  })

  it('keeps a stale draft visible, blocks save, and offers explicit recovery', () => {
    const html = renderToStaticMarkup(<ScenarioResponseWorkspaceContent {...contentProps({
      editSession: { mode: 'edit', responseId: 'response-1', expectedCurrentRevisionId: 'revision-old' },
      draft: 'My unsaved draft.',
      conflict: true,
    })} />)
    expect(html).toContain('Edit scenario response')
    expect(html).toContain('My unsaved draft.')
    expect(html).toContain('changed while you were editing')
    expect(html).toContain('Reload shared')
    expect(html).toContain('Identity is not authenticated')
    expect(html).toMatch(/type="submit" disabled=""/)
  })

  it('bounds visible lineage and exposes response pagination', () => {
    const revisions: ScenarioResponseRevision[] = Array.from({ length: 51 }, (_, index) => ({
      schemaVersion: 1,
      revisionId: `revision-${index}`,
      responseId: 'response-many',
      scenarioId: 'scenario-response-ui',
      parentRevisionId: index === 0 ? null : `revision-${index - 1}`,
      content: `Revision content ${index}`,
      authorId: 'researcher-1',
      authorDisplayName: 'Researcher One',
      timestamp: index,
      sourceKind: 'human',
      providerId: null,
      modelId: null,
      runId: null,
    }))
    const response: ScenarioResponse = {
      id: 'response-many', scenarioId: 'scenario-response-ui', createdBy: 'researcher-1',
      createdByDisplayName: 'Researcher One', createdAt: 0, currentRevisionId: 'revision-50',
      content: 'Revision content 50', revisions,
    }
    const html = renderToStaticMarkup(<ScenarioResponseWorkspaceContent {...contentProps({
      responses: [response], totalResponses: 101, page: 1, pageCount: 3,
    })} />)
    expect(html).toContain('51 retained')
    expect(html).toContain('Showing the 50 most recent revisions')
    expect(html).not.toContain('Revision content 0')
    expect(html).toContain('Revision content 50')
    expect(html).toContain('Page 2 of 3')
    expect(html).toContain('aria-label="Response pages"')
  })
})
