import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MemoryProjectHub, MemoryProjectProvider } from './memoryProvider'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({
  id: 'two-editor-project',
  documentId: 'two-editor-document',
  title: 'Two-editor proof',
  timestamp: 10,
})
const providers: MemoryProjectProvider[] = []

function editor(hub: MemoryProjectHub): { doc: Y.Doc; provider: MemoryProjectProvider } {
  const doc = createProjectDocument(manifest)
  const provider = new MemoryProjectProvider(doc, hub)
  providers.push(provider)
  return { doc, provider }
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()))
})

describe('two-editor memory provider contract', () => {
  it('converges live domain and document edits in both directions', async () => {
    const hub = new MemoryProjectHub()
    const left = editor(hub)
    const right = editor(hub)
    left.provider.connect()
    right.provider.connect()
    await Promise.all([left.provider.whenReady(), right.provider.whenReady()])

    getProjectSharedTypes(left.doc).editorRoot.insert(0, 'Shared policy')
    getProjectSharedTypes(left.doc).scenarios.set('left-scenario', { title: 'From left' })
    getProjectSharedTypes(right.doc).heuristics.set('right-rule', { text: 'From right' })

    expect(getProjectSharedTypes(right.doc).editorRoot.toString()).toBe('Shared policy')
    expect(getProjectSharedTypes(right.doc).scenarios.get('left-scenario')).toEqual({ title: 'From left' })
    expect(getProjectSharedTypes(left.doc).heuristics.get('right-rule')).toEqual({ text: 'From right' })
    expect(projectStateFingerprint(left.doc)).toBe(projectStateFingerprint(right.doc))
    expect(hub.connectedCount).toBe(2)
  })

  it('merges concurrent offline edits after a partition and reconnect', () => {
    const hub = new MemoryProjectHub()
    const left = editor(hub)
    const right = editor(hub)
    left.provider.connect()
    right.provider.connect()

    left.provider.disconnect()
    right.provider.disconnect()
    getProjectSharedTypes(left.doc).scenarios.set('offline-left', { title: 'Left partition' })
    getProjectSharedTypes(left.doc).editorRoot.insert(0, 'Left ')
    getProjectSharedTypes(right.doc).discussions.set('offline-right', { text: 'Right partition' })
    getProjectSharedTypes(right.doc).editorRoot.insert(0, 'Right ')

    // Reconnect order is deliberately asymmetric; full state exchange must still converge.
    right.provider.connect()
    left.provider.connect()

    const leftTypes = getProjectSharedTypes(left.doc)
    const rightTypes = getProjectSharedTypes(right.doc)
    expect(leftTypes.scenarios.has('offline-left')).toBe(true)
    expect(leftTypes.discussions.has('offline-right')).toBe(true)
    expect(rightTypes.scenarios.has('offline-left')).toBe(true)
    expect(rightTypes.discussions.has('offline-right')).toBe(true)
    expect(leftTypes.editorRoot.toString()).toBe(rightTypes.editorRoot.toString())
    expect(leftTypes.editorRoot.toString()).toContain('Left ')
    expect(leftTypes.editorRoot.toString()).toContain('Right ')
    expect(projectStateFingerprint(left.doc)).toBe(projectStateFingerprint(right.doc))
  })

  it('does not transmit while disconnected and clears awareness on disconnect', () => {
    const hub = new MemoryProjectHub()
    const left = editor(hub)
    const right = editor(hub)
    left.provider.connect()
    right.provider.connect()
    left.provider.disconnect()
    getProjectSharedTypes(left.doc).settings.set('private-during-partition', true)
    expect(getProjectSharedTypes(right.doc).settings.has('private-during-partition')).toBe(false)
    expect(left.provider.awareness.getLocalState()).toBeNull()
    expect(hub.connectedCount).toBe(1)
  })
})
