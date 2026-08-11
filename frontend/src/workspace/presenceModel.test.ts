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
        { clientId: 4, participantId: 'researcher-a', displayName: 'Ada', focusing: false, local: true, deviceProof: null },
        { clientId: 12, participantId: 'researcher-b', displayName: 'Bob', focusing: true, local: false, deviceProof: null },
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
    expect(inspectPresenceStates(new Map<number, unknown>([
      [0x1_0000_0000, state('researcher-too-wide', 'Too wide')],
    ]), 1)).toMatchObject({ healthy: false, invalidRecords: 1, participants: [] })
  })

  it('accepts strict signed-device v2 records while retaining legacy v1 compatibility', () => {
    const deviceProof = {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: 'ed25519-sha256:syntactic-only',
      publicKey: 'A'.repeat(43),
      claim: {
        schemaVersion: 1,
        projectId: 'project-a',
        documentId: 'document-a',
        participantId: 'researcher-a',
        awarenessClientId: 4,
        sessionNonce: 'A'.repeat(43),
      },
      signature: 'A'.repeat(86),
    }
    const signed = {
      name: 'Ada',
      focusing: true,
      awarenessData: { syzygy: { schemaVersion: 2, participantId: 'researcher-a', deviceProof } },
    }
    const result = inspectPresenceStates(new Map<number, unknown>([[4, signed], [5, state('legacy', 'Legacy')]]), 4)
    expect(result.healthy).toBe(true)
    expect(result.participants[0]?.deviceProof).toEqual(deviceProof)
    expect(result.participants[1]?.deviceProof).toBeNull()

    const withUnknownField = structuredClone(signed)
    ;(withUnknownField.awarenessData.syzygy as Record<string, unknown>).authority = 'admin'
    expect(inspectPresenceStates(new Map([[4, withUnknownField]]), 4)).toMatchObject({
      healthy: false,
      invalidRecords: 1,
      participants: [],
    })
  })
})
