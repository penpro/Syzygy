import { $isHeadingNode } from '@lexical/rich-text'
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $isPolicyBlockNode, $movePolicyBlock, type PolicyBlockNode } from './nodes/PolicyBlockNode'

export type PolicyMoveDirection = 'up' | 'down'
export interface PolicyMoveAvailability { up: boolean; down: boolean }
export interface PolicyReorderSafety { allowed: boolean; reason: string | null }
export interface PolicyReorderReadiness { healthy: boolean; legacyPolicyCount: number }
export interface ResearchHeading { key: string; level: 1 | 2; text: string }

export const MOVE_POLICY_BLOCK_COMMAND = createCommand<PolicyMoveDirection>('syzygy-move-policy-block')

export function policyReorderSafety(
  transportKind: 'local' | 'drive',
  readiness?: PolicyReorderReadiness,
): PolicyReorderSafety {
  if (transportKind === 'local') return { allowed: true, reason: null }
  if (!readiness) return { allowed: false, reason: 'Checking stable policy content before shared reordering.' }
  if (!readiness.healthy) return { allowed: false, reason: 'Shared reordering is paused because stable policy content is unavailable.' }
  if (readiness.legacyPolicyCount) {
    return {
      allowed: false,
      reason: readiness.legacyPolicyCount + (readiness.legacyPolicyCount === 1
        ? ' legacy policy block needs a stable baseline before shared reordering.'
        : ' legacy policy blocks need a stable baseline before shared reordering.'),
    }
  }
  return { allowed: true, reason: null }
}

function $selectedPolicyBlock(): PolicyBlockNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  let node: LexicalNode | null = selection.anchor.getNode()
  while (node) {
    if ($isPolicyBlockNode(node)) return node
    node = node.getParent()
  }
  return null
}

function $moveSelectedPolicyBlock(direction: PolicyMoveDirection): boolean {
  const selected = $selectedPolicyBlock()
  if (!selected) return false
  const moved = $movePolicyBlock(selected, direction)
  if (!moved) return false
  moved.selectStart()
  return true
}

function keyboardMove(direction: PolicyMoveDirection) {
  return (event: KeyboardEvent): boolean => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return false
    const moved = $moveSelectedPolicyBlock(direction)
    if (moved) event.preventDefault()
    return moved
  }
}

export function registerPolicyReorderCommands(editor: LexicalEditor): () => void {
  const removeMove = editor.registerCommand(
    MOVE_POLICY_BLOCK_COMMAND,
    (direction) => $moveSelectedPolicyBlock(direction),
    COMMAND_PRIORITY_EDITOR,
  )
  const removeUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, keyboardMove('up'), COMMAND_PRIORITY_EDITOR)
  const removeDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, keyboardMove('down'), COMMAND_PRIORITY_EDITOR)
  return () => {
    removeMove()
    removeUp()
    removeDown()
  }
}

export function readPolicyMoveAvailability(editorState: EditorState): PolicyMoveAvailability {
  return editorState.read(() => {
    const selected = $selectedPolicyBlock()
    return {
      up: !!selected?.getPreviousSibling(),
      down: !!selected?.getNextSibling(),
    }
  })
}

export function readResearchHeadings(editorState: EditorState): ResearchHeading[] {
  return editorState.read(() =>
    $getRoot().getChildren().flatMap((node) =>
      $isHeadingNode(node)
        ? [{ key: node.getKey(), level: node.getTag() === 'h1' ? 1 : 2, text: node.getTextContent() } as ResearchHeading]
        : [],
    ),
  )
}

export function selectResearchHeading(editor: LexicalEditor, key: string): boolean {
  let selected = false
  editor.update(
    () => {
      const node = $getNodeByKey(key)
      if (!$isHeadingNode(node)) return
      node.selectStart()
      selected = true
    },
    { discrete: true, tag: 'syzygy-select-outline-heading' },
  )
  return selected
}
