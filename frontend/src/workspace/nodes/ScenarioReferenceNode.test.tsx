import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs'
import { $createParagraphNode, $getRoot, $nodesOfType, createEditor, type LexicalEditor } from 'lexical'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createScenario, updateScenario } from '../scenarioModel'
import { scenarioReferenceLabel } from '../ScenarioReferenceContext'
import { MemoryProjectHub, MemoryProjectProvider } from '../memoryProvider'
import {
  $createScenarioReferenceNode,
  ScenarioReferenceNode,
  type SerializedScenarioReferenceNode,
} from './ScenarioReferenceNode'

function editor(namespace = 'syzygy-scenario-reference-test') {
  return createEditor({ namespace, nodes: [ScenarioReferenceNode], onError(error) { throw error } })
}

function bind(target: LexicalEditor, provider: MemoryProjectProvider) {
  const lexicalProvider = provider as unknown as Provider
  const docs = new Map<string, Y.Doc>([['scenario-reference-document', provider.doc]])
  const binding = createBinding(target, lexicalProvider, 'scenario-reference-document', provider.doc, docs)
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

describe('scenario reference node', () => {
  it('round-trips only stable identity and fails closed without it', () => {
    const source = editor()
    source.update(() => {
      $getRoot().append($createParagraphNode().append($createScenarioReferenceNode('scenario-access')))
    }, { discrete: true })
    const serialized = source.getEditorState().toJSON()
    const child = (serialized.root.children[0] as unknown as { children: SerializedScenarioReferenceNode[] }).children[0]
    expect(child).toMatchObject({ type: 'scenario-reference', version: 1, scenarioId: 'scenario-access' })
    expect(JSON.stringify(child)).not.toContain('title')

    const restored = editor('syzygy-scenario-reference-restored')
    restored.setEditorState(restored.parseEditorState(serialized))
    restored.getEditorState().read(() => {
      expect($nodesOfType(ScenarioReferenceNode)[0].getScenarioId()).toBe('scenario-access')
    })
    expect(() => ScenarioReferenceNode.importJSON({ ...child, scenarioId: '' })).toThrow('stable scenarioId')
  })

  it('updates the visible title after rename without changing the persisted link', () => {
    const doc = new Y.Doc()
    const scenarios = doc.getMap('scenarios')
    const created = createScenario(scenarios, {
      id: 'scenario-access', title: 'Original access test', background: '', authorId: 'researcher-a',
      timestamp: 1, editId: 'edit-create',
    })
    expect(scenarioReferenceLabel([created], created.id)).toEqual({ label: 'Original access test', missing: false })
    const renamed = updateScenario(scenarios, {
      id: created.id, authorId: 'researcher-a', timestamp: 2, editId: 'edit-rename',
      changes: { title: 'Renamed access test' },
    })
    expect(scenarioReferenceLabel([renamed], created.id)).toEqual({ label: 'Renamed access test', missing: false })
    expect(created.id).toBe(renamed.id)
  })

  it('converges the stable reference across two Yjs-bound editors', async () => {
    const hub = new MemoryProjectHub()
    const leftProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'scenario-reference-document' }), hub)
    const rightProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'scenario-reference-document' }), hub)
    const left = editor('scenario-reference-left')
    const right = editor('scenario-reference-right')
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    try {
      leftProvider.connect()
      rightProvider.connect()
      left.update(() => {
        $getRoot().append($createParagraphNode().append($createScenarioReferenceNode('scenario-shared')))
      }, { discrete: true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const inspect = (target: LexicalEditor) => target.getEditorState().read(
        () => $nodesOfType(ScenarioReferenceNode).map((node) => node.getScenarioId()),
      )
      expect(inspect(left)).toEqual(['scenario-shared'])
      expect(inspect(right)).toEqual(inspect(left))
    } finally {
      unbindLeft()
      unbindRight()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })
})
