import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { createScenario, readScenario, updateScenario } from './scenarioModel'
import { readScenarioResponses } from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'
import {
  buildScenarioGenerationRequest,
  commitScenarioGeneration,
  MAX_SCENARIO_GENERATION_OUTPUT,
  runScenarioGeneration,
  SCENARIO_GENERATION_CONTRACT_VERSION,
  type ScenarioGenerationAdapter,
} from './scenarioGeneration'

const project: ResearchProjectManifest = {
  schemaVersion: 1, id: 'project-generation', documentId: 'document-generation', title: 'Generation research',
  createdAt: 1, updatedAt: 1, transport: { kind: 'local' },
}

function fixture() {
  const doc = createProjectDocument(project)
  const { scenarios } = getProjectSharedTypes(doc)
  createScenario(scenarios, {
    id: 'scenario-access', title: 'Access rule', background: 'A resident requests access.',
    authorId: 'researcher-1', timestamp: 1, editId: 'create-scenario',
  })
  const scenario = readScenario(scenarios, 'scenario-access')!
  const request = buildScenarioGenerationRequest({
    runId: 'scenario-run-1', providerId: 'local', requestedModelId: 'model-local', project, scenario,
  })
  return { doc, scenarios, request }
}

const output = {
  contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION,
  runId: 'scenario-run-1', providerId: 'local' as const, requestedModelId: 'model-local',
  executedModelId: 'model-local', content: 'The resident should receive a written decision.',
}

const commit = (doc: Y.Doc, request: ReturnType<typeof buildScenarioGenerationRequest>) =>
  commitScenarioGeneration(doc, request, output, {
    responseId: 'response-1', revisionId: 'revision-1', authorId: 'model-local',
    authorDisplayName: 'Local model', timestamp: 10,
  })

describe('scenario generation provider contract', () => {
  it('passes a detached selected-scenario snapshot and commits attributed output only after success', async () => {
    const { doc, request } = fixture()
    const generate = vi.fn(async (received) => {
      expect(received).toEqual(request)
      expect(Object.isFrozen(received)).toBe(true)
      expect(received).not.toBe(request)
      return output
    })
    const adapter: ScenarioGenerationAdapter = { providerId: 'local', generate }
    expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, request.scenarioId)).toEqual([])
    const result = await runScenarioGeneration(adapter, request, new AbortController().signal)
    expect(request.scenarioTitle).toBe('Access rule')
    const response = commitScenarioGeneration(doc, request, result, {
      responseId: 'response-1', revisionId: 'revision-1', authorId: 'model-local',
      authorDisplayName: 'Local model', timestamp: 10,
    })
    expect(response.content).toBe(output.content)
    expect(response.revisions[0]).toMatchObject({
      sourceKind: 'model', providerId: 'local', modelId: 'model-local', runId: 'scenario-run-1',
    })
  })

  it('rejects route substitution, ambient fields, control bytes, and oversized output without mutation', async () => {
    const hostile = [
      { ...output, providerId: 'openai' },
      { ...output, requestedModelId: 'other-model' },
      { ...output, runId: 'other-run' },
      { ...output, content: 'bad\u0000content' },
      { ...output, content: 'x'.repeat(MAX_SCENARIO_GENERATION_OUTPUT + 1) },
      { ...output, credential: 'must-not-cross' },
    ]
    for (const value of hostile) {
      const { doc, request } = fixture()
      const adapter: ScenarioGenerationAdapter = { providerId: 'local', generate: async () => value }
      await expect(runScenarioGeneration(adapter, request, new AbortController().signal)).rejects.toThrow()
      expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, request.scenarioId)).toEqual([])
    }
  })

  it('fails closed when selected scenario content changes during a call', () => {
    const { doc, scenarios, request } = fixture()
    updateScenario(scenarios, {
      id: request.scenarioId, authorId: 'researcher-2', timestamp: 2, editId: 'edit-during-run',
      changes: { background: 'The shared scenario changed.' },
    })
    expect(() => commit(doc, request)).toThrow('changed during generation')
    expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, request.scenarioId)).toEqual([])
  })

  it('does not call an adapter when already cancelled and retains independent concurrent variants', async () => {
    const { doc, request } = fixture()
    const generate = vi.fn(async () => output)
    const controller = new AbortController()
    controller.abort()
    await expect(runScenarioGeneration({ providerId: 'local', generate }, request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(generate).not.toHaveBeenCalled()

    commit(doc, request)
    commitScenarioGeneration(doc, request, { ...output, runId: request.runId, content: 'A second independent variant.' }, {
      responseId: 'response-2', revisionId: 'revision-2', authorId: 'model-local',
      authorDisplayName: 'Local model', timestamp: 11,
    })
    expect(readScenarioResponses(getProjectSharedTypes(doc).discussions, request.scenarioId)).toHaveLength(2)
  })

  it('rejects mismatched project identity and unbounded context', () => {
    const { doc, request } = fixture()
    const other = new Y.Doc({ guid: project.documentId })
    expect(() => commit(other, request)).toThrow('project identity changed')
    expect(() => buildScenarioGenerationRequest({
      runId: 'run-large', providerId: 'local', requestedModelId: 'model-local', project,
      scenario: { ...readScenario(getProjectSharedTypes(doc).scenarios, request.scenarioId)!, background: 'x'.repeat(240_001) },
    })).toThrow('bounded provider contract')
  })
})
