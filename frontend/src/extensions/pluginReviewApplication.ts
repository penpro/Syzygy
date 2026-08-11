import type * as Y from 'yjs'
import type {
  AutomationDocumentBlock,
  AutomationEditorController,
  AutomationEditorSnapshot,
} from '../workspace/editorAutomationRegistry'
import { readPluginReview } from './pluginReviewModel'

export interface ApplyAcceptedPluginReviewInput {
  reviewId: string
  expectedProposalEventId: string
  expectedDecisionEventId: string
  expectedDocumentRevision: string
}

const stableId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)

const exactBlock = (left: AutomationDocumentBlock, right: AutomationDocumentBlock) =>
  JSON.stringify(left) === JSON.stringify(right)

/**
 * Apply an already accepted shared plugin proposal through the live editor's exact revision guard.
 * The plugin never receives this authority; only the separate human/MCP apply action calls it.
 */
export function applyAcceptedPluginReview(
  discussions: Y.Map<unknown>,
  controller: AutomationEditorController,
  projectId: string,
  input: ApplyAcceptedPluginReviewInput,
): AutomationEditorSnapshot {
  if (!stableId(projectId) || !stableId(input.reviewId) ||
    !stableId(input.expectedProposalEventId) || !stableId(input.expectedDecisionEventId) ||
    typeof input.expectedDocumentRevision !== 'string' || !input.expectedDocumentRevision.trim() ||
    input.expectedDocumentRevision.length > 500 || input.expectedDocumentRevision.includes('\u0000')) {
    throw new Error('Plugin proposal application request is invalid')
  }
  const review = readPluginReview(discussions, input.reviewId)
  if (!review || review.proposal.projectId !== projectId || controller.projectId !== projectId) {
    throw new Error('Plugin proposal project identity mismatch')
  }
  if (review.proposal.eventId !== input.expectedProposalEventId) {
    throw new Error('Plugin proposal changed before application')
  }
  if (review.status !== 'accepted') {
    throw new Error('Only an accepted, non-conflicted plugin proposal can be applied')
  }
  const decision = review.decisions.find(({ eventId }) => eventId === input.expectedDecisionEventId)
  if (!decision || decision.decision !== 'accepted' ||
    decision.proposalEventId !== review.proposal.eventId) {
    throw new Error('Accepted plugin decision changed before application')
  }

  const current = controller.read()
  if (current.projectId !== projectId || current.revision !== input.expectedDocumentRevision) {
    throw new Error('The policy draft changed before plugin proposal application')
  }
  if (review.proposal.expectedRevision !== current.revision) {
    throw new Error('The policy draft changed since this plugin proposal was created')
  }
  if (current.blocks.some((block) => block.kind === 'policy' && block.policyId === review.id)) {
    throw new Error('The linked plugin proposal policy identity already exists')
  }
  const linkedPolicy: AutomationDocumentBlock = {
    kind: 'policy',
    text: review.proposal.content,
    policyId: review.id,
    status: 'review',
  }
  const next = review.proposal.operation === 'append'
    ? [...current.blocks.map((block) => structuredClone(block)), linkedPolicy]
    : [linkedPolicy]
  const result = controller.replaceBlocks(input.expectedDocumentRevision, next)
  const linked = result.blocks.filter((block) =>
    block.kind === 'policy' && block.policyId === review.id)
  const shapeMatches = review.proposal.operation === 'append'
    ? result.blocks.length === current.blocks.length + 1 &&
      current.blocks.every((block, index) => exactBlock(block, result.blocks[index]))
    : result.blocks.length === 1
  if (result.projectId !== projectId || !shapeMatches || linked.length !== 1 ||
    linked[0].text !== review.proposal.content || linked[0].status !== 'review') {
    throw new Error('The editor did not confirm exact plugin proposal application')
  }
  return result
}
