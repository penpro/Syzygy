import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  automationProjectDocumentReady,
  getAutomationProjectDocument,
  registerAutomationProjectDocument,
  subscribeAutomationProjectDocument,
} from './workspaceAutomationRegistry'

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

  it('notifies product subscribers across registration, replacement, and final cleanup', () => {
    const seen: Array<Y.Doc | null> = []
    const unsubscribe = subscribeAutomationProjectDocument('observed-project', (doc) => seen.push(doc))
    const first = new Y.Doc()
    const second = new Y.Doc()
    const unregisterFirst = registerAutomationProjectDocument('observed-project', first)
    const unregisterSecond = registerAutomationProjectDocument('observed-project', second)
    unregisterFirst()
    unregisterSecond()
    unsubscribe()
    const unregisterAfter = registerAutomationProjectDocument('observed-project', new Y.Doc())
    expect(seen).toEqual([null, first, second, null])
    unregisterAfter()
  })
})
