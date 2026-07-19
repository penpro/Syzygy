import { Awareness } from 'y-protocols/awareness'
import { describe, expect, it } from 'vitest'
import { createProjectDocument } from './projectModel'
import { registerProjectPresence } from './presenceRegistry'
import { inspectResearchState } from './researchStateInspection'
import { createProjectManifest } from './schema'

describe('research inspection presence metadata', () => {
  it('reports transport and session counts without participant identity or cursor data', async () => {
    const manifest = createProjectManifest({
      id: 'presence-inspection',
      documentId: 'presence-inspection-document',
      title: 'Presence inspection',
      timestamp: 1,
    })
    const doc = createProjectDocument(manifest)
    const awareness = new Awareness(doc)
    const unregister = registerProjectPresence(manifest.id, awareness, 'live')
    awareness.setLocalState({
      name: 'Secret collaborator name',
      focusing: true,
      awarenessData: {
        syzygy: { schemaVersion: 1, participantId: 'secret-collaborator-id' },
        secretCursorPayload: 'must be omitted',
      },
    })
    try {
      const result = await inspectResearchState(doc, manifest.id)
      expect(result.presence).toEqual({
        available: true,
        mode: 'live',
        healthy: true,
        sessionCount: 1,
        remoteSessionCount: 0,
        invalidRecords: 0,
        truncated: false,
      })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('Secret collaborator name')
      expect(serialized).not.toContain('secret-collaborator-id')
      expect(serialized).not.toContain('secretCursorPayload')
    } finally {
      unregister()
      awareness.destroy()
    }
  })
})
