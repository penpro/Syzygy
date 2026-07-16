import { $getRoot, createEditor, type LexicalEditor } from 'lexical'
import { $isHeadingNode, $isQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
} from '@lexical/yjs'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { getAutomationEditorController, type AutomationDocumentBlock } from './editorAutomationRegistry'
import { registerAutomationEditor } from './editorAutomation'
import { MemoryProjectHub, MemoryProjectProvider } from './memoryProvider'
import { $isPolicyBlockNode, PolicyBlockNode } from './nodes/PolicyBlockNode'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import { readPolicyVersionHead } from './policyVersionModel'
import { createProjectManifest } from './schema'
import { restoreAutomationPolicyVersion, saveAutomationPolicyVersion } from './versionAutomation'

const manifest = createProjectManifest({
  id: 'restore-integration-project',
  documentId: 'restore-integration-document',
  timestamp: 1,
})

const rootBlocks: AutomationDocumentBlock[] = [
  { kind: 'heading1', text: 'Access policy' },
  { kind: 'policy', policyId: 'access-rule', status: 'review', text: 'Require one source.' },
]

const changedBlocks: AutomationDocumentBlock[] = [
  { kind: 'heading1', text: 'Access policy' },
  { kind: 'policy', policyId: 'access-rule', status: 'approved', text: 'Require two independent sources.' },
]

function researchEditor(namespace: string) {
  return createEditor({
    namespace,
    nodes: [HeadingNode, QuoteNode, PolicyBlockNode],
    onError(error) {
      throw error
    },
  })
}

function bind(editor: LexicalEditor, provider: MemoryProjectProvider) {
  const lexicalProvider = provider as unknown as Provider
  const docMap = new Map<string, Y.Doc>([[manifest.documentId, provider.doc]])
  const binding = createBinding(editor, lexicalProvider, manifest.documentId, provider.doc, docMap)
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
  return {
    root: sharedRoot,
    cleanup: () => {
      sharedRoot.unobserveDeep(onRemote)
      removeUpdate()
    },
  }
}

function readBlocks(editor: LexicalEditor): AutomationDocumentBlock[] {
  return editor.getEditorState().read(() => $getRoot().getChildren().map((node) => {
    if ($isPolicyBlockNode(node)) {
      return {
        kind: 'policy',
        text: node.getTextContent(),
        policyId: node.getPolicyId(),
        status: node.getStatus(),
      }
    }
    if ($isHeadingNode(node)) {
      return { kind: node.getTag() === 'h1' ? 'heading1' : 'heading2', text: node.getTextContent() }
    }
    if ($isQuoteNode(node)) return { kind: 'quote', text: node.getTextContent() }
    return { kind: 'paragraph', text: node.getTextContent() }
  }))
}

describe('live two-peer version restore integration', () => {
  it('delivers the restored Lexical root and new immutable head to a peer in one Yjs update', async () => {
    const hub = new MemoryProjectHub()
    const leftDoc = createProjectDocument(manifest)
    const rightDoc = createProjectDocument(manifest)
    const leftProvider = new MemoryProjectProvider(leftDoc, hub)
    const rightProvider = new MemoryProjectProvider(rightDoc, hub)
    const left = researchEditor('restore-integration-left')
    const right = researchEditor('restore-integration-right')
    const leftBinding = bind(left, leftProvider)
    const rightBinding = bind(right, rightProvider)
    let unregisterEditor: (() => void) | null = null
    try {
      leftProvider.connect()
      rightProvider.connect()
      unregisterEditor = registerAutomationEditor(manifest.id, left)
      const controller = getAutomationEditorController(manifest.id)
      controller.replaceBlocks(controller.read().revision, rootBlocks)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(readBlocks(right)).toEqual(rootBlocks)

      const firstDraft = controller.read()
      const root = await saveAutomationPolicyVersion(leftDoc, manifest.id, {
        expectedDocumentRevision: firstDraft.revision,
        expectedHeadVersionId: null,
        participantId: 'researcher-1',
        displayName: 'Ada',
        createdAt: 10,
        note: 'Initial',
      }, controller.read)
      controller.replaceBlocks(controller.read().revision, changedBlocks)
      const currentDraft = controller.read()
      const child = await saveAutomationPolicyVersion(leftDoc, manifest.id, {
        expectedDocumentRevision: currentDraft.revision,
        expectedHeadVersionId: root.version.versionId,
        participantId: 'researcher-1',
        displayName: 'Ada',
        createdAt: 20,
        note: 'Current',
      }, controller.read)

      const peerTransactions: Array<{
        head: string | null
        rootChanged: boolean
        metadataChanged: boolean
        versionsChanged: boolean
        versions: number
      }> = []
      rightDoc.on('afterTransaction', (transaction) => {
        if (transaction.origin !== hub) return
        const { metadata, versions } = getProjectSharedTypes(rightDoc)
        const changedTypes = transaction.changedParentTypes as ReadonlyMap<unknown, unknown>
        peerTransactions.push({
          head: readPolicyVersionHead(metadata),
          rootChanged: changedTypes.has(rightBinding.root),
          metadataChanged: changedTypes.has(metadata),
          versionsChanged: changedTypes.has(versions),
          versions: versions.size,
        })
      })

      const restored = await restoreAutomationPolicyVersion(leftDoc, manifest.id, {
        targetVersionId: root.version.versionId,
        expectedDocumentRevision: controller.read().revision,
        expectedHeadVersionId: child.version.versionId,
        participantId: 'researcher-1',
        displayName: 'Ada',
        createdAt: 30,
      }, controller)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(controller.read().blocks).toEqual(rootBlocks)
      expect(readBlocks(right)).toEqual(rootBlocks)
      const peerShared = getProjectSharedTypes(rightDoc)
      expect(readPolicyVersionHead(peerShared.metadata)).toBe(restored.version.versionId)
      expect(peerShared.versions.size).toBe(3)
      expect(peerTransactions).toEqual([{
        head: restored.version.versionId,
        rootChanged: true,
        metadataChanged: true,
        versionsChanged: true,
        versions: 3,
      }])
    } finally {
      unregisterEditor?.()
      leftBinding.cleanup()
      rightBinding.cleanup()
      await Promise.all([leftProvider.destroy(), rightProvider.destroy()])
    }
  })
})