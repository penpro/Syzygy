import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isLineBreakNode,
  $isTextNode,
  createEditor,
  type LexicalEditor,
} from 'lexical'
import { describe, expect, it } from 'vitest'
import { PolicyBlockNode, $createPolicyBlockNode, $isPolicyBlockNode } from './nodes/PolicyBlockNode'
import { ScenarioReferenceNode, $createScenarioReferenceNode, $isScenarioReferenceNode } from './nodes/ScenarioReferenceNode'
import { readPolicyBlockContent, replacePolicyBlockContent } from './policyContentLexical'

function editor(): LexicalEditor {
  return createEditor({
    namespace: 'stable-policy-content-lexical',
    nodes: [PolicyBlockNode, ScenarioReferenceNode],
    onError(error) { throw error },
  })
}

function policy(source: LexicalEditor): PolicyBlockNode {
  return source.getEditorState().read(() => {
    const node = $getRoot().getFirstChild()
    if (!$isPolicyBlockNode(node)) throw new Error('Policy fixture is missing')
    return node
  })
}

describe('stable policy content Lexical adapter', () => {
  it('round-trips text marks, style, line breaks, inline references, and policy status', () => {
    const source = editor()
    source.update(() => {
      $getRoot().append($createPolicyBlockNode('policy-a', 'review').append(
        $createTextNode('Bold').setFormat('bold').setStyle('font-variant: small-caps'),
        $createLineBreakNode(),
        $createScenarioReferenceNode('scenario-a'),
        $createTextNode(' tail').setFormat('italic'),
      ))
    }, { discrete: true })
    const delta = source.getEditorState().read(() => readPolicyBlockContent(policy(source)))

    const restored = editor()
    restored.update(() => {
      const node = $createPolicyBlockNode('policy-a')
      $getRoot().append(node)
      replacePolicyBlockContent(node, delta, 'approved')
    }, { discrete: true })

    restored.getEditorState().read(() => {
      const node = policy(restored)
      const children = node.getChildren()
      expect(node.getStatus()).toBe('approved')
      expect($isTextNode(children[0]) && children[0].hasFormat('bold')).toBe(true)
      expect($isTextNode(children[0]) && children[0].getStyle()).toBe('font-variant: small-caps')
      expect($isLineBreakNode(children[1])).toBe(true)
      expect($isScenarioReferenceNode(children[2]) && children[2].getScenarioId()).toBe('scenario-a')
      expect($isTextNode(children[3]) && children[3].hasFormat('italic')).toBe(true)
      expect(readPolicyBlockContent(node)).toEqual(delta)
    })
  })

  it('rejects a block embed before clearing the current policy content', () => {
    const source = editor()
    source.update(() => {
      const node = $createPolicyBlockNode('policy-a').append($createTextNode('preserve me'))
      $getRoot().append(node)
      expect(() => replacePolicyBlockContent(node, [{
        insert: { schemaVersion: 1, kind: 'lexical-node', node: $createParagraphNode().exportJSON() },
      }], 'draft')).toThrow('non-text inline')
      expect(node.getTextContent()).toBe('preserve me')
    }, { discrete: true })
  })
})
