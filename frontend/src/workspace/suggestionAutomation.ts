import type * as Y from 'yjs'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import {
  createSuggestion,
  decideSuggestion,
  type SuggestionDecisionKind,
  type SuggestionProposalEvent,
  type SuggestionDecisionEvent,
  type SuggestionSourceKind,
} from './suggestionModel'

export interface CreateAutomationSuggestionInput {
  expectedResearchRevision: string
  suggestionId: string
  eventId: string
  content: string
  sourceDocumentRevision: string
  participantId: string
  displayName: string
  timestamp: number
  sourceKind: SuggestionSourceKind
  providerId: string | null
  modelId: string | null
  runId: string | null
}

export interface DecideAutomationSuggestionInput {
  expectedResearchRevision: string
  suggestionId: string
  eventId: string
  expectedProposalEventId: string
  decision: SuggestionDecisionKind
  participantId: string
  displayName: string
  timestamp: number
}

function guardedDiscussions(
  document: Y.Doc,
  expectedProjectId: string,
  expectedResearchRevision: string,
) {
  const { metadata, discussions } = getProjectSharedTypes(document)
  if (metadata.get('projectId') !== expectedProjectId) {
    throw new Error('Live collaboration document project identity does not match')
  }
  if (projectStateFingerprint(document) !== expectedResearchRevision) {
    throw new Error('Research state revision conflict')
  }
  return discussions
}

export function createAutomationSuggestion(
  document: Y.Doc,
  expectedProjectId: string,
  input: CreateAutomationSuggestionInput,
): { event: SuggestionProposalEvent; status: 'pending' } {
  const discussions = guardedDiscussions(document, expectedProjectId, input.expectedResearchRevision)
  const suggestion = createSuggestion(discussions, {
    suggestionId: input.suggestionId,
    eventId: input.eventId,
    content: input.content,
    sourceDocumentRevision: input.sourceDocumentRevision,
    authorId: input.participantId,
    authorDisplayName: input.displayName,
    timestamp: input.timestamp,
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    modelId: input.modelId,
    runId: input.runId,
  })
  return { event: suggestion.proposal, status: 'pending' }
}

export function decideAutomationSuggestion(
  document: Y.Doc,
  expectedProjectId: string,
  input: DecideAutomationSuggestionInput,
): { event: SuggestionDecisionEvent; status: SuggestionDecisionKind } {
  const discussions = guardedDiscussions(document, expectedProjectId, input.expectedResearchRevision)
  const suggestion = decideSuggestion(discussions, {
    suggestionId: input.suggestionId,
    eventId: input.eventId,
    expectedProposalEventId: input.expectedProposalEventId,
    decision: input.decision,
    reviewerId: input.participantId,
    reviewerDisplayName: input.displayName,
    timestamp: input.timestamp,
  })
  const event = suggestion.decisions.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Suggestion decision was not retained')
  return { event, status: input.decision }
}
