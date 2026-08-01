import type { Provider } from '@lexical/yjs'
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs'
import {
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  SKIP_COLLAB_TAG,
  type LexicalEditor,
} from 'lexical'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { MemoryProjectHub, MemoryProjectProvider } from './memoryProvider'
import {
  $createPolicyBlockNode,
  $isPolicyBlockNode,
  $movePolicyBlock,
  PolicyBlockNode,
} from './nodes/PolicyBlockNode'
import { registerPolicyContentBridge, type PolicyContentBridgeState } from './policyContentBridge'
import { readPolicyContent, readPolicyContentStatus } from './policyContentModel'

function editor(): LexicalEditor {
  return createEditor({ namespace: 'policy-content-bridge-test', nodes: [PolicyBlockNode], onError(error) { throw error } })
}

function bind(editor: LexicalEditor, provider: MemoryProjectProvider): () => void {
  const lexicalProvider = provider as unknown as Provider
  const docMap = new Map<string, Y.Doc>([[provider.doc.guid, provider.doc]])
  const binding = createBinding(editor, lexicalProvider, provider.doc.guid, provider.doc, docMap)
  const sharedRoot = binding.root.getSharedType()
  const onRemote: Parameters<typeof sharedRoot.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, lexicalProvider, events, false)
  }
  sharedRoot.observeDeep(onRemote)
  const removeUpdate = editor.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      if (tags.has(SKIP_COLLAB_TAG)) return
      syncLexicalUpdateToYjs(
        binding, lexicalProvider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags,
      )
    },
  )
  return () => {
    removeUpdate()
    sharedRoot.unobserveDeep(onRemote)
    binding.root.destroy(binding)
  }
}

function inspect(target: LexicalEditor) {
  return target.getEditorState().read(() => $getRoot().getChildren().filter($isPolicyBlockNode).map((node) => ({
    id: node.getPolicyId(),
    status: node.getStatus(),
    text: node.getTextContent(),
  })))
}

describe('stable policy content bridge', () => {
  it('preserves the edited block identity when another peer moves it during a partition', async () => {
    const hub = new MemoryProjectHub()
    const leftProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'stable-move-edit' }), hub)
    const rightProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'stable-move-edit' }), hub)
    const left = editor()
    const right = editor()
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    const states: PolicyContentBridgeState[] = []
    let unbridgeLeft = () => {}
    let unbridgeRight = () => {}
    try {
      leftProvider.connect()
      rightProvider.connect()
      left.update(() => {
        $getRoot().append(
          $createPolicyBlockNode('policy-a').append($createTextNode('Original A')),
          $createPolicyBlockNode('policy-b').append($createTextNode('Original B')),
        )
      }, { discrete: true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      unbridgeLeft = registerPolicyContentBridge(left, leftProvider.doc, { bootstrapExisting: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      unbridgeRight = registerPolicyContentBridge(right, rightProvider.doc, {
        bootstrapExisting: false,
        onState: (state) => states.push(state),
      })

      leftProvider.disconnect()
      rightProvider.disconnect()
      left.update(() => {
        const moved = $getRoot().getChildren().find((node) => $isPolicyBlockNode(node) && node.getPolicyId() === 'policy-b')
        if (!$isPolicyBlockNode(moved)) throw new Error('Move fixture policy is missing')
        $movePolicyBlock(moved, 'up')
      }, { discrete: true })
      right.update(() => {
        const edited = $getRoot().getChildren().find((node) => $isPolicyBlockNode(node) && node.getPolicyId() === 'policy-b')
        if (!$isPolicyBlockNode(edited)) throw new Error('Edit fixture policy is missing')
        const text = edited.getFirstChildOrThrow()
        if (!$isTextNode(text)) throw new Error('Edit fixture policy text is missing')
        text.setTextContent('Edited during a concurrent move').setFormat('bold')
        edited.setStatus('approved')
      }, { discrete: true })

      leftProvider.connect()
      rightProvider.connect()
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(inspect(left)).toEqual(inspect(right))
      expect(inspect(left)).toEqual([
        { id: 'policy-b', status: 'approved', text: 'Edited during a concurrent move' },
        { id: 'policy-a', status: 'draft', text: 'Original A' },
      ])
      expect(readPolicyContent(leftProvider.doc, 'policy-b')).toEqual(readPolicyContent(rightProvider.doc, 'policy-b'))
      expect(readPolicyContentStatus(leftProvider.doc, 'policy-b')).toBe('approved')
      expect(states[states.length - 1]).toMatchObject({ healthy: true, error: null, stablePolicyCount: 2, legacyPolicyIds: [] })
    } finally {
      unbridgeLeft()
      unbridgeRight()
      unbindLeft()
      unbindRight()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })

  it('converges separate append-only move and edit packets in either delivery order', async () => {
    const hub = new MemoryProjectHub()
    const leftProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'stable-delivery-order' }), hub)
    const rightProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'stable-delivery-order' }), hub)
    const left = editor()
    const right = editor()
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    let unbridgeLeft = () => {}
    let unbridgeRight = () => {}
    try {
      leftProvider.connect()
      rightProvider.connect()
      left.update(() => {
        $getRoot().append(
          $createPolicyBlockNode('policy-a').append($createTextNode('Original A')),
          $createPolicyBlockNode('policy-b').append($createTextNode('Original B')),
        )
      }, { discrete: true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      unbridgeLeft = registerPolicyContentBridge(left, leftProvider.doc, { bootstrapExisting: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      unbridgeRight = registerPolicyContentBridge(right, rightProvider.doc, { bootstrapExisting: false })
      const baseline = Y.encodeStateAsUpdate(leftProvider.doc)

      leftProvider.disconnect()
      rightProvider.disconnect()
      const movePackets: Uint8Array[] = []
      const editPackets: Uint8Array[] = []
      const onMove = (update: Uint8Array) => movePackets.push(update)
      const onEdit = (update: Uint8Array) => editPackets.push(update)
      leftProvider.doc.on('update', onMove)
      rightProvider.doc.on('update', onEdit)
      left.update(() => {
        const moved = $getRoot().getChildren().find((node) => $isPolicyBlockNode(node) && node.getPolicyId() === 'policy-b')
        if (!$isPolicyBlockNode(moved)) throw new Error('Move packet fixture is missing')
        $movePolicyBlock(moved, 'up')
      }, { discrete: true })
      right.update(() => {
        const edited = $getRoot().getChildren().find((node) => $isPolicyBlockNode(node) && node.getPolicyId() === 'policy-b')
        if (!$isPolicyBlockNode(edited)) throw new Error('Edit packet fixture is missing')
        const text = edited.getFirstChildOrThrow()
        if (!$isTextNode(text)) throw new Error('Edit packet text is missing')
        text.setTextContent('Edited in a separate Drive packet')
        edited.setStatus('review')
      }, { discrete: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      leftProvider.doc.off('update', onMove)
      rightProvider.doc.off('update', onEdit)
      expect(movePackets.length).toBeGreaterThan(0)
      expect(editPackets.length).toBeGreaterThan(1)

      const replay = async (packets: Uint8Array[]) => {
        const replayHub = new MemoryProjectHub()
        const replayProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'stable-delivery-order' }), replayHub)
        const replayEditor = editor()
        const unbind = bind(replayEditor, replayProvider)
        Y.applyUpdate(replayProvider.doc, baseline, 'baseline')
        const unbridge = registerPolicyContentBridge(replayEditor, replayProvider.doc, { bootstrapExisting: false })
        try {
          for (const packet of packets) Y.applyUpdate(replayProvider.doc, packet, 'append-only-replay')
          await new Promise((resolve) => setTimeout(resolve, 20))
          return inspect(replayEditor)
        } finally {
          unbridge()
          unbind()
          await replayProvider.destroy()
        }
      }

      const moveThenEdit = await replay([...movePackets, ...editPackets])
      const editThenMove = await replay([...editPackets, ...movePackets])
      expect(moveThenEdit).toEqual(editThenMove)
      expect(moveThenEdit).toEqual([
        { id: 'policy-b', status: 'review', text: 'Edited in a separate Drive packet' },
        { id: 'policy-a', status: 'draft', text: 'Original A' },
      ])
    } finally {
      unbridgeLeft()
      unbridgeRight()
      unbindLeft()
      unbindRight()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })

  it('leaves pre-existing Drive-era blocks legacy but initializes a newly inserted stable block', () => {
    const target = editor()
    const doc = new Y.Doc({ guid: 'legacy-drive-content' })
    target.update(() => {
      $getRoot().append($createPolicyBlockNode('legacy').append($createTextNode('Legacy text')))
    }, { discrete: true })
    const states: PolicyContentBridgeState[] = []
    const unregister = registerPolicyContentBridge(target, doc, {
      bootstrapExisting: false,
      onState: (state) => states.push(state),
    })
    target.update(() => {
      $getRoot().append($createPolicyBlockNode('new-policy').append($createTextNode('Stable text')))
    }, { discrete: true })
    expect(readPolicyContent(doc, 'legacy')).toBeNull()
    expect(readPolicyContent(doc, 'new-policy')).toEqual([{ insert: 'Stable text' }])
    expect(states[states.length - 1]).toMatchObject({ healthy: true, stablePolicyCount: 1, legacyPolicyIds: ['legacy'] })
    unregister()
  })
})
