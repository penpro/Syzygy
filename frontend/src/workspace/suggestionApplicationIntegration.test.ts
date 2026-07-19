import { $createParagraphNode, $createTextNode, $getRoot, $nodesOfType, createEditor } from 'lexical'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { registerAutomationEditor } from './editorAutomation'
import { getAutomationEditorController } from './editorAutomationRegistry'
import { applyAcceptedSuggestion, suggestionSourceRevision } from './suggestionApplication'
import { createSuggestion, decideSuggestion } from './suggestionModel'
import { PolicyBlockNode } from './nodes/PolicyBlockNode'
import { $createSuggestionNode, SuggestionNode } from './nodes/SuggestionNode'

describe('accepted suggestion live editor integration', () => {
  it('replaces the live Lexical review card with one stable review policy node', () => {
    const editor = createEditor({
      namespace: 'suggestion-application-integration',
      nodes: [PolicyBlockNode, SuggestionNode],
      onError(error) { throw error },
    })
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('Existing policy context.')))
    }, { discrete: true })
    const unregister = registerAutomationEditor('suggestion-application-project', editor)
    try {
      const controller = getAutomationEditorController('suggestion-application-project')
      const sourceRevision = suggestionSourceRevision(controller.read().blocks)
      const doc = new Y.Doc()
      const discussions = doc.getMap('discussions')
      const proposal = createSuggestion(discussions, {
        suggestionId: 'appeal-policy',
        eventId: 'appeal-proposal',
        content: 'Every denial must include an appeal path.',
        sourceDocumentRevision: sourceRevision,
        authorId: 'researcher-author',
        authorDisplayName: 'Researcher Author',
        timestamp: 1,
      })
      const accepted = decideSuggestion(discussions, {
        suggestionId: proposal.id,
        eventId: 'appeal-accepted',
        expectedProposalEventId: proposal.proposal.eventId,
        decision: 'accepted',
        reviewerId: 'researcher-reviewer',
        reviewerDisplayName: 'Researcher Reviewer',
        timestamp: 2,
      })
      editor.update(() => $getRoot().append($createSuggestionNode(proposal.id)), {
        discrete: true,
        tag: 'syzygy-suggestion-propose',
      })

      const current = controller.read()
      const applied = applyAcceptedSuggestion(discussions, controller, {
        suggestionId: proposal.id,
        expectedProposalEventId: proposal.proposal.eventId,
        expectedDecisionEventId: accepted.decisions[0].eventId,
        expectedDocumentRevision: current.revision,
      })
      expect(applied.blocks).toEqual([
        { kind: 'paragraph', text: 'Existing policy context.' },
        {
          kind: 'policy',
          text: 'Every denial must include an appeal path.',
          policyId: 'appeal-policy',
          status: 'review',
        },
      ])
      editor.getEditorState().read(() => {
        expect($nodesOfType(SuggestionNode)).toHaveLength(0)
        expect($nodesOfType(PolicyBlockNode).map((node) => ({
          id: node.getPolicyId(), status: node.getStatus(), text: node.getTextContent(),
        }))).toEqual([{
          id: 'appeal-policy', status: 'review', text: 'Every denial must include an appeal path.',
        }])
      })
    } finally {
      unregister()
    }
  })
})
