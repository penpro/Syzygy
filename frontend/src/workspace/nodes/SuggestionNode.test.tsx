import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs'
import { $getRoot, $nodesOfType, createEditor, type LexicalEditor } from 'lexical'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MemoryProjectHub, MemoryProjectProvider } from '../memoryProvider'
import type { CollaborativeSuggestion } from '../suggestionModel'
import {
  $createSuggestionNode,
  SuggestionCard,
  SuggestionNode,
  type SerializedSuggestionNode,
} from './SuggestionNode'

const tick = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const suggestion = (status: CollaborativeSuggestion['status'] = 'pending'): CollaborativeSuggestion => ({
  id: 'suggestion-a',
  content: 'Add an explicit appeal process.',
  sourceDocumentRevision: 'lexical-source-a',
  proposal: {
    schemaVersion: 1,
    kind: 'proposal',
    eventId: 'proposal-a',
    suggestionId: 'suggestion-a',
    content: 'Add an explicit appeal process.',
    sourceDocumentRevision: 'lexical-source-a',
    authorId: 'researcher-a',
    authorDisplayName: 'Researcher A',
    timestamp: 10,
    sourceKind: 'model',
    providerId: 'local',
    modelId: 'model-a',
    runId: 'run-a',
  },
  status,
  decisions: status === 'pending' ? [] : [{
    schemaVersion: 1,
    kind: 'decision',
    eventId: status === 'conflicted' ? 'decision-accept' : `decision-${status}`,
    suggestionId: 'suggestion-a',
    proposalEventId: 'proposal-a',
    decision: status === 'rejected' ? 'rejected' : 'accepted',
    reviewerId: 'reviewer-a',
    reviewerDisplayName: 'Reviewer A',
    timestamp: 20,
  }, ...(status === 'conflicted' ? [{
    schemaVersion: 1 as const,
    kind: 'decision' as const,
    eventId: 'decision-reject',
    suggestionId: 'suggestion-a',
    proposalEventId: 'proposal-a',
    decision: 'rejected' as const,
    reviewerId: 'reviewer-b',
    reviewerDisplayName: 'Reviewer B',
    timestamp: 21,
  }] : [])],
})

function editor(namespace: string) {
  return createEditor({ namespace, nodes: [SuggestionNode], onError(error) { throw error } })
}

function bind(target: LexicalEditor, provider: MemoryProjectProvider) {
  const lexicalProvider = provider as unknown as Provider
  const docs = new Map<string, Y.Doc>([['suggestion-node-document', provider.doc]])
  const binding = createBinding(target, lexicalProvider, 'suggestion-node-document', provider.doc, docs)
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

describe('suggestion node', () => {
  it('persists only stable identity and fails closed without it', () => {
    const source = editor('suggestion-json')
    source.update(() => $getRoot().append($createSuggestionNode('suggestion-a')), { discrete: true })
    const child = source.getEditorState().toJSON().root.children[0] as SerializedSuggestionNode
    expect(child).toMatchObject({ type: 'suggestion', version: 1, suggestionId: 'suggestion-a' })
    expect(JSON.stringify(child)).not.toContain('appeal process')
    expect(JSON.stringify(child)).not.toContain('providerId')
    expect(() => SuggestionNode.importJSON({ ...child, suggestionId: '' })).toThrow('stable suggestionId')
  })

  it('renders explicit pending, decided, conflicting, and missing review states', () => {
    const pending = renderToStaticMarkup(<SuggestionCard suggestion={suggestion()} suggestionId="suggestion-a" onDecision={() => undefined} />)
    expect(pending).toContain('Add an explicit appeal process.')
    expect(pending).toContain('Accept')
    expect(pending).toContain('Reject')
    expect(pending).toContain('source revision lexical-source-a')

    const accepted = renderToStaticMarkup(<SuggestionCard suggestion={suggestion('accepted')} suggestionId="suggestion-a" onDecision={() => undefined} onApply={() => undefined} />)
    expect(accepted).toContain('accepted')
    expect(accepted).toContain('Reviewer A')
    expect(accepted).toContain('Apply to draft')
    expect(accepted).toContain('only if the policy content is unchanged')
    expect(accepted).not.toContain('>Accept<')

    const conflict = renderToStaticMarkup(<SuggestionCard suggestion={suggestion('conflicted')} suggestionId="suggestion-a" onDecision={() => undefined} />)
    expect(conflict).toContain('Decision conflict')
    expect(conflict).toContain('opposite decisions')
    expect(conflict).toContain('Reviewer B')

    const missing = renderToStaticMarkup(<SuggestionCard suggestion={null} suggestionId="missing-a" onDecision={() => undefined} />)
    expect(missing).toContain('Missing suggestion')
    expect(missing).toContain('role="alert"')
  })

  it('renders pending, signed-device, and explicit unsigned attribution without human identity claims', () => {
    const pending = renderToStaticMarkup(
      <SuggestionCard suggestion={suggestion()} suggestionId="suggestion-a"
        onDecision={() => undefined} attributionPending />,
    )
    expect(pending).toContain('Saving device signature')

    const signed = renderToStaticMarkup(
      <SuggestionCard suggestion={suggestion()} suggestionId="suggestion-a"
        onDecision={() => undefined} attribution={{
          status: 'signed-device', keyId: 'ed25519-sha256:abcdefghijklmnop',
          eventKind: 'suggestion', eventId: 'proposal-a', eventSha256: 'hash',
          attestationCount: 1, authority: 'installation-device-not-human-identity',
        }} />,
    )
    expect(signed).toContain('Signed by this installation')
    expect(signed).not.toContain('verified reviewer')

    const unsigned = renderToStaticMarkup(
      <SuggestionCard suggestion={suggestion()} suggestionId="suggestion-a"
        onDecision={() => undefined} attribution={{
          status: 'unsigned', reason: 'signing-or-registration-unavailable',
          authority: 'installation-device-not-human-identity',
        }} />,
    )
    expect(unsigned).toContain('saved without a device signature')
    expect(unsigned).toContain('signing or registration was unavailable')
  })

  it('converges a stable projection across two Yjs-bound editors', async () => {
    const hub = new MemoryProjectHub()
    const leftProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'suggestion-node-document' }), hub)
    const rightProvider = new MemoryProjectProvider(new Y.Doc({ guid: 'suggestion-node-document' }), hub)
    const left = editor('suggestion-left')
    const right = editor('suggestion-right')
    const unbindLeft = bind(left, leftProvider)
    const unbindRight = bind(right, rightProvider)
    try {
      leftProvider.connect()
      rightProvider.connect()
      left.update(() => $getRoot().append($createSuggestionNode('suggestion-shared')), { discrete: true })
      await tick(20)
      const inspect = (target: LexicalEditor) => target.getEditorState().read(() =>
        $nodesOfType(SuggestionNode).map((node) => node.getSuggestionId()),
      )
      expect(inspect(left)).toEqual(['suggestion-shared'])
      expect(inspect(right)).toEqual(inspect(left))
    } finally {
      unbindLeft()
      unbindRight()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })
})
