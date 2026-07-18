import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $nodesOfType,
  createEditor,
  HISTORY_PUSH_TAG,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MemoryProjectHub, MemoryProjectProvider } from '../memoryProvider'
import { ScenarioReferenceNode } from './ScenarioReferenceNode'
import {
  $createScenarioSpotlightNode,
  $unembedScenarioSpotlight,
  ScenarioSpotlightNode,
  type SerializedScenarioSpotlightNode,
} from './ScenarioSpotlightNode'

const tick = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function editor(namespace = 'syzygy-scenario-spotlight-test') {
  return createEditor({
    namespace,
    nodes: [ScenarioReferenceNode, ScenarioSpotlightNode],
    onError(error) { throw error },
  })
}

function bind(target: LexicalEditor, provider: MemoryProjectProvider) {
  const lexicalProvider = provider as unknown as Provider
  const docs = new Map<string, Y.Doc>([['scenario-spotlight-document', provider.doc]])
  const binding = createBinding(target, lexicalProvider, 'scenario-spotlight-document', provider.doc, docs)
  const sharedRoot = binding.root.getSharedType()
  const onRemote: Parameters<typeof sharedRoot.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, lexicalProvider, events, false)
  }
  sharedRoot.observeDeep(onRemote)
  const removeUpdate = target.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding, lexicalProvider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags,
      )
    },
  )
  return () => { sharedRoot.unobserveDeep(onRemote); removeUpdate() }
}

function inspect(target: LexicalEditor) {
  return target.getEditorState().read(() => ({
    spotlights: $nodesOfType(ScenarioSpotlightNode).map((node) => node.getScenarioId()),
    references: $nodesOfType(ScenarioReferenceNode).map((node) => node.getScenarioId()),
  }))
}

describe('scenario spotlight node', () => {
  it('persists only stable identity and fails closed without it', () => {
    const source = editor()
    source.update(() => {
      $getRoot().append($createScenarioSpotlightNode('scenario-access'))
    }, { discrete: true })
    const serialized = source.getEditorState().toJSON()
    const child = serialized.root.children[0] as SerializedScenarioSpotlightNode
    expect(child).toMatchObject({ type: 'scenario-spotlight', version: 1, scenarioId: 'scenario-access' })
    expect(JSON.stringify(child)).not.toContain('title')
    expect(() => ScenarioSpotlightNode.importJSON({ ...child, scenarioId: '' })).toThrow('stable scenarioId')
  })

  it('collapses to a stable link and undo/redo restores each presentation', async () => {
    const source = editor('scenario-spotlight-history')
    const unregisterHistory = registerHistory(source, createEmptyHistoryState(), 0)
    try {
      source.update(() => {
        $getRoot().append($createParagraphNode().append($createTextNode('Policy draft')))
      }, { discrete: true, tag: HISTORY_PUSH_TAG })
      source.update(() => {
        $getRoot().append($createScenarioSpotlightNode('scenario-history'))
      }, { discrete: true, tag: HISTORY_PUSH_TAG })
      await tick()
      expect(inspect(source).spotlights).toEqual(['scenario-history'])

      source.update(() => {
        const spotlight = $nodesOfType(ScenarioSpotlightNode)[0]
        $unembedScenarioSpotlight(spotlight)
      }, { discrete: true, tag: HISTORY_PUSH_TAG })
      await tick()
      expect(inspect(source)).toEqual({ spotlights: [], references: ['scenario-history'] })

      expect(source.dispatchCommand(UNDO_COMMAND, undefined)).toBe(true)
      await tick()
      expect(inspect(source)).toEqual({ spotlights: ['scenario-history'], references: [] })

      expect(source.dispatchCommand(REDO_COMMAND, undefined)).toBe(true)
      await tick()
      expect(inspect(source)).toEqual({ spotlights: [], references: ['scenario-history'] })
    } finally {
      unregisterHistory()
    }
  })

  it('converges embed and unembed across two Yjs-bound editors', async () => {
    const hub = new MemoryProjectHub()
    const leftProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'scenario-spotlight-document' }), hub)
    const rightProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'scenario-spotlight-document' }), hub)
    const left = editor('scenario-spotlight-left')
    const right = editor('scenario-spotlight-right')
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    try {
      leftProvider.connect()
      rightProvider.connect()
      left.update(() => {
        $getRoot().append($createScenarioSpotlightNode('scenario-shared'))
      }, { discrete: true })
      await tick(20)
      expect(inspect(left)).toEqual({ spotlights: ['scenario-shared'], references: [] })
      expect(inspect(right)).toEqual(inspect(left))

      right.update(() => {
        $unembedScenarioSpotlight($nodesOfType(ScenarioSpotlightNode)[0])
      }, { discrete: true })
      await tick(20)
      expect(inspect(right)).toEqual({ spotlights: [], references: ['scenario-shared'] })
      expect(inspect(left)).toEqual(inspect(right))
    } finally {
      unbindLeft()
      unbindRight()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })
})
