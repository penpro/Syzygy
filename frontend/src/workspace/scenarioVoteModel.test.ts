import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createScenario, deleteScenario } from './scenarioModel'
import { castScenarioVote, inspectScenarioVotes, readScenarioVotes } from './scenarioVoteModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'vote-project', documentId: 'vote-document', timestamp: 1 })
const replica = (source: Y.Doc) => {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}
const seedScenario = (doc: Y.Doc) => createScenario(getProjectSharedTypes(doc).scenarios, {
  id: 'evidence-scenario', title: 'Evidence scenario', background: '', authorId: 'researcher-1',
  timestamp: 10, editId: 'create-evidence-scenario',
})
const shuffled = <T,>(values: T[], seed: number): T[] => {
  const result = [...values]
  let state = seed >>> 0
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const target = state % (index + 1)
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}
const vote = (doc: Y.Doc, input: Parameters<typeof castScenarioVote>[2]) => {
  const { discussions, scenarios } = getProjectSharedTypes(doc)
  return castScenarioVote(discussions, scenarios, input)
}

describe('collaborative scenario vote model', () => {
  it('supports idempotent voting, attributed revoting, abstention, and withdrawal', () => {
    const doc = createProjectDocument(manifest)
    seedScenario(doc)
    const first = {
      scenarioId: 'evidence-scenario', eventId: 'alice-supports', participantId: 'alice', displayName: 'Alice',
      choice: 'support' as const, timestamp: 20,
    }
    expect(vote(doc, first).counts).toEqual({ support: 1, oppose: 0, abstain: 0 })
    expect(vote(doc, first).history).toHaveLength(1)
    vote(doc, { ...first, eventId: 'alice-opposes', choice: 'oppose', timestamp: 21 })
    vote(doc, { ...first, eventId: 'bob-abstains', participantId: 'bob', displayName: 'Bob', choice: 'abstain', timestamp: 22 })
    const withdrawn = vote(doc, { ...first, eventId: 'alice-withdraws', choice: 'withdrawn', timestamp: 23 })
    expect(withdrawn.counts).toEqual({ support: 0, oppose: 0, abstain: 1 })
    expect(withdrawn.activeVotes).toMatchObject([{ participantId: 'bob', displayName: 'Bob', choice: 'abstain' }])
    expect(withdrawn.history.map((event) => event.eventId)).toEqual([
      'alice-supports', 'alice-opposes', 'bob-abstains', 'alice-withdraws',
    ])
  })

  it('converges disconnected first votes without losing either participant across seeded deliveries', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    vote(left, { scenarioId: 'evidence-scenario', eventId: 'left-support', participantId: 'left', displayName: 'Left', choice: 'support', timestamp: 30 })
    vote(right, { scenarioId: 'evidence-scenario', eventId: 'right-oppose', participantId: 'right', displayName: 'Right', choice: 'oppose', timestamp: 31 })

    let fingerprint = ''
    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...leftUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      const { discussions } = getProjectSharedTypes(merged)
      expect(readScenarioVotes(discussions, 'evidence-scenario')).toMatchObject({
        counts: { support: 1, oppose: 1, abstain: 0 },
        activeVotes: [{ participantId: 'left' }, { participantId: 'right' }],
      })
      fingerprint ||= projectStateFingerprint(merged)
      expect(projectStateFingerprint(merged)).toBe(fingerprint)
    }
  })

  it('retains concurrent revotes by one participant and deterministically selects the latest event', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    vote(origin, { scenarioId: 'evidence-scenario', eventId: 'alice-initial', participantId: 'alice', displayName: 'Alice', choice: 'abstain', timestamp: 20 })
    const left = replica(origin)
    const right = replica(origin)
    const leftUpdates: Uint8Array[] = []
    const rightUpdates: Uint8Array[] = []
    left.on('update', (update: Uint8Array) => leftUpdates.push(update))
    right.on('update', (update: Uint8Array) => rightUpdates.push(update))
    vote(left, { scenarioId: 'evidence-scenario', eventId: 'alice-left', participantId: 'alice', displayName: 'Alice L.', choice: 'support', timestamp: 40 })
    vote(right, { scenarioId: 'evidence-scenario', eventId: 'alice-right', participantId: 'alice', displayName: 'Alice R.', choice: 'oppose', timestamp: 41 })

    for (let seed = 1; seed <= 40; seed += 1) {
      const merged = replica(origin)
      shuffled([...leftUpdates, ...rightUpdates, ...rightUpdates], seed).forEach((update) => applyProjectUpdate(merged, update))
      const summary = readScenarioVotes(getProjectSharedTypes(merged).discussions, 'evidence-scenario')!
      expect(summary.counts).toEqual({ support: 0, oppose: 1, abstain: 0 })
      expect(summary.activeVotes).toMatchObject([{ participantId: 'alice', displayName: 'Alice R.', choice: 'oppose' }])
      expect(summary.history.map((event) => event.eventId)).toEqual(['alice-initial', 'alice-left', 'alice-right'])
    }
  })

  it('fails closed when disconnected peers reuse one event identity with different votes', () => {
    const origin = createProjectDocument(manifest)
    seedScenario(origin)
    const left = replica(origin)
    const right = replica(origin)
    vote(left, { scenarioId: 'evidence-scenario', eventId: 'colliding-event', participantId: 'alice', displayName: 'Alice', choice: 'support', timestamp: 50 })
    vote(right, { scenarioId: 'evidence-scenario', eventId: 'colliding-event', participantId: 'bob', displayName: 'Bob', choice: 'oppose', timestamp: 51 })
    const merged = replica(origin)
    applyProjectUpdate(merged, encodeProjectState(left))
    applyProjectUpdate(merged, encodeProjectState(right))
    const { discussions, scenarios } = getProjectSharedTypes(merged)
    expect(readScenarioVotes(discussions, 'evidence-scenario')).toBeNull()
    expect(inspectScenarioVotes(discussions, scenarios)).toMatchObject({ healthy: false, invalidRecords: 1 })
  })

  it('reports orphan votes and rejects malformed or conflicting local events', () => {
    const doc = createProjectDocument(manifest)
    seedScenario(doc)
    const input = { scenarioId: 'evidence-scenario', eventId: 'alice-vote', participantId: 'alice', displayName: 'Alice', choice: 'support' as const, timestamp: 60 }
    vote(doc, input)
    expect(() => vote(doc, { ...input, choice: 'oppose' })).toThrow('Scenario vote event ID was reused')
    expect(() => vote(doc, { ...input, eventId: '../escape' })).toThrow('Invalid scenario vote')
    const { discussions, scenarios } = getProjectSharedTypes(doc)
    deleteScenario(scenarios, 'evidence-scenario')
    expect(inspectScenarioVotes(discussions, scenarios)).toMatchObject({
      healthy: false, orphanScenarioIds: ['evidence-scenario'],
      issues: ['Scenario votes target missing scenario evidence-scenario'],
    })
    discussions.set('future-discussion-type', { ignoredByVoteProjection: true })
    const bucket = Array.from(discussions.values()).find((value) => value instanceof Y.Map) as Y.Map<unknown>
    bucket.set('ambientAuthority', true)
    expect(() => readScenarioVotes(discussions, 'evidence-scenario')).not.toThrow()
    expect(readScenarioVotes(discussions, 'evidence-scenario')).toBeNull()
    expect(inspectScenarioVotes(discussions, scenarios).invalidRecords).toBe(1)
  })
})
