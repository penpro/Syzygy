import { describe, expect, it } from 'vitest'
import { $createTextNode, $getRoot, $isTextNode, $nodesOfType, createEditor } from 'lexical'
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
} from '@lexical/yjs'
import type { LexicalEditor } from 'lexical'
import * as Y from 'yjs'
import { MemoryProjectHub, MemoryProjectProvider } from '../memoryProvider'
import {
  $createPolicyBlockNode,
  $isPolicyBlockNode,
  $movePolicyBlock,
  PolicyBlockNode,
  type SerializedPolicyBlockNode,
} from './PolicyBlockNode'

const $policyBlocksInDocument = () => $getRoot().getChildren().filter($isPolicyBlockNode)

function editor() {
  return createEditor({
    namespace: 'syzygy-policy-block-test',
    nodes: [PolicyBlockNode],
    onError(error) {
      throw error
    },
  })
}

function bind(editor: LexicalEditor, provider: MemoryProjectProvider) {
  const lexicalProvider = provider as unknown as Provider
  const docMap = new Map<string, Y.Doc>([['policy-block-document', provider.doc]])
  const binding = createBinding(editor, lexicalProvider, 'policy-block-document', provider.doc, docMap)
  const sharedRoot = binding.root.getSharedType()
  const onRemote: Parameters<typeof sharedRoot.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, lexicalProvider, events, false)
  }
  sharedRoot.observeDeep(onRemote)
  const removeUpdate = editor.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        lexicalProvider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      )
    },
  )
  return () => {
    sharedRoot.unobserveDeep(onRemote)
    removeUpdate()
  }
}

describe('policy block node', () => {
  it('adds, edits, reorders, and serializes stable policy blocks', () => {
    const source = editor()
    source.update(
      () => {
        $getRoot().append(
          $createPolicyBlockNode('policy-a').append($createTextNode('First statement')),
          $createPolicyBlockNode('policy-b', 'review').append($createTextNode('Second statement')),
        )
      },
      { discrete: true },
    )
    source.update(
      () => {
        const [first, second] = $nodesOfType(PolicyBlockNode)
        const text = first.getFirstChildOrThrow()
        if (!$isTextNode(text)) throw new Error('Policy fixture child must be text')
        text.setTextContent('Edited first statement')
        first.setStatus('approved')
        second.insertAfter(first)
      },
      { discrete: true },
    )

    const serialized = source.getEditorState().toJSON()
    const blocks = serialized.root.children as SerializedPolicyBlockNode[]
    expect(blocks.map(({ policyId }) => policyId)).toEqual(['policy-b', 'policy-a'])
    expect(blocks[1]).toMatchObject({ status: 'approved', type: 'policy-block', version: 1 })

    const restored = editor()
    restored.setEditorState(restored.parseEditorState(serialized))
    restored.getEditorState().read(() => {
      const blocks = $policyBlocksInDocument()
      expect(blocks.map((block) => block.getPolicyId())).toEqual(['policy-b', 'policy-a'])
      expect(blocks[1].getTextContent()).toBe('Edited first statement')
      expect(blocks[1].getStatus()).toBe('approved')
    })
  })

  it('fails closed when serialized identity is missing', () => {
    const node = {
      children: [],
      direction: null,
      format: '',
      indent: 0,
      policyId: '',
      status: 'draft',
      textFormat: 0,
      textStyle: '',
      type: 'policy-block',
      version: 1,
    } as SerializedPolicyBlockNode
    expect(() => PolicyBlockNode.importJSON(node)).toThrow('stable policyId')
  })

  it('converges custom identity, state, and text across two bound editors after a partition', async () => {
    const hub = new MemoryProjectHub()
    const leftDoc = new Y.Doc({ guid: 'policy-block-document' })
    const rightDoc = new Y.Doc({ guid: 'policy-block-document' })
    const leftProvider = new MemoryProjectProvider(leftDoc, hub)
    const rightProvider = new MemoryProjectProvider(rightDoc, hub)
    const left = editor()
    const right = editor()
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    leftProvider.connect()
    rightProvider.connect()

    left.update(
      () => {
        $getRoot().append(
          $createPolicyBlockNode('policy-a').append($createTextNode('Original A')),
          $createPolicyBlockNode('policy-b').append($createTextNode('Original B')),
        )
      },
      { discrete: true },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    right.getEditorState().read(() => {
      expect($policyBlocksInDocument().map((node) => node.getPolicyId())).toEqual(['policy-a', 'policy-b'])
    })

    leftProvider.disconnect()
    rightProvider.disconnect()
    left.update(
      () => {
        const [first] = $policyBlocksInDocument()
        first.setStatus('approved')
      },
      { discrete: true },
    )
    right.update(
      () => {
        const first = $policyBlocksInDocument()[0]
        const text = first.getFirstChildOrThrow()
        if (!$isTextNode(text)) throw new Error('Policy fixture child must be text')
        text.setTextContent('Edited while partitioned')
      },
      { discrete: true },
    )

    rightProvider.connect()
    leftProvider.connect()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const inspect = (target: LexicalEditor) =>
      target.getEditorState().read(() =>
        $policyBlocksInDocument().map((node) => ({
          id: node.getPolicyId(),
          status: node.getStatus(),
          text: node.getTextContent(),
        })),
      )
    expect(inspect(left)).toEqual(inspect(right))
    expect(inspect(left)).toContainEqual({ id: 'policy-a', status: 'approved', text: 'Edited while partitioned' })

    const beforeReorder = inspect(left).map(({ id }) => id)
    left.update(
      () => {
        const [first] = $policyBlocksInDocument()
        $movePolicyBlock(first, 'down')
      },
      { discrete: true },
    )
    expect(inspect(left).map(({ id }) => id)).toEqual([...beforeReorder].reverse())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(inspect(right).map(({ id }) => id)).toEqual([...beforeReorder].reverse())

    unbindLeft()
    unbindRight()
    await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
  })

})
