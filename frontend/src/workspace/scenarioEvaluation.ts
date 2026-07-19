import type { RemoteProviderId } from '../tauri'
import { heuristicCheckPolicyText } from './heuristicCheck'
import type { PolicyVersion } from './policyVersionModel'
import { scenarioGenerationRevision } from './scenarioGeneration'
import type { ResearchScenario } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'

export const SCENARIO_EVALUATION_CONTRACT_VERSION = 1 as const
export const SCENARIO_EVALUATION_PROMPT_VERSION = 'scenario-evaluation-v1' as const
export const MAX_SCENARIO_EVALUATION_POLICY = 500_000
export const MAX_SCENARIO_EVALUATION_CONTEXT = 800_000
export const MAX_SCENARIO_EVALUATION_OUTPUT = 500_000

export type ScenarioEvaluationProviderId = 'local' | RemoteProviderId
export type ScenarioEvaluationOutcome = 'handled' | 'unhandled' | 'uncertain'

export interface ScenarioEvaluationTurnSnapshot {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ScenarioEvaluationRequest {
  contractVersion: typeof SCENARIO_EVALUATION_CONTRACT_VERSION
  promptVersion: typeof SCENARIO_EVALUATION_PROMPT_VERSION
  jobId: string
  itemId: string
  attempt: number
  runId: string
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  projectId: string
  documentId: string
  policyVersionId: string
  policyText: string
  scenarioId: string
  scenarioTitle: string
  scenarioBackground: string
  scenarioStatus: ResearchScenario['status']
  scenarioTurns: ScenarioEvaluationTurnSnapshot[]
  scenarioRevision: string
}

export interface ScenarioEvaluationOutput {
  contractVersion: typeof SCENARIO_EVALUATION_CONTRACT_VERSION
  promptVersion: typeof SCENARIO_EVALUATION_PROMPT_VERSION
  jobId: string
  itemId: string
  attempt: number
  runId: string
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  executedModelId: string
  outcome: ScenarioEvaluationOutcome
  response: string
  rationale: string
  uncertainty: string
}

export interface ScenarioEvaluationAdapter {
  readonly providerId: ScenarioEvaluationProviderId
  evaluate(request: Readonly<ScenarioEvaluationRequest>, signal: AbortSignal): Promise<unknown>
  cancel?(runId: string): Promise<void>
}

const providers = new Set<ScenarioEvaluationProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const routeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)
const boundedText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
  (allowEmpty || value.trim().length > 0)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')

export function buildScenarioEvaluationRequest(input: {
  jobId: string
  itemId: string
  attempt: number
  runId: string
  providerId: ScenarioEvaluationProviderId
  requestedModelId: string
  project: ResearchProjectManifest
  policyVersion: PolicyVersion
  scenario: ResearchScenario
}): ScenarioEvaluationRequest {
  if (!stableId(input.jobId) || !stableId(input.itemId) || !stableId(input.runId) ||
    !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 3 ||
    !providers.has(input.providerId) || !routeId(input.requestedModelId) ||
    !stableId(input.project.id) || !stableId(input.project.documentId) ||
    !stableId(input.scenario.id) || !/^[a-f0-9]{64}$/.test(input.policyVersion.versionId)) {
    throw new Error('Scenario evaluation route, attempt, or identity is invalid')
  }
  if (input.policyVersion.projectId !== input.project.id) {
    throw new Error('Scenario evaluation policy version belongs to another project')
  }
  const policyText = heuristicCheckPolicyText(input.policyVersion.policy.blocks)
  if (policyText.length > MAX_SCENARIO_EVALUATION_POLICY ||
    !boundedText(input.scenario.title, 200) || !boundedText(input.scenario.background, 50_000, true) ||
    input.scenario.turns.some((turn) => !boundedText(turn.content, 200_000, true))) {
    throw new Error('Scenario evaluation input is invalid or exceeds its bound')
  }
  const contextLength = policyText.length + input.scenario.title.length + input.scenario.background.length +
    input.scenario.turns.reduce((total, turn) => total + turn.content.length, 0)
  if (contextLength > MAX_SCENARIO_EVALUATION_CONTEXT) {
    throw new Error('Scenario evaluation context exceeds its bound')
  }
  return {
    contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
    promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
    jobId: input.jobId,
    itemId: input.itemId,
    attempt: input.attempt,
    runId: input.runId,
    providerId: input.providerId,
    requestedModelId: input.requestedModelId,
    projectId: input.project.id,
    documentId: input.project.documentId,
    policyVersionId: input.policyVersion.versionId,
    policyText,
    scenarioId: input.scenario.id,
    scenarioTitle: input.scenario.title,
    scenarioBackground: input.scenario.background,
    scenarioStatus: input.scenario.status,
    scenarioTurns: input.scenario.turns.map(({ role, content }) => ({ role, content })),
    scenarioRevision: scenarioGenerationRevision(input.scenario),
  }
}

export function validateScenarioEvaluationOutput(
  request: ScenarioEvaluationRequest,
  value: unknown,
): ScenarioEvaluationOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'contractVersion', 'promptVersion', 'jobId', 'itemId', 'attempt', 'runId', 'providerId',
    'requestedModelId', 'executedModelId', 'outcome', 'response', 'rationale', 'uncertainty',
  ])) throw new Error('Scenario evaluator returned an invalid response envelope')
  const output = value as Partial<ScenarioEvaluationOutput>
  if (output.contractVersion !== SCENARIO_EVALUATION_CONTRACT_VERSION ||
    output.promptVersion !== SCENARIO_EVALUATION_PROMPT_VERSION || output.jobId !== request.jobId ||
    output.itemId !== request.itemId || output.attempt !== request.attempt || output.runId !== request.runId ||
    output.providerId !== request.providerId || output.requestedModelId !== request.requestedModelId ||
    !routeId(output.executedModelId) || !['handled', 'unhandled', 'uncertain'].includes(output.outcome ?? '') ||
    !boundedText(output.response, MAX_SCENARIO_EVALUATION_OUTPUT) ||
    !boundedText(output.rationale, 100_000) || !boundedText(output.uncertainty, 50_000)) {
    throw new Error('Scenario evaluator response does not match the requested route or result schema')
  }
  return output as ScenarioEvaluationOutput
}

export async function runScenarioEvaluation(
  adapter: ScenarioEvaluationAdapter,
  request: ScenarioEvaluationRequest,
  signal: AbortSignal,
): Promise<ScenarioEvaluationOutput> {
  if (adapter.providerId !== request.providerId) throw new Error('Scenario evaluator adapter route mismatch')
  if (signal.aborted) throw new DOMException('Scenario evaluation cancelled', 'AbortError')
  const value = await adapter.evaluate(Object.freeze(structuredClone(request)), signal)
  if (signal.aborted) throw new DOMException('Scenario evaluation cancelled', 'AbortError')
  return validateScenarioEvaluationOutput(request, value)
}
