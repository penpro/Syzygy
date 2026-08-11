import { $createParagraphNode, $createTextNode, $getRoot, $nodesOfType, createEditor } from 'lexical'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getAutomationEditorController } from '../workspace/editorAutomationRegistry'
import { registerAutomationEditor } from '../workspace/editorAutomation'
import { PolicyBlockNode } from '../workspace/nodes/PolicyBlockNode'
import { applyAcceptedPluginReview } from './pluginReviewApplication'
import { createPluginReview, decidePluginReview } from './pluginReviewModel'

function runLiveApplication(operation: 'append' | 'replace') {
  const editor = createEditor({
    namespace: `plugin-review-application-${operation}`,
    nodes: [PolicyBlockNode],
    onError(error) { throw error },
  })
  editor.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode('Existing policy context.')))
  }, { discrete: true })
  const projectId = `plugin-live-${operation}`
  const unregister = registerAutomationEditor(projectId, editor)
  try {
    const controller = getAutomationEditorController(projectId)
    const source = controller.read()
    const doc = new Y.Doc({ guid: projectId })
    const discussions = doc.getMap('discussions')
    const proposal = createPluginReview(discussions, {
      reviewId: `live-review-${operation}`,
      eventId: `live-proposal-${operation}`,
      pluginVersion: '1.0.0',
      componentSha256: 'a'.repeat(64),
      contributionId: 'review',
      proposal: {
        proposalVersion: 1,
        proposalId: `live-plugin-proposal-${operation}`,
        pluginId: 'org.example.live-apply',
        projectId,
        expectedRevision: source.revision,
        summary: `Live ${operation}`,
        content: 'Every conclusion must retain its evidence.',
        operation,
      },
      runnerId: 'runner-device',
      runnerDisplayName: 'Runner device',
      timestamp: 1,
    })
    const accepted = decidePluginReview(discussions, {
      reviewId: proposal.id,
      eventId: `live-decision-${operation}`,
      expectedProposalEventId: proposal.proposal.eventId,
      decision: 'accepted',
      reviewerId: 'reviewer-device',
      reviewerDisplayName: 'Reviewer device',
      timestamp: 2,
    })
    const result = applyAcceptedPluginReview(discussions, controller, projectId, {
      reviewId: proposal.id,
      expectedProposalEventId: proposal.proposal.eventId,
      expectedDecisionEventId: accepted.decisions[0].eventId,
      expectedDocumentRevision: source.revision,
    })
    const policies = editor.getEditorState().read(() => $nodesOfType(PolicyBlockNode).map((node) => ({
      id: node.getPolicyId(), status: node.getStatus(), text: node.getTextContent(),
    })))
    return { result, policies }
  } finally {
    unregister()
  }
}

describe('accepted plugin proposal live editor integration', () => {
  it('appends one linked policy node without dropping the existing draft', () => {
    const { result, policies } = runLiveApplication('append')
    expect(result.blocks).toEqual([
      { kind: 'paragraph', text: 'Existing policy context.' },
      {
        kind: 'policy', text: 'Every conclusion must retain its evidence.',
        policyId: 'live-review-append', status: 'review',
      },
    ])
    expect(policies).toEqual([{
      id: 'live-review-append', status: 'review', text: 'Every conclusion must retain its evidence.',
    }])
  })

  it('replaces the live draft with exactly one linked policy node', () => {
    const { result, policies } = runLiveApplication('replace')
    expect(result.blocks).toEqual([{
      kind: 'policy', text: 'Every conclusion must retain its evidence.',
      policyId: 'live-review-replace', status: 'review',
    }])
    expect(policies).toEqual([{
      id: 'live-review-replace', status: 'review', text: 'Every conclusion must retain its evidence.',
    }])
  })
})
