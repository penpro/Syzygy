import { $createHeadingNode, HeadingNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { describe, expect, it, vi } from 'vitest'
import {
  MOVE_POLICY_BLOCK_COMMAND,
  readPolicyMoveAvailability,
  readResearchHeadings,
  registerPolicyReorderCommands,
  selectResearchHeading,
} from './editorStructure'
import { $createPolicyBlockNode, $isPolicyBlockNode, PolicyBlockNode } from './nodes/PolicyBlockNode'

function fixture(): LexicalEditor {
  const editor = createEditor({
    namespace: 'editor-structure-test',
    nodes: [HeadingNode, PolicyBlockNode],
    onError(error) { throw error },
  })
  editor.update(() => {
    $getRoot().append(
      $createHeadingNode('h1').append($createTextNode('Research policy')),
      $createParagraphNode().append($createTextNode('Introduction')),
      $createHeadingNode('h2').append($createTextNode('Evidence')),
      $createPolicyBlockNode('policy-a').append($createTextNode('First policy')),
      $createPolicyBlockNode('policy-b').append($createTextNode('Second policy')),
    )
  }, { discrete: true })
  return editor
}

function policyOrder(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() =>
    $getRoot().getChildren().filter($isPolicyBlockNode).map((node) => node.getPolicyId()),
  )
}

function selectPolicy(editor: LexicalEditor, id: string) {
  editor.update(() => {
    const policy = $getRoot().getChildren().find((node) => $isPolicyBlockNode(node) && node.getPolicyId() === id)
    if (!$isPolicyBlockNode(policy)) throw new Error('Policy fixture is missing')
    policy.selectStart()
  }, { discrete: true })
}

const keyboardEvent = () => ({
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  preventDefault: vi.fn(),
}) as unknown as KeyboardEvent

describe('research editor structure', () => {
  it('derives the outline from live heading nodes and selects a current heading', () => {
    const editor = fixture()
    const headings = readResearchHeadings(editor.getEditorState())
    expect(headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'Research policy' },
      { level: 2, text: 'Evidence' },
    ])
    expect(selectResearchHeading(editor, headings[1].key)).toBe(true)
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection) && selection.anchor.getNode().getTopLevelElementOrThrow().getKey()).toBe(headings[1].key)
    })
    expect(selectResearchHeading(editor, 'missing-heading')).toBe(false)
  })

  it('uses one command for pointer controls and guarded keyboard reorder', async () => {
    const editor = fixture()
    const unregister = registerPolicyReorderCommands(editor)
    selectPolicy(editor, 'policy-a')
    expect(readPolicyMoveAvailability(editor.getEditorState())).toEqual({ up: true, down: true })
    expect(editor.dispatchCommand(MOVE_POLICY_BLOCK_COMMAND, 'down')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(policyOrder(editor)).toEqual(['policy-b', 'policy-a'])

    const up = keyboardEvent()
    expect(editor.dispatchCommand(KEY_ARROW_UP_COMMAND, up)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(up.preventDefault).toHaveBeenCalledOnce()
    expect(policyOrder(editor)).toEqual(['policy-a', 'policy-b'])

    const unrelated = { ...keyboardEvent(), altKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, unrelated)).toBe(false)
    expect(unrelated.preventDefault).not.toHaveBeenCalled()
    expect(policyOrder(editor)).toEqual(['policy-a', 'policy-b'])
    unregister()
  })
})
