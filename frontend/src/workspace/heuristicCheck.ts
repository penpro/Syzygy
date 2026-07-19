import type { RemoteProviderId } from '../tauri'
import type { AutomationDocumentBlock } from './editorAutomationRegistry'
import type { HeuristicExampleHistory } from './heuristicExampleModel'
import type { ResearchHeuristic } from './heuristicsModel'
import type { ResearchProjectManifest } from './schema'
import { suggestionSourceRevision } from './suggestionApplication'

export const HEURISTIC_CHECK_CONTRACT_VERSION = 1 as const
export const HEURISTIC_CHECK_MAX_POLICY_TEXT = 500_000
export const HEURISTIC_CHECK_MAX_CONTEXT = 700_000
export const HEURISTIC_CHECK_MAX_CITATIONS = 50
export const HEURISTIC_CHECK_MAX_ATTEMPTS = 2

export type HeuristicCheckProviderId = 'local' | RemoteProviderId
export type HeuristicCheckVerdict = 'pass' | 'fail' | 'uncertain'

export interface HeuristicCheckExampleSnapshot {
  id: string
  polarity: 'positive' | 'negative'
  body: string
  currentEventId: string
}

export interface HeuristicCheckCitation {
  start: number
  end: number
  quote: string
}

export interface HeuristicCheckRequest {
  contractVersion: typeof HEURISTIC_CHECK_CONTRACT_VERSION
  runId: string
  providerId: HeuristicCheckProviderId
  requestedModelId: string
  projectId: string
  documentId: string
  heuristicId: string
  heuristicTitle: string
  heuristicGuidance: string
  heuristicPriority: ResearchHeuristic['priority']
  heuristicRevision: string
  examples: HeuristicCheckExampleSnapshot[]
  exampleRevision: string
  policyText: string
  sourceRevision: string
}

export interface HeuristicCheckOutput {
  contractVersion: typeof HEURISTIC_CHECK_CONTRACT_VERSION
  runId: string
  providerId: HeuristicCheckProviderId
  requestedModelId: string
  executedModelId: string
  verdict: HeuristicCheckVerdict
  rationale: string
  uncertainty: string
  citations: HeuristicCheckCitation[]
}

export interface HeuristicCheckAdapter {
  readonly providerId: HeuristicCheckProviderId
  evaluate(request: Readonly<HeuristicCheckRequest>, signal: AbortSignal, attempt: number): Promise<unknown>
  cancel?(runId: string): Promise<void>
}

const providerIds = new Set<HeuristicCheckProviderId>(['local', 'openai', 'anthropic', 'gemini', 'xai'])
const stableId = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const routeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
  !/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')

export function heuristicCheckPolicyText(blocks: AutomationDocumentBlock[]): string {
  const parts = blocks.flatMap((block) => {
    if (block.kind === 'suggestion') return []
    if (block.kind === 'policy') return [`[Policy ${block.policyId} · ${block.status}]\n${block.text}`]
    if (block.kind === 'heading1') return [`# ${block.text}`]
    if (block.kind === 'heading2') return [`## ${block.text}`]
    if (block.kind === 'quote') return [`> ${block.text}`]
    if (block.kind === 'spotlight') return [`[Scenario spotlight ${block.scenarioId}]`]
    return [block.text]
  })
  const text = parts.join('\n\n')
  if (!boundedText(text, HEURISTIC_CHECK_MAX_POLICY_TEXT)) {
    throw new Error('Heuristic check requires bounded non-empty policy content')
  }
  return text
}

export function heuristicCheckHeuristicRevision(heuristic: ResearchHeuristic): string {
  return JSON.stringify({
    id: heuristic.id,
    title: heuristic.title,
    guidance: heuristic.guidance,
    priority: heuristic.priority,
    enabled: heuristic.enabled,
    edits: heuristic.edits.map(({ editId }) => editId).sort(),
  })
}

export function heuristicCheckExampleRevision(examples: HeuristicExampleHistory[]): string {
  return JSON.stringify(examples.map(({ id, currentEventId, polarity }) => ({ id, currentEventId, polarity }))
    .sort((left, right) => left.id.localeCompare(right.id)))
}

export function buildHeuristicCheckRequest(input: {
  runId: string
  providerId: HeuristicCheckProviderId
  requestedModelId: string
  project: ResearchProjectManifest
  heuristic: ResearchHeuristic
  examples: HeuristicExampleHistory[]
  blocks: AutomationDocumentBlock[]
}): HeuristicCheckRequest {
  if (!stableId(input.runId) || !providerIds.has(input.providerId) || !routeId(input.requestedModelId) ||
    !stableId(input.project.id) || !stableId(input.project.documentId) || !stableId(input.heuristic.id)) {
    throw new Error('Heuristic check route or identity is invalid')
  }
  if (!input.heuristic.enabled) throw new Error('Disabled heuristics cannot be evaluated')
  if (!boundedText(input.heuristic.title, 200) || !boundedText(input.heuristic.guidance, 10_000)) {
    throw new Error('Heuristic check heuristic is invalid')
  }
  const policyText = heuristicCheckPolicyText(input.blocks)
  const examples = input.examples.map((example): HeuristicCheckExampleSnapshot => ({
    id: example.id,
    polarity: example.polarity,
    body: example.body,
    currentEventId: example.currentEventId,
  })).sort((left, right) => left.id.localeCompare(right.id))
  if (examples.some((example) => !stableId(example.id) || !stableId(example.currentEventId) ||
    (example.polarity !== 'positive' && example.polarity !== 'negative') || !boundedText(example.body, 100_000))) {
    throw new Error('Heuristic check example is invalid')
  }
  const contextLength = policyText.length + input.heuristic.title.length + input.heuristic.guidance.length +
    examples.reduce((total, example) => total + example.body.length, 0)
  if (contextLength > HEURISTIC_CHECK_MAX_CONTEXT) throw new Error('Heuristic check context exceeds its bound')
  return {
    contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION,
    runId: input.runId,
    providerId: input.providerId,
    requestedModelId: input.requestedModelId,
    projectId: input.project.id,
    documentId: input.project.documentId,
    heuristicId: input.heuristic.id,
    heuristicTitle: input.heuristic.title,
    heuristicGuidance: input.heuristic.guidance,
    heuristicPriority: input.heuristic.priority,
    heuristicRevision: heuristicCheckHeuristicRevision(input.heuristic),
    examples,
    exampleRevision: heuristicCheckExampleRevision(input.examples),
    policyText,
    sourceRevision: suggestionSourceRevision(input.blocks),
  }
}

export function validateHeuristicCheckOutput(
  request: HeuristicCheckRequest,
  value: unknown,
): HeuristicCheckOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, [
    'contractVersion', 'runId', 'providerId', 'requestedModelId', 'executedModelId',
    'verdict', 'rationale', 'uncertainty', 'citations',
  ])) throw new Error('Heuristic checker returned an invalid response envelope')
  const output = value as Partial<HeuristicCheckOutput>
  if (output.contractVersion !== HEURISTIC_CHECK_CONTRACT_VERSION || output.runId !== request.runId ||
    output.providerId !== request.providerId || output.requestedModelId !== request.requestedModelId ||
    !routeId(output.executedModelId) || !['pass', 'fail', 'uncertain'].includes(output.verdict ?? '') ||
    !boundedText(output.rationale, 100_000) || !boundedText(output.uncertainty, 50_000) ||
    !Array.isArray(output.citations) || output.citations.length === 0 ||
    output.citations.length > HEURISTIC_CHECK_MAX_CITATIONS) {
    throw new Error('Heuristic checker response does not match the requested route or result schema')
  }
  let priorEnd = -1
  const citations = output.citations.map((citation) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation) ||
      !exactKeys(citation, ['start', 'end', 'quote']) || !Number.isSafeInteger(citation.start) ||
      !Number.isSafeInteger(citation.end) || citation.start! < 0 || citation.end! <= citation.start! ||
      citation.end! > request.policyText.length || citation.start! < priorEnd ||
      !boundedText(citation.quote, 100_000) ||
      request.policyText.slice(citation.start, citation.end) !== citation.quote) {
      throw new Error('Heuristic checker citation does not match the supplied policy text')
    }
    priorEnd = citation.end
    return { start: citation.start, end: citation.end, quote: citation.quote }
  })
  return {
    contractVersion: HEURISTIC_CHECK_CONTRACT_VERSION,
    runId: request.runId,
    providerId: request.providerId,
    requestedModelId: request.requestedModelId,
    executedModelId: output.executedModelId,
    verdict: output.verdict as HeuristicCheckVerdict,
    rationale: output.rationale,
    uncertainty: output.uncertainty,
    citations,
  }
}

export async function runHeuristicCheck(
  adapter: HeuristicCheckAdapter,
  request: HeuristicCheckRequest,
  signal: AbortSignal,
): Promise<HeuristicCheckOutput> {
  if (adapter.providerId !== request.providerId) throw new Error('Heuristic checker adapter route mismatch')
  if (signal.aborted) throw new DOMException('Heuristic check cancelled', 'AbortError')
  let lastValidationError: Error | null = null
  for (let attempt = 1; attempt <= HEURISTIC_CHECK_MAX_ATTEMPTS; attempt += 1) {
    const value = await adapter.evaluate(Object.freeze(structuredClone(request)), signal, attempt)
    if (signal.aborted) throw new DOMException('Heuristic check cancelled', 'AbortError')
    try {
      return validateHeuristicCheckOutput(request, value)
    } catch (error) {
      lastValidationError = error instanceof Error ? error : new Error('Heuristic checker output validation failed')
    }
  }
  throw new Error(`Heuristic checker returned invalid structured output after ${HEURISTIC_CHECK_MAX_ATTEMPTS} attempts: ${lastValidationError?.message}`)
}
