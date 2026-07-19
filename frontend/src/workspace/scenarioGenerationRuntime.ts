import { streamChat } from '../api/ollama'
import type { Settings } from '../types'
import {
  providerCancel,
  providerGenerate,
  type ProviderResearchTaskRequest,
  type RemoteProviderId,
} from '../tauri'
import {
  SCENARIO_GENERATION_CONTRACT_VERSION,
  type ScenarioGenerationAdapter,
  type ScenarioGenerationOutput,
  type ScenarioGenerationRequest,
} from './scenarioGeneration'

export const SCENARIO_REMOTE_PROVIDERS: ReadonlyArray<{
  id: RemoteProviderId
  name: string
  defaultModel: string
}> = [
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.2' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-3.5-flash' },
  { id: 'xai', name: 'xAI', defaultModel: 'grok-4.5' },
]

function scenarioSource(request: ScenarioGenerationRequest): string {
  const turns = request.turns.length
    ? request.turns.map((turn, index) => `${index + 1}. ${turn.role.toUpperCase()}\n${turn.content}`).join('\n\n')
    : '(No conversation turns yet.)'
  return [
    `Title: ${request.scenarioTitle}`,
    `Workflow state: ${request.scenarioStatus}`,
    `Background:\n${request.scenarioBackground || '(No background supplied.)'}`,
    `Conversation:\n${turns}`,
  ].join('\n\n')
}

const systemInstruction =
  'Act as a scenario participant for policy research. Return only the proposed next response, without a preamble. Use only the supplied scenario; distinguish uncertainty instead of inventing facts or source access.'

export function createLocalScenarioGenerationAdapter(
  settings: Settings,
  complete: typeof streamChat = streamChat,
): ScenarioGenerationAdapter {
  return {
    providerId: 'local',
    async generate(request, signal): Promise<ScenarioGenerationOutput> {
      if (!settings.localAiEnabled) throw new Error('Local AI is turned off')
      const { content } = await complete({
        baseUrl: settings.baseUrl,
        model: request.requestedModelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: `${scenarioSource(request)}\n\nResearcher direction:\n${request.instructions}` },
        ],
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: settings.maxTokens > 0 ? Math.min(settings.maxTokens, 4_096) : 1_200,
        signal,
      })
      return {
        contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION,
        runId: request.runId,
        providerId: 'local',
        requestedModelId: request.requestedModelId,
        executedModelId: request.requestedModelId,
        content,
      }
    },
  }
}

export function buildRemoteScenarioTask(request: ScenarioGenerationRequest): ProviderResearchTaskRequest {
  if (request.providerId === 'local') throw new Error('A remote scenario task requires a remote provider')
  return {
    runId: request.runId,
    callId: request.runId,
    taskType: 'research.scenario-response',
    provider: request.providerId,
    timeoutMs: 120_000,
    model: request.requestedModelId,
    developerInstructions: systemInstruction,
    question: request.instructions,
    sources: [{
      snapshotId: `scenario-${request.scenarioId}-${request.runId}`,
      label: `Selected scenario: ${request.scenarioTitle}`,
      excerpt: scenarioSource(request),
    }],
    maxOutputTokens: 1_200,
  }
}

export function createRemoteScenarioGenerationAdapter(
  providerId: RemoteProviderId,
  generate: typeof providerGenerate = providerGenerate,
  cancel: typeof providerCancel = providerCancel,
): ScenarioGenerationAdapter {
  return {
    providerId,
    async generate(request): Promise<ScenarioGenerationOutput> {
      const outcome = await generate(buildRemoteScenarioTask(request))
      if (!outcome.response) throw new Error(`Remote scenario generation failed (${outcome.errorCode ?? 'unknown'})`)
      if (outcome.response.provider !== providerId) throw new Error('Remote scenario provider route mismatch')
      return {
        contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION,
        runId: request.runId,
        providerId,
        requestedModelId: request.requestedModelId,
        executedModelId: outcome.response.model ?? request.requestedModelId,
        content: outcome.response.text,
      }
    },
    async cancel(runId) { await cancel(runId) },
  }
}
