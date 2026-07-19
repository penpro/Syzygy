import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyProjectUpdate,
  createProjectDocument,
  encodeProjectState,
  getProjectSharedTypes,
} from './projectModel'
import { createScenario, readScenario } from './scenarioModel'
import { readScenarioResponses } from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'
import {
  buildScenarioGenerationRequest,
  commitScenarioGeneration,
  SCENARIO_GENERATION_CONTRACT_VERSION,
  type ScenarioGenerationOutput,
} from './scenarioGeneration'

const project: ResearchProjectManifest = {
  schemaVersion: 1, id: 'project-regeneration', documentId: 'document-regeneration', title: 'Regeneration',
  createdAt: 1, updatedAt: 1, transport: { kind: 'local' },
}

function seeded() {
  const doc = createProjectDocument(project)
  const { scenarios } = getProjectSharedTypes(doc)
  createScenario(scenarios, {
    id: 'scenario-regenerate', title: 'Appeal process', background: 'A resident appeals a denial.',
    authorId: 'researcher-1', timestamp: 1, editId: 'create-regenerate',
  })
  const scenario = readScenario(scenarios, 'scenario-regenerate')!
  const firstRequest = buildScenarioGenerationRequest({
    runId: 'generation-root', providerId: 'local', requestedModelId: 'local-model', project, scenario,
  })
  const firstOutput: ScenarioGenerationOutput = {
    contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION, runId: firstRequest.runId,
    providerId: 'local', requestedModelId: 'local-model', executedModelId: 'local-model',
    content: 'Initial variant.',
  }
  const response = commitScenarioGeneration(doc, firstRequest, firstOutput, {
    responseId: 'response-lineage', revisionId: 'revision-root', authorId: 'model-local',
    authorDisplayName: 'Local model', timestamp: 10,
  })
  return { doc, scenario, response }
}

function regenerate(doc: Y.Doc, response: ReturnType<typeof seeded>['response'], runId: string, revisionId: string, content: string) {
  const scenario = readScenario(getProjectSharedTypes(doc).scenarios, response.scenarioId)!
  const request = buildScenarioGenerationRequest({
    runId, providerId: 'local', requestedModelId: 'local-model', project, scenario, parentResponse: response,
  })
  const output: ScenarioGenerationOutput = {
    contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION, runId, providerId: 'local',
    requestedModelId: 'local-model', executedModelId: 'local-model', content,
  }
  return commitScenarioGeneration(doc, request, output, {
    responseId: response.id, revisionId, authorId: 'model-local', authorDisplayName: 'Local model', timestamp: 20,
  })
}

describe('scenario response regeneration lineage', () => {
  it('adds a child revision while retaining the prior variant and exact parent', () => {
    const { doc, response } = seeded()
    const regenerated = regenerate(doc, response, 'generation-child', 'revision-child', 'Revised variant.')
    expect(regenerated.content).toBe('Revised variant.')
    expect(regenerated.revisions.map(({ revisionId }) => revisionId)).toEqual(['revision-root', 'revision-child'])
    expect(regenerated.revisions[1]).toMatchObject({
      parentRevisionId: 'revision-root', content: 'Revised variant.', runId: 'generation-child',
    })
    expect(regenerated.revisions[0].content).toBe('Initial variant.')
  })

  it('fails without mutation when the response changes while regeneration is running', () => {
    const { doc, response } = seeded()
    const scenario = readScenario(getProjectSharedTypes(doc).scenarios, response.scenarioId)!
    const staleRequest = buildScenarioGenerationRequest({
      runId: 'generation-stale', providerId: 'local', requestedModelId: 'local-model', project, scenario, parentResponse: response,
    })
    regenerate(doc, response, 'generation-other', 'revision-other', 'A collaborator variant.')
    const staleOutput: ScenarioGenerationOutput = {
      contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION, runId: staleRequest.runId, providerId: 'local',
      requestedModelId: 'local-model', executedModelId: 'local-model', content: 'Stale variant.',
    }
    expect(() => commitScenarioGeneration(doc, staleRequest, staleOutput, {
      responseId: response.id, revisionId: 'revision-stale', authorId: 'model-local',
      authorDisplayName: 'Local model', timestamp: 30,
    })).toThrow('response changed during regeneration')
    expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, response.scenarioId)?.[0].revisions)
      .toHaveLength(2)
  })

  it('retains concurrent sibling regenerations and converges deterministically', () => {
    const { doc, response } = seeded()
    const left = new Y.Doc({ guid: doc.guid })
    const right = new Y.Doc({ guid: doc.guid })
    applyProjectUpdate(left, encodeProjectState(doc))
    applyProjectUpdate(right, encodeProjectState(doc))
    regenerate(left, response, 'generation-left', 'revision-left', 'Left variant.')
    regenerate(right, response, 'generation-right', 'revision-right', 'Right variant.')
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftResponse = readScenarioResponses(getProjectSharedTypes(left).discussions, response.scenarioId)![0]
    const rightResponse = readScenarioResponses(getProjectSharedTypes(right).discussions, response.scenarioId)![0]
    expect(rightResponse).toEqual(leftResponse)
    expect(leftResponse.revisions.map(({ revisionId }) => revisionId)).toEqual([
      'revision-root', 'revision-left', 'revision-right',
    ])
    expect(leftResponse.revisions.filter(({ parentRevisionId }) => parentRevisionId === 'revision-root')).toHaveLength(2)
  })

  it('rejects a parent from another scenario before any provider request can be built', () => {
    const { doc, response } = seeded()
    const { scenarios } = getProjectSharedTypes(doc)
    createScenario(scenarios, {
      id: 'scenario-other', title: 'Other', background: '', authorId: 'researcher-1', timestamp: 2, editId: 'create-other',
    })
    expect(() => buildScenarioGenerationRequest({
      runId: 'generation-wrong-parent', providerId: 'local', requestedModelId: 'local-model', project,
      scenario: readScenario(scenarios, 'scenario-other')!, parentResponse: response,
    })).toThrow('parent is invalid')
  })
})
