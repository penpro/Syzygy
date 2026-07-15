import { afterEach, describe, expect, it } from 'vitest'
import { createEditor, $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  appendAutomationDocument,
  readAutomationEditor,
  registerAutomationEditor,
  replaceAutomationDocument,
} from './editorAutomation'
import { automationEditorReady } from './editorAutomationRegistry'

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  unregister = undefined
})

function registeredEditor(projectId = 'project-test') {
  const editor = createEditor({
    namespace: `automation-${projectId}`,
    nodes: [HeadingNode, QuoteNode],
    onError(error) {
      throw error
    },
  })
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('Starter draft')))
    },
    { discrete: true },
  )
  unregister = registerAutomationEditor(projectId, editor)
  return editor
}

describe('live editor automation contract', () => {
  it('reads the registered live editor with a revision', () => {
    registeredEditor()
    const snapshot = readAutomationEditor('project-test')
    expect(automationEditorReady('project-test')).toBe(true)
    expect(snapshot.text).toBe('Starter draft')
    expect(snapshot.blocks).toEqual([{ kind: 'paragraph', text: 'Starter draft' }])
    expect(snapshot.revision).toMatch(/^lexical-[a-z0-9]{12}-\d+-[0-9a-f]{8}$/)
  })

  it('replaces and appends structured blocks through the same Lexical editor', () => {
    registeredEditor()
    const original = readAutomationEditor()
    const replaced = replaceAutomationDocument(
      original.revision,
      '# Access policy\nOnly approved researchers may edit.\n> Record the reason for each change.',
    )
    expect(replaced.blocks).toEqual([
      { kind: 'heading1', text: 'Access policy' },
      { kind: 'paragraph', text: 'Only approved researchers may edit.' },
      { kind: 'quote', text: 'Record the reason for each change.' },
    ])
    expect(replaced.revision).not.toBe(original.revision)

    const appended = appendAutomationDocument(replaced.revision, '## Test case\nAn unapproved edit is rejected.')
    expect(appended.blocks[appended.blocks.length - 2]).toEqual({ kind: 'heading2', text: 'Test case' })
    expect(appended.blocks[appended.blocks.length - 1]).toEqual({ kind: 'paragraph', text: 'An unapproved edit is rejected.' })
  })

  it('rejects a stale revision instead of overwriting a newer draft', () => {
    registeredEditor()
    const firstRead = readAutomationEditor()
    const updated = appendAutomationDocument(firstRead.revision, 'A newer local change.')
    expect(updated.revision).not.toBe(firstRead.revision)
    expect(() => replaceAutomationDocument(firstRead.revision, 'Blind overwrite')).toThrow(/Revision conflict/)
    expect(readAutomationEditor().text).toContain('A newer local change.')
  })

  it('rejects an ABA revision even when content later returns to the same text', () => {
    registeredEditor()
    const original = readAutomationEditor()
    const changed = replaceAutomationDocument(original.revision, 'Different text')
    const returned = replaceAutomationDocument(changed.revision, 'Starter draft')
    expect(returned.text).toBe(original.text)
    expect(returned.revision).not.toBe(original.revision)
    expect(() => appendAutomationDocument(original.revision, 'Stale append')).toThrow(/Revision conflict/)
  })

  it('fails closed when no project editor is live', () => {
    expect(automationEditorReady()).toBe(false)
    expect(() => readAutomationEditor()).toThrow(/not ready/)
  })
})
