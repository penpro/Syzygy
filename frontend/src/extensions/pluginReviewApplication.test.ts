import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { AutomationDocumentBlock, AutomationEditorController } from '../workspace/editorAutomationRegistry'
import { applyAcceptedPluginReview } from './pluginReviewApplication'
import { createPluginReview, decidePluginReview } from './pluginReviewModel'

const clone = <T,>(value: T): T => structuredClone(value)
const projectId = 'plugin-apply-project'

function controller(initial: AutomationDocumentBlock[], initialRevision = 'document-revision-1') {
  let blocks = clone(initial)
  let revision = initialRevision
  let replacements = 0
  const value: AutomationEditorController = {
    projectId,
    read: () => ({ projectId, revision, blocks: clone(blocks), text: '', scenarioIds: [] }),
    replace: () => { throw new Error('unexpected text replacement') },
    append: () => { throw new Error('unexpected append') },
    replaceBlocks: (expectedRevision, next) => {
      if (expectedRevision !== revision) throw new Error('Revision conflict')
      blocks = clone(next)
      replacements += 1
      revision = `document-revision-${replacements + 1}`
      return value.read()
    },
  }
  return { value, replacementCount: () => replacements, changeRevision: (next: string) => { revision = next } }
}

function review(
  operation: 'append' | 'replace',
  decision: 'accepted' | 'rejected' | null = 'accepted',
) {
  const doc = new Y.Doc()
  const discussions = doc.getMap('discussions')
  const proposed = createPluginReview(discussions, {
    reviewId: `review-${operation}`,
    eventId: `proposal-${operation}`,
    pluginVersion: '1.0.0',
    componentSha256: 'a'.repeat(64),
    contributionId: 'review',
    proposal: {
      proposalVersion: 1,
      proposalId: `plugin-proposal-${operation}`,
      pluginId: 'org.example.apply-review',
      projectId,
      expectedRevision: 'document-revision-1',
      summary: `${operation} accepted policy`,
      content: 'Every decision must cite its evidence.',
      operation,
    },
    runnerId: 'runner-device',
    runnerDisplayName: 'Runner device',
    timestamp: 1,
  })
  if (!decision) return { discussions, record: proposed, decisionId: 'missing-decision' }
  const decisionId = `${decision}-${operation}`
  return {
    discussions,
    record: decidePluginReview(discussions, {
      reviewId: proposed.id,
      eventId: decisionId,
      expectedProposalEventId: proposed.proposal.eventId,
      decision,
      reviewerId: 'reviewer-device',
      reviewerDisplayName: 'Reviewer device',
      timestamp: 2,
    }),
    decisionId,
  }
}

const base: AutomationDocumentBlock[] = [
  { kind: 'heading1', text: 'Evidence policy' },
  { kind: 'paragraph', text: 'Existing policy text.' },
]

const apply = (candidate: ReturnType<typeof review>, editor = controller(base)) => ({
  editor,
  result: () => applyAcceptedPluginReview(candidate.discussions, editor.value, projectId, {
    reviewId: candidate.record.id,
    expectedProposalEventId: candidate.record.proposal.eventId,
    expectedDecisionEventId: candidate.decisionId,
    expectedDocumentRevision: editor.value.read().revision,
  }),
})

describe('accepted plugin proposal application', () => {
  it('appends one exact linked review policy while retaining every existing block', () => {
    const candidate = review('append')
    const applied = apply(candidate)
    expect(applied.result().blocks).toEqual([
      ...base,
      {
        kind: 'policy',
        text: candidate.record.proposal.content,
        policyId: candidate.record.id,
        status: 'review',
      },
    ])
    expect(applied.editor.replacementCount()).toBe(1)
  })

  it('replaces the entire draft with one exact linked review policy', () => {
    const candidate = review('replace')
    const applied = apply(candidate)
    expect(applied.result().blocks).toEqual([{
      kind: 'policy',
      text: candidate.record.proposal.content,
      policyId: candidate.record.id,
      status: 'review',
    }])
    expect(applied.editor.replacementCount()).toBe(1)
  })

  it('rejects stale document state and an editor race with zero writes', () => {
    const candidate = review('append')
    const stale = controller(base, 'document-revision-2')
    expect(() => apply(candidate, stale).result()).toThrow('changed since')
    expect(stale.replacementCount()).toBe(0)

    const raced = controller(base)
    const originalRead = raced.value.read
    let reads = 0
    raced.value.read = () => {
      const snapshot = originalRead()
      reads += 1
      if (reads === 2) raced.changeRevision('concurrent-document-revision')
      return snapshot
    }
    expect(() => apply(candidate, raced).result()).toThrow('Revision conflict')
    expect(raced.replacementCount()).toBe(0)
  })

  it('requires the exact accepted proposal and decision and refuses rejected or conflicted state', () => {
    const rejected = review('append', 'rejected')
    expect(() => apply(rejected).result()).toThrow('accepted, non-conflicted')
    const pending = review('append', null)
    expect(() => apply(pending).result()).toThrow('accepted, non-conflicted')
    const conflictBase = review('append', null)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(conflictBase.discussions.doc!))
    const acceptedConflict = decidePluginReview(conflictBase.discussions, {
      reviewId: conflictBase.record.id,
      eventId: 'conflicting-acceptance',
      expectedProposalEventId: conflictBase.record.proposal.eventId,
      decision: 'accepted',
      reviewerId: 'first-reviewer',
      reviewerDisplayName: 'First reviewer',
      timestamp: 2,
    })
    decidePluginReview(peer.getMap('discussions'), {
      reviewId: conflictBase.record.id,
      eventId: 'conflicting-rejection',
      expectedProposalEventId: conflictBase.record.proposal.eventId,
      decision: 'rejected',
      reviewerId: 'second-reviewer',
      reviewerDisplayName: 'Second reviewer',
      timestamp: 3,
    })
    Y.applyUpdate(conflictBase.discussions.doc!, Y.encodeStateAsUpdate(peer))
    expect(() => apply({
      discussions: conflictBase.discussions,
      record: acceptedConflict,
      decisionId: 'conflicting-acceptance',
    }).result()).toThrow('accepted, non-conflicted')

    const accepted = review('append')
    const editor = controller(base)
    expect(() => applyAcceptedPluginReview(accepted.discussions, editor.value, projectId, {
      reviewId: accepted.record.id,
      expectedProposalEventId: 'wrong-proposal',
      expectedDecisionEventId: accepted.decisionId,
      expectedDocumentRevision: editor.value.read().revision,
    })).toThrow('proposal changed')
    expect(() => applyAcceptedPluginReview(accepted.discussions, editor.value, projectId, {
      reviewId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: 'wrong-decision',
      expectedDocumentRevision: editor.value.read().revision,
    })).toThrow('decision changed')
    expect(editor.replacementCount()).toBe(0)
  })

  it('rejects project mismatch and a replay/collision before mutation', () => {
    const candidate = review('append')
    const editor = controller([
      ...base,
      { kind: 'policy', text: 'Already applied.', policyId: candidate.record.id, status: 'review' },
    ])
    editor.changeRevision('document-revision-1')
    expect(() => apply(candidate, editor).result()).toThrow('already exists')
    expect(editor.replacementCount()).toBe(0)
    expect(() => applyAcceptedPluginReview(candidate.discussions, controller(base).value, 'other-project', {
      reviewId: candidate.record.id,
      expectedProposalEventId: candidate.record.proposal.eventId,
      expectedDecisionEventId: candidate.decisionId,
      expectedDocumentRevision: 'document-revision-1',
    })).toThrow('project identity mismatch')
  })
})
