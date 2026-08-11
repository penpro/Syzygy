import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import { createAutomationSuggestion, decideAutomationSuggestion } from './suggestionAutomation'
import { readSuggestion } from './suggestionModel'

const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'suggestion-automation-project',
  documentId: 'suggestion-automation-document',
  title: 'Suggestion automation',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}

describe('suggestion automation', () => {
  it('requires exact project/research revisions and retains proposal and decision events', () => {
    const document = createProjectDocument(manifest)
    const discussions = getProjectSharedTypes(document).discussions
    const revision = projectStateFingerprint(document)
    const base = {
      expectedResearchRevision: revision,
      suggestionId: 'suggestion-1',
      eventId: 'proposal-1',
      content: 'Add an appeal path.',
      sourceDocumentRevision: 'draft-revision-1',
      participantId: 'participant-a',
      displayName: 'Alice',
      timestamp: 2,
      sourceKind: 'human' as const,
      providerId: null,
      modelId: null,
      runId: null,
    }
    expect(() => createAutomationSuggestion(document, 'wrong-project', base)).toThrow(
      'project identity does not match',
    )
    expect(() => createAutomationSuggestion(document, manifest.id, {
      ...base, expectedResearchRevision: 'stale',
    })).toThrow('Research state revision conflict')
    expect(readSuggestion(discussions, base.suggestionId)).toBeNull()

    const created = createAutomationSuggestion(document, manifest.id, base)
    expect(created).toMatchObject({ status: 'pending', event: { eventId: 'proposal-1' } })
    const afterCreate = projectStateFingerprint(document)
    expect(() => decideAutomationSuggestion(document, manifest.id, {
      expectedResearchRevision: revision,
      suggestionId: base.suggestionId,
      eventId: 'decision-stale',
      expectedProposalEventId: base.eventId,
      decision: 'accepted',
      participantId: 'participant-b',
      displayName: 'Bob',
      timestamp: 3,
    })).toThrow('Research state revision conflict')

    const decided = decideAutomationSuggestion(document, manifest.id, {
      expectedResearchRevision: afterCreate,
      suggestionId: base.suggestionId,
      eventId: 'decision-1',
      expectedProposalEventId: base.eventId,
      decision: 'accepted',
      participantId: 'participant-b',
      displayName: 'Bob',
      timestamp: 3,
    })
    expect(decided).toMatchObject({
      status: 'accepted',
      event: { eventId: 'decision-1', reviewerId: 'participant-b' },
    })
    expect(readSuggestion(discussions, base.suggestionId)?.status).toBe('accepted')
  })
})
