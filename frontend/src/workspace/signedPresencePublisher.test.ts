import { Awareness } from 'y-protocols/awareness'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { DevicePresenceProof, PresenceIdentityClaim } from '../tauri'
import { installSignedPresencePublisher } from './ResearchPresence'

const legacyState = (participantId = 'participant-a') => ({
  name: 'Ada',
  focusing: false,
  awarenessData: { syzygy: { schemaVersion: 1, participantId } },
})

const proofFor = (claim: PresenceIdentityClaim): DevicePresenceProof => ({
  schemaVersion: 1,
  algorithm: 'Ed25519',
  keyId: 'ed25519-sha256:test',
  publicKey: 'A'.repeat(43),
  claim,
  signature: 'A'.repeat(86),
})

describe('signed presence publisher', () => {
  it('signs once and restores the proof after Lexical focus updates publish legacy awareness data', async () => {
    const awareness = new Awareness(new Y.Doc())
    awareness.setLocalState(legacyState())
    const sign = vi.fn(async (claim: PresenceIdentityClaim) => proofFor(claim))
    const dispose = installSignedPresencePublisher(awareness, {
      projectId: 'project-a',
      documentId: 'document-a',
      participantId: 'participant-a',
    }, sign, 'A'.repeat(43))
    await Promise.resolve()
    await Promise.resolve()
    expect(sign).toHaveBeenCalledTimes(1)
    expect((awareness.getLocalState()?.awarenessData as Record<string, unknown>).syzygy).toMatchObject({
      schemaVersion: 2,
      participantId: 'participant-a',
    })

    awareness.setLocalState(legacyState())
    expect(sign).toHaveBeenCalledTimes(1)
    expect((awareness.getLocalState()?.awarenessData as Record<string, unknown>).syzygy).toMatchObject({
      schemaVersion: 2,
      participantId: 'participant-a',
    })
    dispose()
    awareness.destroy()
  })

  it('does not sign a state attributed to a different participant', async () => {
    const awareness = new Awareness(new Y.Doc())
    awareness.setLocalState(legacyState('participant-other'))
    const sign = vi.fn(async (claim: PresenceIdentityClaim) => proofFor(claim))
    const dispose = installSignedPresencePublisher(awareness, {
      projectId: 'project-a',
      documentId: 'document-a',
      participantId: 'participant-a',
    }, sign, 'A'.repeat(43))
    await Promise.resolve()
    expect(sign).not.toHaveBeenCalled()
    dispose()
    awareness.destroy()
  })

  it('keeps legacy unsigned collaboration usable after one signing failure', async () => {
    const awareness = new Awareness(new Y.Doc())
    awareness.setLocalState(legacyState())
    const sign = vi.fn(async () => { throw new Error('vault unavailable') })
    const dispose = installSignedPresencePublisher(awareness, {
      projectId: 'project-a',
      documentId: 'document-a',
      participantId: 'participant-a',
    }, sign, 'A'.repeat(43))
    await Promise.resolve()
    await Promise.resolve()
    awareness.setLocalState(legacyState())
    expect(sign).toHaveBeenCalledTimes(1)
    expect((awareness.getLocalState()?.awarenessData as Record<string, unknown>).syzygy).toEqual({
      schemaVersion: 1,
      participantId: 'participant-a',
    })
    dispose()
    awareness.destroy()
  })
})
