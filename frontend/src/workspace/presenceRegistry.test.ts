import { Awareness } from 'y-protocols/awareness'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  getProjectPresence,
  inspectRegisteredProjectPresence,
  registerProjectPresence,
} from './presenceRegistry'

describe('presence registry', () => {
  it('uses identity-safe lifecycle cleanup and exposes content-free inspection counts', () => {
    const first = new Awareness(new Y.Doc({ guid: 'presence-registry-first' }))
    const second = new Awareness(new Y.Doc({ guid: 'presence-registry-second' }))
    const unregisterFirst = registerProjectPresence('presence-project', first, 'local-only')
    const unregisterSecond = registerProjectPresence('presence-project', second, 'live')
    second.setLocalState({
      name: 'Ada', focusing: true,
      awarenessData: { syzygy: { schemaVersion: 1, participantId: 'researcher-a' } },
    })
    unregisterFirst()
    expect(getProjectPresence('presence-project')).toMatchObject({ mode: 'live', awareness: second })
    expect(inspectRegisteredProjectPresence('presence-project')).toEqual({
      available: true,
      mode: 'live',
      healthy: true,
      sessionCount: 1,
      remoteSessionCount: 0,
      invalidRecords: 0,
      truncated: false,
    })
    unregisterSecond()
    expect(inspectRegisteredProjectPresence('presence-project')).toMatchObject({ available: false, mode: null })
    first.destroy()
    second.destroy()
  })
})
