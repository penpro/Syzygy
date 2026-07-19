import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../seed'
import type { ProviderTaskOutcome } from '../tauri'
import { buildScenarioGenerationRequest } from './scenarioGeneration'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { createScenario, readScenario } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'
import {
  buildRemoteScenarioTask,
  createLocalScenarioGenerationAdapter,
  createRemoteScenarioGenerationAdapter,
} from './scenarioGenerationRuntime'

const project: ResearchProjectManifest = {
  schemaVersion: 1, id: 'project-runtime', documentId: 'document-runtime', title: 'Runtime',
  createdAt: 1, updatedAt: 1, transport: { kind: 'local' },
}

function request(providerId: 'local' | 'openai' = 'local') {
  const doc = createProjectDocument(project)
  const { scenarios } = getProjectSharedTypes(doc)
  createScenario(scenarios, {
    id: 'scenario-runtime', title: 'Runtime scenario', background: 'Only this context is sent.',
    authorId: 'researcher-1', timestamp: 1, editId: 'create-runtime',
  })
  return buildScenarioGenerationRequest({
    runId: 'runtime-run-1', providerId, requestedModelId: providerId === 'local' ? 'local-model' : 'gpt-test',
    project, scenario: readScenario(scenarios, 'scenario-runtime')!, instructions: 'Answer cautiously.',
  })
}

describe('scenario generation runtime adapters', () => {
  it('routes local generation through the selected loopback model with a bounded output budget', async () => {
    const complete = vi.fn(async () => ({ content: 'Local response.', reasoning: '' }))
    const adapter = createLocalScenarioGenerationAdapter({ ...defaultSettings, localAiEnabled: true }, complete)
    const result = await adapter.generate(request(), new AbortController().signal)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: defaultSettings.baseUrl, model: 'local-model', maxTokens: 1_200,
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.stringContaining('Only this context is sent.') })]),
    }))
    expect(result).toMatchObject({ providerId: 'local', executedModelId: 'local-model', content: 'Local response.' })
  })

  it('refuses local invocation when local AI is disabled', async () => {
    const complete = vi.fn()
    const adapter = createLocalScenarioGenerationAdapter({ ...defaultSettings, localAiEnabled: false }, complete)
    await expect(adapter.generate(request(), new AbortController().signal)).rejects.toThrow('turned off')
    expect(complete).not.toHaveBeenCalled()
  })

  it('builds a one-source remote disclosure envelope and normalizes the returned model', async () => {
    const remoteRequest = request('openai')
    const task = buildRemoteScenarioTask(remoteRequest)
    expect(task).toMatchObject({
      runId: remoteRequest.runId, callId: remoteRequest.runId, taskType: 'research.scenario-response',
      provider: 'openai', model: 'gpt-test', maxOutputTokens: 1_200,
    })
    expect(task.sources).toHaveLength(1)
    expect(task.sources[0].excerpt).toContain('Only this context is sent.')

    const outcome = {
      response: { provider: 'openai', id: 'response', status: 'completed', model: 'gpt-test-actual', text: 'Remote response.', refusals: [], unknownOutputTypes: [], usage: null },
      zeroDataRetention: false, errorCode: null, runRecord: {},
    } as unknown as ProviderTaskOutcome
    const generate = vi.fn(async () => outcome)
    const cancel = vi.fn(async () => true)
    const adapter = createRemoteScenarioGenerationAdapter('openai', generate, cancel)
    await expect(adapter.generate(remoteRequest, new AbortController().signal)).resolves.toMatchObject({
      providerId: 'openai', requestedModelId: 'gpt-test', executedModelId: 'gpt-test-actual', content: 'Remote response.',
    })
    await adapter.cancel?.(remoteRequest.runId)
    expect(cancel).toHaveBeenCalledWith(remoteRequest.runId)
  })

  it('rejects a native response attributed to a different provider route', async () => {
    const mismatched = {
      response: { provider: 'anthropic', id: 'response', status: 'completed', model: 'model', text: 'Wrong route.', refusals: [], unknownOutputTypes: [], usage: null },
      zeroDataRetention: null, errorCode: null, runRecord: {},
    } as unknown as ProviderTaskOutcome
    const adapter = createRemoteScenarioGenerationAdapter('openai', async () => mismatched)
    await expect(adapter.generate(request('openai'), new AbortController().signal)).rejects.toThrow('route mismatch')
  })

  it('does not fabricate content from a failed remote outcome', async () => {
    const failed = { response: null, zeroDataRetention: null, errorCode: 'timeout', runRecord: {} } as unknown as ProviderTaskOutcome
    const adapter = createRemoteScenarioGenerationAdapter('openai', async () => failed)
    await expect(adapter.generate(request('openai'), new AbortController().signal)).rejects.toThrow('timeout')
  })
})
