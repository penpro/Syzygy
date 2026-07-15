import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { automationProjectDocumentReady, getAutomationProjectDocument, registerAutomationProjectDocument } from './workspaceAutomationRegistry'

describe('workspace automation document registry', () => {
  it('registers one live document and removes it by identity', () => {
    const doc = new Y.Doc()
    const unregister = registerAutomationProjectDocument('registry-project', doc)
    expect(automationProjectDocumentReady('registry-project')).toBe(true)
    expect(getAutomationProjectDocument('registry-project')).toBe(doc)
    unregister()
    expect(automationProjectDocumentReady('registry-project')).toBe(false)
  })

  it('does not let strict-mode cleanup remove a newer registration', () => {
    const oldDoc = new Y.Doc()
    const newDoc = new Y.Doc()
    const unregisterOld = registerAutomationProjectDocument('replacement-project', oldDoc)
    const unregisterNew = registerAutomationProjectDocument('replacement-project', newDoc)
    unregisterOld()
    expect(getAutomationProjectDocument('replacement-project')).toBe(newDoc)
    unregisterNew()
    expect(() => getAutomationProjectDocument('replacement-project')).toThrow('does not have a live collaboration document')
  })
})
