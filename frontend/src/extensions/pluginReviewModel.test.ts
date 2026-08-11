import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createPluginReview,
  createPluginReviews,
  decidePluginReview,
  inspectPluginReviews,
  listPluginReviews,
  readPluginReview,
} from './pluginReviewModel'

const proposal = {
  proposalVersion: 1 as const,
  proposalId: 'guest-proposal',
  pluginId: 'org.example.fixture',
  projectId: 'project-1',
  expectedRevision: 'revision-1',
  summary: 'Add a review note',
  content: 'Review note',
  operation: 'append' as const,
}

const createInput = {
  reviewId: 'review-1',
  eventId: 'event-proposal',
  pluginVersion: '1.0.0',
  componentSha256: 'a'.repeat(64),
  contributionId: 'review',
  proposal,
  runnerId: 'researcher-1',
  runnerDisplayName: 'Researcher One',
  timestamp: 1,
}

describe('collaborative plugin review ledger', () => {
  it('retains exact plugin provenance and starts pending without mutating another shared type', () => {
    const doc = new Y.Doc()
    const discussions = doc.getMap('project:discussions')
    const editor = doc.getText('root')
    editor.insert(0, 'unchanged')
    const before = editor.toString()
    const review = createPluginReview(discussions, createInput)
    expect(review).toMatchObject({
      id: 'review-1', status: 'pending', proposal: {
        pluginId: 'org.example.fixture', componentSha256: 'a'.repeat(64), expectedRevision: 'revision-1',
      },
    })
    expect(editor.toString()).toBe(before)
    expect(inspectPluginReviews(discussions)).toMatchObject({ healthy: true, reviewCount: 1, pendingCount: 1 })
  })

  it('records an exact accept or reject decision without applying proposal content', () => {
    const doc = new Y.Doc()
    const discussions = doc.getMap('project:discussions')
    createPluginReview(discussions, createInput)
    const review = decidePluginReview(discussions, {
      reviewId: 'review-1', eventId: 'decision-1', expectedProposalEventId: 'event-proposal',
      decision: 'accepted', reviewerId: 'reviewer-1', reviewerDisplayName: 'Reviewer', timestamp: 2,
    })
    expect(review.status).toBe('accepted')
    expect(doc.getText('root').toString()).toBe('')
    expect(() => decidePluginReview(discussions, {
      reviewId: 'review-1', eventId: 'decision-2', expectedProposalEventId: 'stale',
      decision: 'rejected', reviewerId: 'reviewer-1', reviewerDisplayName: 'Reviewer', timestamp: 3,
    })).toThrow('proposal revision conflict')
  })

  it('preflights a proposal batch so a retained collision writes nothing', () => {
    const doc = new Y.Doc()
    const discussions = doc.getMap('project:discussions')
    createPluginReview(discussions, createInput)
    const before = Y.encodeStateVector(doc)
    expect(() => createPluginReviews(discussions, [
      { ...createInput, reviewId: 'review-2', eventId: 'event-2' },
      { ...createInput, reviewId: 'review-1', eventId: 'event-3' },
    ])).toThrow('conflicts with retained history')
    expect(Y.encodeStateVector(doc)).toEqual(before)
    expect(listPluginReviews(discussions)).toHaveLength(1)
  })

  it('converges disconnected reviews and makes conflicting decisions visible', () => {
    const left = new Y.Doc()
    const right = new Y.Doc()
    createPluginReview(left.getMap('project:discussions'), createInput)
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
    decidePluginReview(left.getMap('project:discussions'), {
      reviewId: 'review-1', eventId: 'decision-left', expectedProposalEventId: 'event-proposal',
      decision: 'accepted', reviewerId: 'left-user', reviewerDisplayName: 'Left', timestamp: 2,
    })
    decidePluginReview(right.getMap('project:discussions'), {
      reviewId: 'review-1', eventId: 'decision-right', expectedProposalEventId: 'event-proposal',
      decision: 'rejected', reviewerId: 'right-user', reviewerDisplayName: 'Right', timestamp: 2,
    })
    const leftUpdate = Y.encodeStateAsUpdate(left)
    const rightUpdate = Y.encodeStateAsUpdate(right)
    Y.applyUpdate(left, rightUpdate)
    Y.applyUpdate(right, leftUpdate)
    expect(readPluginReview(left.getMap('project:discussions'), 'review-1')?.status).toBe('conflicted')
    expect(listPluginReviews(right.getMap('project:discussions'))).toEqual(listPluginReviews(left.getMap('project:discussions')))
    expect(inspectPluginReviews(left.getMap('project:discussions')).conflictedCount).toBe(1)
  })

  it('fails closed on malformed or colliding retained state', () => {
    const doc = new Y.Doc()
    const discussions = doc.getMap('project:discussions')
    discussions.set('plugin-reviews:v1:hostile', { reviewId: 'review-1', content: 'poison' })
    expect(inspectPluginReviews(discussions)).toMatchObject({ healthy: false, invalidRecords: 1 })
    expect(() => createPluginReview(discussions, createInput)).toThrow('conflicts with retained history')
  })
})
