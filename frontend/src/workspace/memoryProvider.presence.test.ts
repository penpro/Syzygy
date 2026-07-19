import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MemoryProjectHub, MemoryProjectProvider } from './memoryProvider'
import { inspectAwareness } from './presenceModel'

const state = (participantId: string, name: string) => ({
  name,
  focusing: true,
  awarenessData: { syzygy: { schemaVersion: 1, participantId } },
})

describe('memory provider awareness transport', () => {
  it('propagates two-client presence and removes a disconnected peer immediately', async () => {
    const hub = new MemoryProjectHub()
    const left = new MemoryProjectProvider(new Y.Doc({ guid: 'presence-live' }), hub)
    const right = new MemoryProjectProvider(new Y.Doc({ guid: 'presence-live' }), hub)
    left.connect()
    right.connect()
    left.awareness.setLocalState(state('researcher-left', 'Left researcher'))
    right.awareness.setLocalState(state('researcher-right', 'Right researcher'))
    expect(inspectAwareness(left.awareness).participants).toHaveLength(2)
    expect(inspectAwareness(right.awareness).participants).toHaveLength(2)
    const leftClientId = left.doc.clientID
    left.disconnect()
    expect(right.awareness.getStates().has(leftClientId)).toBe(false)
    expect(inspectAwareness(right.awareness).participants).toMatchObject([
      { participantId: 'researcher-right', local: true },
    ])
    await Promise.all([left.destroy(), right.destroy()])
  })

  it('carries removal tombstones on reconnect instead of resurrecting stale presence', async () => {
    const hub = new MemoryProjectHub()
    const left = new MemoryProjectProvider(new Y.Doc({ guid: 'presence-partition' }), hub)
    const right = new MemoryProjectProvider(new Y.Doc({ guid: 'presence-partition' }), hub)
    left.connect()
    right.connect()
    left.awareness.setLocalState(state('researcher-left', 'Left researcher'))
    const leftClientId = left.doc.clientID
    expect(right.awareness.getStates().has(leftClientId)).toBe(true)
    right.disconnect()
    left.disconnect()
    expect(right.awareness.getStates().has(leftClientId)).toBe(true)
    left.connect()
    right.connect()
    expect(right.awareness.getStates().has(leftClientId)).toBe(false)
    await Promise.all([left.destroy(), right.destroy()])
  })
})
