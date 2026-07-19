import type * as Y from 'yjs'
import type {
  AutomationDocumentBlock,
  AutomationEditorController,
  AutomationEditorSnapshot,
} from './editorAutomationRegistry'
import { readSuggestion } from './suggestionModel'

export interface ApplyAcceptedSuggestionInput {
  suggestionId: string
  expectedProposalEventId: string
  expectedDecisionEventId: string
  expectedDocumentRevision: string
}

const MAX_BLOCKS = 10_000
const MAX_CONTENT = 500_000
const stableId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
const exactKeys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')

function canonicalBlock(block: AutomationDocumentBlock): AutomationDocumentBlock {
  if (!block || typeof block !== 'object' || typeof block.text !== 'string' || block.text.includes('\u0000')) {
    throw new Error('Suggestion source contains an invalid document block')
  }
  if (block.kind === 'policy') {
    if (!exactKeys(block, ['kind', 'text', 'policyId', 'status']) || !stableId(block.policyId) ||
      !block.status || !['draft', 'review', 'approved'].includes(block.status)) {
      throw new Error('Suggestion source contains an invalid policy block')
    }
    return { kind: 'policy', text: block.text, policyId: block.policyId, status: block.status }
  }
  if (block.kind === 'spotlight') {
    if (!exactKeys(block, ['kind', 'text', 'scenarioId']) || block.text !== '' || !stableId(block.scenarioId)) {
      throw new Error('Suggestion source contains an invalid scenario spotlight')
    }
    return { kind: 'spotlight', text: '', scenarioId: block.scenarioId }
  }
  if (block.kind === 'suggestion') {
    if (!exactKeys(block, ['kind', 'text', 'suggestionId']) || block.text !== '' || !stableId(block.suggestionId)) {
      throw new Error('Suggestion source contains an invalid suggestion marker')
    }
    return { kind: 'suggestion', text: '', suggestionId: block.suggestionId }
  }
  if (!['heading1', 'heading2', 'quote', 'paragraph'].includes(block.kind) ||
    !exactKeys(block, ['kind', 'text'])) {
    throw new Error('Suggestion source contains an unsupported document block')
  }
  return { kind: block.kind, text: block.text }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable semantic revision that deliberately excludes review-card markers. */
export function suggestionSourceRevision(blocks: AutomationDocumentBlock[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_BLOCKS) {
    throw new Error('Suggestion source requires a bounded non-empty document')
  }
  let contentLength = 0
  const policyContent = blocks.map(canonicalBlock).filter(({ kind, text }) => {
    contentLength += text.length
    if (contentLength > MAX_CONTENT) throw new Error('Suggestion source exceeds the document content limit')
    return kind !== 'suggestion'
  })
  return `policy-content-v1-${fnv1a(JSON.stringify(policyContent))}`
}

export function applyAcceptedSuggestion(
  discussions: Y.Map<unknown>,
  controller: AutomationEditorController,
  input: ApplyAcceptedSuggestionInput,
): AutomationEditorSnapshot {
  if (!stableId(input.suggestionId) || !stableId(input.expectedProposalEventId) ||
    !stableId(input.expectedDecisionEventId) || typeof input.expectedDocumentRevision !== 'string' ||
    !input.expectedDocumentRevision.trim() || input.expectedDocumentRevision.length > 500 ||
    input.expectedDocumentRevision.includes('\u0000')) {
    throw new Error('Suggestion application request is invalid')
  }
  const suggestion = readSuggestion(discussions, input.suggestionId)
  if (!suggestion) throw new Error('Suggestion is missing or invalid')
  if (suggestion.proposal.eventId !== input.expectedProposalEventId) {
    throw new Error('Suggestion proposal changed before application')
  }
  if (suggestion.status !== 'accepted') {
    throw new Error('Only an accepted, non-conflicted suggestion can be applied')
  }
  const decision = suggestion.decisions.find(({ eventId }) => eventId === input.expectedDecisionEventId)
  if (!decision || decision.decision !== 'accepted' || decision.proposalEventId !== suggestion.proposal.eventId) {
    throw new Error('Accepted suggestion decision changed before application')
  }

  const current = controller.read()
  if (current.revision !== input.expectedDocumentRevision) {
    throw new Error('The policy draft changed before suggestion application')
  }
  if (suggestionSourceRevision(current.blocks) !== suggestion.sourceDocumentRevision) {
    throw new Error('The policy content changed since this suggestion was proposed')
  }
  const markerIndexes = current.blocks.flatMap((block, index) =>
    block.kind === 'suggestion' && block.suggestionId === suggestion.id ? [index] : [])
  if (markerIndexes.length !== 1) {
    throw new Error('The accepted suggestion must appear exactly once in the current draft')
  }
  if (current.blocks.some((block) => block.kind === 'policy' && block.policyId === suggestion.id)) {
    throw new Error('The accepted suggestion policy identity already exists')
  }
  const target = markerIndexes[0]
  const next = current.blocks.map((block, index): AutomationDocumentBlock => index === target ? {
    kind: 'policy',
    text: suggestion.content,
    policyId: suggestion.id,
    status: 'review',
  } : canonicalBlock(block))
  suggestionSourceRevision(next)
  const result = controller.replaceBlocks(input.expectedDocumentRevision, next)
  const applied = result.blocks.filter((block) => block.kind === 'policy' && block.policyId === suggestion.id)
  const remaining = result.blocks.filter((block) => block.kind === 'suggestion' && block.suggestionId === suggestion.id)
  if (applied.length !== 1 || applied[0].text !== suggestion.content || applied[0].status !== 'review' || remaining.length) {
    throw new Error('The editor did not confirm exact suggestion application')
  }
  return result
}
