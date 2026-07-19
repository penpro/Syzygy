import type * as Y from 'yjs'
import type { RemoteProviderId } from '../tauri'
import { getProjectSharedTypes } from './projectModel'
import { readScenario, type ResearchScenario } from './scenarioModel'
import { createScenarioResponse, editScenarioResponse, readScenarioResponses, type ScenarioResponse } from './scenarioResponseModel'
import type { ResearchProjectManifest } from './schema'

export const SCENARIO_GENERATION_CONTRACT_VERSION = 2 as const
export const MAX_SCENARIO_GENERATION_INSTRUCTIONS = 20_000
export const MAX_SCENARIO_GENERATION_CONTEXT = 240_000
export const MAX_SCENARIO_GENERATION_OUTPUT = 500_000

export type ScenarioGenerationProviderId = 'local' | RemoteProviderId

export interface ScenarioGenerationTurnSnapshot {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ScenarioGenerationParentResponse {
  responseId: string
  revisionId: string
  content: string
}

export interface ScenarioGenerationRequest {
  contractVersion: typeof SCENARIO_GENERATION_CONTRACT_VERSION
  runId: string
  providerId: ScenarioGenerationProviderId
  requestedModelId: string
  projectId: string
  documentId: string
  scenarioId: string
  scenarioTitle: string
  scenarioBackground: string
  scenarioStatus: ResearchScenario['status']
  turns: ScenarioGenerationTurnSnapshot[]
  parentResponse: ScenarioGenerationParentResponse | null
  sourceRevision: string
  instructions: string
}

export interface ScenarioGenerationOutput {
  contractVersion: typeof SCENARIO_GENERATION_CONTRACT_VERSION
  runId: string
  providerId: ScenarioGenerationProviderId
  requestedModelId: string
  executedModelId: string
  content: string
}

export interface ScenarioGenerationAdapter {
  readonly providerId: ScenarioGenerationProviderId
  generate(request: Readonly<ScenarioGenerationRequest>, signal: AbortSignal): Promise<unknown>
  cancel?(runId: string): Promise<void>
}

export interface CommitScenarioGenerationInput {
  responseId: string
  revisionId: string
  authorId: string
  authorDisplayName: string
  timestamp: number
}

const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)

const providerIds = new Set<ScenarioGenerationProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])

const routeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)

const boundedText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000]/.test(value) &&
  (allowEmpty || value.trim().length > 0)

const exactKeys = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',')

export function scenarioGenerationRevision(scenario: ResearchScenario): string {
  return JSON.stringify({
    scenarioId: scenario.id,
    edits: scenario.edits.map(({ editId }) => editId).sort(),
    turns: scenario.turns.map((turn) => ({
      turnId: turn.id,
      revisions: turn.revisions.map(({ editId }) => editId).sort(),
    })),
  })
}

function contextLength(scenario: ResearchScenario, parentResponse: ScenarioGenerationParentResponse | null): number {
  return scenario.title.length + scenario.background.length +
    scenario.turns.reduce((total, turn) => total + turn.content.length, 0) +
    (parentResponse?.content.length ?? 0)
}

export function buildScenarioGenerationRequest(input: {
  runId: string
  providerId: ScenarioGenerationProviderId
  requestedModelId: string
  project: ResearchProjectManifest
  scenario: ResearchScenario
  parentResponse?: ScenarioResponse
  instructions?: string
}): ScenarioGenerationRequest {
  const instructions = input.instructions?.trim() ||
    'Continue this scenario with the most realistic next participant response. Do not invent access to evidence that is not present in the scenario.'
  const parentRevision = input.parentResponse?.revisions.find(({ revisionId }) =>
    revisionId === input.parentResponse?.currentRevisionId)
  if (input.parentResponse && (input.parentResponse.scenarioId !== input.scenario.id || !parentRevision ||
    parentRevision.content !== input.parentResponse.content)) {
    throw new Error('Scenario regeneration parent is invalid or stale')
  }
  const parentResponse: ScenarioGenerationParentResponse | null = input.parentResponse ? {
    responseId: input.parentResponse.id,
    revisionId: input.parentResponse.currentRevisionId,
    content: input.parentResponse.content,
  } : null
  if (!stableId(input.runId) || !stableId(input.project.id) || !stableId(input.project.documentId) ||
    !stableId(input.scenario.id) || !providerIds.has(input.providerId) || !routeId(input.requestedModelId)) {
    throw new Error('Scenario generation route or identity is invalid')
  }
  if (!boundedText(instructions, MAX_SCENARIO_GENERATION_INSTRUCTIONS) ||
    contextLength(input.scenario, parentResponse) > MAX_SCENARIO_GENERATION_CONTEXT) {
    throw new Error('Scenario generation input exceeds the bounded provider contract')
  }
  return {
    contractVersion: SCENARIO_GENERATION_CONTRACT_VERSION,
    runId: input.runId,
    providerId: input.providerId,
    requestedModelId: input.requestedModelId,
    projectId: input.project.id,
    documentId: input.project.documentId,
    scenarioId: input.scenario.id,
    scenarioTitle: input.scenario.title,
    scenarioBackground: input.scenario.background,
    scenarioStatus: input.scenario.status,
    turns: input.scenario.turns.map(({ role, content }) => ({ role, content })),
    parentResponse,
    sourceRevision: scenarioGenerationRevision(input.scenario),
    instructions,
  }
}

export function validateScenarioGenerationOutput(
  request: ScenarioGenerationRequest,
  value: unknown,
): ScenarioGenerationOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'contractVersion', 'runId', 'providerId', 'requestedModelId', 'executedModelId', 'content',
  ])) throw new Error('Scenario provider returned an invalid response envelope')
  const output = value as Partial<ScenarioGenerationOutput>
  if (output.contractVersion !== SCENARIO_GENERATION_CONTRACT_VERSION ||
    output.runId !== request.runId || output.providerId !== request.providerId ||
    output.requestedModelId !== request.requestedModelId || !routeId(output.executedModelId) ||
    !boundedText(output.content, MAX_SCENARIO_GENERATION_OUTPUT)) {
    throw new Error('Scenario provider response does not match the requested route')
  }
  return { ...(output as ScenarioGenerationOutput) }
}

export async function runScenarioGeneration(
  adapter: ScenarioGenerationAdapter,
  request: ScenarioGenerationRequest,
  signal: AbortSignal,
): Promise<ScenarioGenerationOutput> {
  if (adapter.providerId !== request.providerId) throw new Error('Scenario provider adapter route mismatch')
  if (signal.aborted) throw new DOMException('Scenario generation cancelled', 'AbortError')
  const value = await adapter.generate(Object.freeze(structuredClone(request)), signal)
  if (signal.aborted) throw new DOMException('Scenario generation cancelled', 'AbortError')
  return validateScenarioGenerationOutput(request, value)
}

export function commitScenarioGeneration(
  doc: Y.Doc,
  request: ScenarioGenerationRequest,
  output: ScenarioGenerationOutput,
  input: CommitScenarioGenerationInput,
): ScenarioResponse {
  const validated = validateScenarioGenerationOutput(request, output)
  const { metadata, scenarios, discussions } = getProjectSharedTypes(doc)
  if (doc.guid !== request.documentId || metadata.get('projectId') !== request.projectId) {
    throw new Error('Scenario generation project identity changed before commit')
  }
  const current = readScenario(scenarios, request.scenarioId)
  if (!current || scenarioGenerationRevision(current) !== request.sourceRevision) {
    throw new Error('Scenario changed during generation; review the new state and run again')
  }
  if (request.parentResponse) {
    if (input.responseId !== request.parentResponse.responseId) {
      throw new Error('Scenario regeneration response identity changed before commit')
    }
    const response = readScenarioResponses(discussions, request.scenarioId)?.find(({ id }) =>
      id === request.parentResponse?.responseId)
    if (!response || response.currentRevisionId !== request.parentResponse.revisionId ||
      response.content !== request.parentResponse.content) {
      throw new Error('Scenario response changed during regeneration; review the new variant and run again')
    }
    return editScenarioResponse(discussions, scenarios, {
      responseId: input.responseId,
      scenarioId: request.scenarioId,
      revisionId: input.revisionId,
      expectedCurrentRevisionId: request.parentResponse.revisionId,
      content: validated.content,
      authorId: input.authorId,
      authorDisplayName: input.authorDisplayName,
      timestamp: input.timestamp,
      sourceKind: 'model',
      providerId: validated.providerId,
      modelId: validated.executedModelId,
      runId: validated.runId,
    })
  }
  return createScenarioResponse(discussions, scenarios, {
    responseId: input.responseId,
    scenarioId: request.scenarioId,
    revisionId: input.revisionId,
    content: validated.content,
    authorId: input.authorId,
    authorDisplayName: input.authorDisplayName,
    timestamp: input.timestamp,
    sourceKind: 'model',
    providerId: validated.providerId,
    modelId: validated.executedModelId,
    runId: validated.runId,
  })
}
