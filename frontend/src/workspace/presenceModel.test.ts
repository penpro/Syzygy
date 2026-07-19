import { describe, expect, it } from 'vitest'
import { inspectPresenceStates, MAX_PRESENCE_STATES } from './presenceModel'

const state = (participantId: string, name: string, focusing = false) => ({
  name,
  focusing,
  awarenessData: { syzygy: { schemaVersion: 1, participantId } },
  secretSelectionBody: 'must never be projected',
})

describe('presence inspection', () => {
  it('projects bounded identity metadata and marks the local editing session', () => {
    const result = inspectPresenceStates(new Map<number, unknown>([
      [12, state('researcher-b', 'Bob', true)],
      [4, state('researcher-a', 'Ada')],
    ]), 4)
    expect(result).toEqual({
      healthy: true,
      totalRecords: 2,
      invalidRecords: 0,
      truncated: false,
      participants: [
        { clientId: 4, participantId: 'researcher-a', displayName: 'Ada', focusing: false, local: true },
        { clientId: 12, participantId: 'researcher-b', displayName: 'Bob', focusing: true, local: false },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('secretSelectionBody')
  })

  it('fails closed on malformed identity and caps peer-controlled awareness records', () => {
    const states = new Map<number, unknown>()
    states.set(1, { name: 'Missing identity', focusing: true, awarenessData: {} })
    for (let index = 2; index <= MAX_PRESENCE_STATES + 2; index += 1) {
      states.set(index, state('researcher-' + index, 'Researcher ' + index))
    }
    const result = inspectPresenceStates(states, 2)
    expect(result).toMatchObject({
      healthy: false,
      totalRecords: MAX_PRESENCE_STATES + 2,
      invalidRecords: 3,
      truncated: true,
    })
    expect(result.participants).toHaveLength(MAX_PRESENCE_STATES - 1)
  })
})
