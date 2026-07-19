import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { AutomationDocumentBlock, AutomationEditorController } from './editorAutomationRegistry'
import { applyAcceptedSuggestion, suggestionSourceRevision } from './suggestionApplication'
import { createSuggestion, decideSuggestion } from './suggestionModel'

const clone = <T,>(value: T): T => structuredClone(value)

function controller(initial: AutomationDocumentBlock[], initialRevision = 'document-revision-1') {
  let blocks = clone(initial)
  let revision = initialRevision
  let replacements = 0
  const value: AutomationEditorController = {
    projectId: 'suggestion-application-project',
    read: () => ({ projectId: value.projectId, revision, blocks: clone(blocks), text: '', scenarioIds: [] }),
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

function suggestion(status: 'pending' | 'accepted' | 'rejected', sourceBlocks: AutomationDocumentBlock[]) {
  const doc = new Y.Doc()
  const discussions = doc.getMap('discussions')
  const record = createSuggestion(discussions, {
    suggestionId: 'appeal-policy',
    eventId: 'appeal-proposal',
    content: 'Every denial must include an appeal path.',
    sourceDocumentRevision: suggestionSourceRevision(sourceBlocks),
    authorId: 'researcher-author',
    authorDisplayName: 'Researcher Author',
    timestamp: 1,
  })
  if (status === 'pending') return { discussions, record, decisionId: null }
  const decisionId = `${status}-decision`
  const decided = decideSuggestion(discussions, {
    suggestionId: record.id,
    eventId: decisionId,
    expectedProposalEventId: record.proposal.eventId,
    decision: status,
    reviewerId: 'researcher-reviewer',
    reviewerDisplayName: 'Researcher Reviewer',
    timestamp: 2,
  })
  return { discussions, record: decided, decisionId }
}

const base: AutomationDocumentBlock[] = [
  { kind: 'heading1', text: 'Appeals' },
  { kind: 'paragraph', text: 'Current policy context.' },
]
const withMarker = (): AutomationDocumentBlock[] => [
  ...base,
  { kind: 'suggestion', text: '', suggestionId: 'appeal-policy' },
]

describe('accepted policy suggestion application', () => {
  it('replaces exactly one accepted marker with a linked review policy block', () => {
    const accepted = suggestion('accepted', base)
    const editor = controller(withMarker())
    const result = applyAcceptedSuggestion(accepted.discussions, editor.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: accepted.decisionId!,
      expectedDocumentRevision: editor.value.read().revision,
    })
    expect(editor.replacementCount()).toBe(1)
    expect(result.blocks).toEqual([
      ...base,
      {
        kind: 'policy',
        text: 'Every denial must include an appeal path.',
        policyId: 'appeal-policy',
        status: 'review',
      },
    ])
  })

  it('rejects stale editor and stale semantic source revisions without mutation', () => {
    const accepted = suggestion('accepted', base)
    const editor = controller(withMarker())
    expect(() => applyAcceptedSuggestion(accepted.discussions, editor.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: accepted.decisionId!,
      expectedDocumentRevision: 'stale-document-revision',
    })).toThrow('draft changed')
    expect(editor.replacementCount()).toBe(0)

    const changed = controller([{ kind: 'paragraph', text: 'Concurrent policy edit.' }, withMarker()[2]])
    expect(() => applyAcceptedSuggestion(accepted.discussions, changed.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: accepted.decisionId!,
      expectedDocumentRevision: changed.value.read().revision,
    })).toThrow('content changed')
    expect(changed.replacementCount()).toBe(0)
  })

  it('requires an exact accepted proposal and decision and refuses pending or rejected state', () => {
    for (const state of ['pending', 'rejected'] as const) {
      const candidate = suggestion(state, base)
      const editor = controller(withMarker())
      expect(() => applyAcceptedSuggestion(candidate.discussions, editor.value, {
        suggestionId: candidate.record.id,
        expectedProposalEventId: candidate.record.proposal.eventId,
        expectedDecisionEventId: candidate.decisionId ?? 'missing-decision',
        expectedDocumentRevision: editor.value.read().revision,
      })).toThrow('accepted, non-conflicted')
      expect(editor.replacementCount()).toBe(0)
    }
    const accepted = suggestion('accepted', base)
    const editor = controller(withMarker())
    expect(() => applyAcceptedSuggestion(accepted.discussions, editor.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: 'wrong-proposal',
      expectedDecisionEventId: accepted.decisionId!,
      expectedDocumentRevision: editor.value.read().revision,
    })).toThrow('proposal changed')
    expect(() => applyAcceptedSuggestion(accepted.discussions, editor.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: 'wrong-decision',
      expectedDocumentRevision: editor.value.read().revision,
    })).toThrow('decision changed')
    expect(editor.replacementCount()).toBe(0)
  })

  it('rejects missing, duplicate, or colliding marker identity before mutation', () => {
    const accepted = suggestion('accepted', base)
    const apply = (blocks: AutomationDocumentBlock[]) => {
      const editor = controller(blocks)
      expect(() => applyAcceptedSuggestion(accepted.discussions, editor.value, {
        suggestionId: accepted.record.id,
        expectedProposalEventId: accepted.record.proposal.eventId,
        expectedDecisionEventId: accepted.decisionId!,
        expectedDocumentRevision: editor.value.read().revision,
      })).toThrow()
      expect(editor.replacementCount()).toBe(0)
    }
    apply(base)
    apply([...withMarker(), withMarker()[2]])
    apply([...withMarker(), { kind: 'policy', text: 'Existing.', policyId: 'appeal-policy', status: 'draft' }])
  })

  it('lets the editor revision guard stop a race between preparation and replacement', () => {
    const accepted = suggestion('accepted', base)
    const editor = controller(withMarker())
    const originalRead = editor.value.read
    let reads = 0
    editor.value.read = () => {
      const snapshot = originalRead()
      reads += 1
      if (reads === 1) editor.changeRevision('concurrent-document-revision')
      return snapshot
    }
    expect(() => applyAcceptedSuggestion(accepted.discussions, editor.value, {
      suggestionId: accepted.record.id,
      expectedProposalEventId: accepted.record.proposal.eventId,
      expectedDecisionEventId: accepted.decisionId!,
      expectedDocumentRevision: 'document-revision-1',
    })).toThrow('Revision conflict')
    expect(editor.replacementCount()).toBe(0)
  })
})
