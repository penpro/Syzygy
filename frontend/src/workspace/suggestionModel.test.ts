import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createSuggestion,
  decideSuggestion,
  inspectSuggestions,
  listSuggestions,
  readSuggestionEvent,
  readSuggestion,
  suggestionEventSha256,
  type CreateSuggestionInput,
} from './suggestionModel'

const proposal = (overrides: Partial<CreateSuggestionInput> = {}): CreateSuggestionInput => ({
  suggestionId: 'suggestion-a',
  eventId: 'proposal-a',
  content: 'Add an explicit appeal process.',
  sourceDocumentRevision: 'lexical-session-1-abcd1234',
  authorId: 'researcher-a',
  authorDisplayName: 'Researcher A',
  timestamp: 10,
  ...overrides,
})

const decide = (
  discussions: Y.Map<unknown>,
  decision: 'accepted' | 'rejected',
  eventId: string,
  overrides: Partial<Parameters<typeof decideSuggestion>[1]> = {},
) => decideSuggestion(discussions, {
  suggestionId: 'suggestion-a',
  eventId,
  expectedProposalEventId: 'proposal-a',
  decision,
  reviewerId: 'reviewer-a',
  reviewerDisplayName: 'Reviewer A',
  timestamp: 20,
  ...overrides,
})

describe('collaborative suggestion decisions', () => {
  it('hashes exact proposal and decision envelopes and reads only retained valid events', async () => {
    const discussions = new Y.Doc().getMap('project:discussions')
    const created = createSuggestion(discussions, proposal())
    const proposalEvent = readSuggestionEvent(discussions, created.id, created.proposal.eventId)
    expect(proposalEvent).toEqual(created.proposal)
    const proposalHash = await suggestionEventSha256(created.proposal)
    await expect(suggestionEventSha256({
      ...created.proposal,
      content: `${created.content} Tampered`,
    })).resolves.not.toBe(proposalHash)

    const accepted = decide(discussions, 'accepted', 'decision-hash')
    const decisionEvent = readSuggestionEvent(discussions, accepted.id, 'decision-hash')
    expect(decisionEvent).toEqual(accepted.decisions[0])
    await expect(suggestionEventSha256(decisionEvent!)).resolves.not.toBe(proposalHash)
    expect(readSuggestionEvent(discussions, accepted.id, 'missing-event')).toBeNull()
  })

  it('previews model provenance and requires an attributed human decision without changing policy text', () => {
    const doc = new Y.Doc()
    const discussions = doc.getMap('project:discussions')
    const root = doc.get('root', Y.XmlText)
    root.insert(0, 'Existing policy text')
    const before = root.toString()

    const pending = createSuggestion(discussions, proposal({
      sourceKind: 'model',
      providerId: 'local',
      modelId: 'qwen-fixture',
      runId: 'run-fixture',
    }))
    expect(pending).toMatchObject({
      id: 'suggestion-a',
      status: 'pending',
      content: 'Add an explicit appeal process.',
      proposal: {
        sourceKind: 'model',
        providerId: 'local',
        modelId: 'qwen-fixture',
        runId: 'run-fixture',
      },
    })
    expect(root.toString()).toBe(before)

    const accepted = decide(discussions, 'accepted', 'decision-accept')
    expect(accepted.status).toBe('accepted')
    expect(accepted.decisions[0]).toMatchObject({
      reviewerId: 'reviewer-a',
      reviewerDisplayName: 'Reviewer A',
      decision: 'accepted',
    })
    expect(root.toString()).toBe(before)
  })

  it('is replay-safe and rejects stale or reused decision identity without adding events', () => {
    const discussions = new Y.Doc().getMap('project:discussions')
    createSuggestion(discussions, proposal())
    const accepted = decide(discussions, 'accepted', 'decision-a')
    expect(decide(discussions, 'accepted', 'decision-a')).toEqual(accepted)
    expect(() => decide(discussions, 'rejected', 'decision-a')).toThrow('event ID was reused')
    expect(() => decide(discussions, 'rejected', 'decision-b')).toThrow('decision conflict')
    expect(() => decide(discussions, 'accepted', 'decision-c', {
      expectedProposalEventId: 'proposal-stale',
    })).toThrow('proposal revision conflict')
    expect(readSuggestion(discussions, 'suggestion-a')?.decisions).toHaveLength(1)
  })

  it('retains concurrent opposite decisions and converges to an explicit conflict', () => {
    const left = new Y.Doc({ guid: 'suggestion-convergence' })
    const right = new Y.Doc({ guid: 'suggestion-convergence' })
    const leftDiscussions = left.getMap('project:discussions')
    const rightDiscussions = right.getMap('project:discussions')
    createSuggestion(leftDiscussions, proposal())
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))

    decide(leftDiscussions, 'accepted', 'decision-left', {
      reviewerId: 'reviewer-left', reviewerDisplayName: 'Reviewer Left', timestamp: 30,
    })
    decide(rightDiscussions, 'rejected', 'decision-right', {
      reviewerId: 'reviewer-right', reviewerDisplayName: 'Reviewer Right', timestamp: 40,
    })
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))

    const leftSuggestion = readSuggestion(leftDiscussions, 'suggestion-a')
    const rightSuggestion = readSuggestion(rightDiscussions, 'suggestion-a')
    expect(leftSuggestion).toEqual(rightSuggestion)
    expect(leftSuggestion?.status).toBe('conflicted')
    expect(leftSuggestion?.decisions.map(({ eventId }) => eventId)).toEqual(['decision-left', 'decision-right'])
    expect(inspectSuggestions(leftDiscussions)).toMatchObject({
      healthy: false,
      conflictedSuggestionIds: ['suggestion-a'],
    })
  })

  it('fails closed when disconnected peers create the same public suggestion identity', () => {
    const left = new Y.Doc({ guid: 'suggestion-root-collision' })
    const right = new Y.Doc({ guid: 'suggestion-root-collision' })
    createSuggestion(left.getMap('project:discussions'), proposal())
    createSuggestion(right.getMap('project:discussions'), proposal({
      eventId: 'proposal-other',
      content: 'A different proposal using the same public identity.',
      authorId: 'researcher-b',
      authorDisplayName: 'Researcher B',
    }))
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))

    expect(readSuggestion(left.getMap('project:discussions'), 'suggestion-a')).toBeNull()
    expect(listSuggestions(left.getMap('project:discussions'))).toEqual([])
    expect(inspectSuggestions(left.getMap('project:discussions')).invalidRecords).toBe(1)
  })

  it('rejects malformed provenance and reports hostile bucket mutation', () => {
    const discussions = new Y.Doc().getMap('project:discussions')
    expect(() => createSuggestion(discussions, proposal({
      sourceKind: 'model',
      providerId: null,
      modelId: 'model-a',
      runId: 'run-a',
    }))).toThrow('Invalid suggestion proposal')
    createSuggestion(discussions, proposal())
    const bucket = Array.from(discussions.entries()).find(([key]) => key.startsWith('suggestions:v1:'))?.[1]
    if (!(bucket instanceof Y.Map)) throw new Error('Suggestion fixture bucket missing')
    bucket.set('credentials', 'must not be accepted')
    expect(readSuggestion(discussions, 'suggestion-a')).toBeNull()
    expect(inspectSuggestions(discussions)).toMatchObject({ healthy: false, invalidRecords: 2 })
  })
})
