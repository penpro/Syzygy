import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes } from './projectModel'
import { createScenario } from './scenarioModel'
import {
  createScenarioResponse,
  editScenarioResponse,
  inspectScenarioResponses,
  readScenarioResponses,
} from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'

const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-responses',
  documentId: 'document-responses',
  title: 'Response research',
  createdAt: 1,
  transport: { kind: 'local' },
  updatedAt: 1,
}

function seededDocument() {
  const doc = createProjectDocument(manifest)
  createScenario(getProjectSharedTypes(doc).scenarios, {
    id: 'scenario-access',
    title: 'Access policy',
    background: '',
    authorId: 'researcher-1',
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

const modelInput = {
  responseId: 'response-1',
  scenarioId: 'scenario-access',
  revisionId: 'revision-model',
  content: 'Initial model response.',
  authorId: 'model-agent',
  authorDisplayName: 'Local evaluator',
  timestamp: 10,
  sourceKind: 'model' as const,
  providerId: 'provider-local',
  modelId: 'model-qwen',
  runId: 'run-1',
}

describe('collaborative scenario response revisions', () => {
  it('retains model provenance and every human edit attribution snapshot', () => {
    const doc = seededDocument()
    const { discussions, scenarios } = getProjectSharedTypes(doc)
    const created = createScenarioResponse(discussions, scenarios, modelInput)
    expect(created).toMatchObject({
      createdBy: 'model-agent',
      createdByDisplayName: 'Local evaluator',
      currentRevisionId: 'revision-model',
    })

    const edited = editScenarioResponse(discussions, scenarios, {
      ...modelInput,
      revisionId: 'revision-human',
      expectedCurrentRevisionId: 'revision-model',
      content: 'Researcher-corrected response.',
      authorId: 'researcher-1',
      authorDisplayName: 'Researcher Original Name',
      timestamp: 20,
      sourceKind: 'human',
      providerId: null,
      modelId: null,
      runId: null,
    })
    expect(edited.content).toBe('Researcher-corrected response.')
    expect(edited.revisions).toEqual([
      expect.objectContaining({
        revisionId: 'revision-model',
        authorDisplayName: 'Local evaluator',
        sourceKind: 'model',
        providerId: 'provider-local',
        modelId: 'model-qwen',
        runId: 'run-1',
      }),
      expect.objectContaining({
        revisionId: 'revision-human',
        parentRevisionId: 'revision-model',
        authorDisplayName: 'Researcher Original Name',
        sourceKind: 'human',
      }),
    ])
    expect(() => editScenarioResponse(discussions, scenarios, {
      ...modelInput,
      revisionId: 'revision-stale',
      expectedCurrentRevisionId: 'revision-model',
      timestamp: 30,
    })).toThrow('revision conflict')
  })

  it('replays exact writes idempotently and rejects reused revision identity', () => {
    const doc = seededDocument()
    const { discussions, scenarios } = getProjectSharedTypes(doc)
    const first = createScenarioResponse(discussions, scenarios, modelInput)
    expect(createScenarioResponse(discussions, scenarios, modelInput)).toEqual(first)
    expect(() => createScenarioResponse(discussions, scenarios, {
      ...modelInput,
      content: 'Conflicting replay.',
    })).toThrow('revision ID was reused')
  })

  it('retains concurrent sibling edits and converges deterministically', () => {
    const base = seededDocument()
    const baseTypes = getProjectSharedTypes(base)
    createScenarioResponse(baseTypes.discussions, baseTypes.scenarios, modelInput)
    const left = replica(base)
    const right = replica(base)
    const leftTypes = getProjectSharedTypes(left)
    const rightTypes = getProjectSharedTypes(right)

    editScenarioResponse(leftTypes.discussions, leftTypes.scenarios, {
      ...modelInput,
      revisionId: 'revision-left',
      expectedCurrentRevisionId: 'revision-model',
      content: 'Left edit.',
      authorId: 'researcher-left',
      authorDisplayName: 'Left Researcher',
      timestamp: 20,
      sourceKind: 'human',
      providerId: null,
      modelId: null,
      runId: null,
    })
    editScenarioResponse(rightTypes.discussions, rightTypes.scenarios, {
      ...modelInput,
      revisionId: 'revision-right',
      expectedCurrentRevisionId: 'revision-model',
      content: 'Right edit.',
      authorId: 'researcher-right',
      authorDisplayName: 'Right Researcher',
      timestamp: 20,
      sourceKind: 'human',
      providerId: null,
      modelId: null,
      runId: null,
    })

    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftResponse = readScenarioResponses(leftTypes.discussions, 'scenario-access')![0]
    const rightResponse = readScenarioResponses(rightTypes.discussions, 'scenario-access')![0]
    expect(rightResponse).toEqual(leftResponse)
    expect(leftResponse.revisions.map((revision) => revision.revisionId)).toEqual([
      'revision-model', 'revision-left', 'revision-right',
    ])
    expect(leftResponse.currentRevisionId).toBe('revision-right')
    expect(leftResponse.content).toBe('Right edit.')
  })

  it('fails closed when disconnected peers collide on response identity', () => {
    const base = seededDocument()
    const left = replica(base)
    const right = replica(base)
    const leftTypes = getProjectSharedTypes(left)
    const rightTypes = getProjectSharedTypes(right)
    createScenarioResponse(leftTypes.discussions, leftTypes.scenarios, modelInput)
    createScenarioResponse(rightTypes.discussions, rightTypes.scenarios, {
      ...modelInput,
      revisionId: 'revision-other-root',
      content: 'Independent conflicting root.',
    })
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    expect(readScenarioResponses(leftTypes.discussions, 'scenario-access')).toBeNull()
    expect(readScenarioResponses(rightTypes.discussions, 'scenario-access')).toBeNull()
    expect(inspectScenarioResponses(leftTypes.discussions, leftTypes.scenarios).healthy).toBe(false)
  })

  it('rejects malformed provenance and detects hostile bucket mutation', () => {
    const doc = seededDocument()
    const { discussions, scenarios } = getProjectSharedTypes(doc)
    expect(() => createScenarioResponse(discussions, scenarios, {
      ...modelInput,
      providerId: null,
    })).toThrow('Invalid scenario response revision')
    createScenarioResponse(discussions, scenarios, modelInput)
    const bucket = Array.from(discussions.values()).find((value) => value instanceof Y.Map) as Y.Map<unknown>
    bucket.set('unexpected', true)
    expect(readScenarioResponses(discussions, 'scenario-access')).toBeNull()
    expect(inspectScenarioResponses(discussions, scenarios)).toMatchObject({
      healthy: false,
      invalidRecords: 2,
    })
  })
})
