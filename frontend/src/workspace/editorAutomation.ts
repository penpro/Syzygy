import type { LexicalEditor, LexicalNode } from 'lexical'
import { $createParagraphNode, $createTextNode, $getRoot, $nodesOfType, type ElementNode } from 'lexical'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import {
  getAutomationEditorController,
  registerAutomationEditorController,
  type AutomationDocumentBlock,
  type AutomationEditorSnapshot,
} from './editorAutomationRegistry'
import { $createPolicyBlockNode, $isPolicyBlockNode } from './nodes/PolicyBlockNode'
import { $createScenarioReferenceNode, ScenarioReferenceNode } from './nodes/ScenarioReferenceNode'

export type {
  AutomationBlockKind,
  AutomationDocumentBlock,
  AutomationEditorSnapshot,
} from './editorAutomationRegistry'

interface ActiveEditor {
  projectId: string
  editor: LexicalEditor
  sessionId: string
  generation: number
}

const MAX_AUTOMATION_CONTENT = 200_000
const MAX_SEMANTIC_BLOCK_CONTENT = 500_000

export function registerAutomationEditor(projectId: string, editor: LexicalEditor): () => void {
  const registration: ActiveEditor = {
    projectId,
    editor,
    sessionId: createSessionId(),
    generation: 0,
  }
  const unregisterUpdate = editor.registerUpdateListener(() => {
    registration.generation += 1
  })
  const unregisterController = registerAutomationEditorController({
    projectId,
    read: () => snapshot(registration),
    replace: (expectedRevision, content) => replaceRegisteredDocument(registration, expectedRevision, content),
    replaceBlocks: (expectedRevision, blocks) => replaceRegisteredBlocks(registration, expectedRevision, blocks),
    append: (expectedRevision, content) => appendRegisteredDocument(registration, expectedRevision, content),
  })
  return () => {
    unregisterController()
    unregisterUpdate()
  }
}

export function readAutomationEditor(projectId?: string): AutomationEditorSnapshot {
  return getAutomationEditorController(projectId).read()
}

export function replaceAutomationDocument(
  expectedRevision: string,
  content: string,
): AutomationEditorSnapshot {
  return getAutomationEditorController().replace(expectedRevision, content)
}

function replaceRegisteredDocument(
  registration: ActiveEditor,
  expectedRevision: string,
  content: string,
): AutomationEditorSnapshot {
  validateMutation(expectedRevision, content)
  return replaceRegisteredBlocks(registration, expectedRevision, parseBlocks(content), 'syzygy-mcp-replace')
}

function replaceRegisteredBlocks(
  registration: ActiveEditor,
  expectedRevision: string,
  blocks: AutomationDocumentBlock[],
  tag = 'syzygy-version-restore',
): AutomationEditorSnapshot {
  validateExpectedRevision(expectedRevision)
  const normalized = normalizeBlocks(blocks)
  assertRevision(registration, expectedRevision)
  registration.editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      normalized.forEach((block) => root.append(createNode(block)))
    },
    { discrete: true, tag },
  )
  return snapshot(registration)
}

export function appendAutomationDocument(
  expectedRevision: string,
  content: string,
): AutomationEditorSnapshot {
  return getAutomationEditorController().append(expectedRevision, content)
}

function appendRegisteredDocument(
  registration: ActiveEditor,
  expectedRevision: string,
  content: string,
): AutomationEditorSnapshot {
  validateMutation(expectedRevision, content)
  if (!content.trim()) throw new Error('Append content cannot be empty')
  assertRevision(registration, expectedRevision)
  const blocks = parseBlocks(content)
  registration.editor.update(
    () => {
      const root = $getRoot()
      blocks.forEach((block) => root.append(createNode(block)))
    },
    { discrete: true, tag: 'syzygy-mcp-append' },
  )
  return snapshot(registration)
}

function validateExpectedRevision(expectedRevision: string): void {
  if (!expectedRevision.trim()) throw new Error('An expectedRevision from read_active_project is required')
}

function normalizeBlocks(blocks: AutomationDocumentBlock[]): AutomationDocumentBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 10_000) {
    throw new Error('Document requires a bounded non-empty block list')
  }
  let contentLength = 0
  return blocks.map((block) => {
    if (!block || typeof block !== 'object' || !['heading1', 'heading2', 'quote', 'paragraph', 'policy'].includes(block.kind) ||
      typeof block.text !== 'string' || block.text.includes('\u0000')) {
      throw new Error('Document contains an invalid semantic block')
    }
    contentLength += block.text.length
    if (contentLength > MAX_SEMANTIC_BLOCK_CONTENT) {
      throw new Error(`Document content exceeds the ${MAX_SEMANTIC_BLOCK_CONTENT.toLocaleString()} character limit`)
    }
    if (block.kind === 'policy') {
      if (!block.policyId || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(block.policyId) ||
        !block.status || !['draft', 'review', 'approved'].includes(block.status)) {
        throw new Error('Policy automation block requires identity and status')
      }
      return { kind: block.kind, text: block.text, policyId: block.policyId, status: block.status }
    }
    return { kind: block.kind, text: block.text }
  })
}

function validateMutation(expectedRevision: string, content: string): void {
  validateExpectedRevision(expectedRevision)
  if (typeof content !== 'string') throw new Error('Document content must be text')
  if (content.length > MAX_AUTOMATION_CONTENT) {
    throw new Error(`Document content exceeds the ${MAX_AUTOMATION_CONTENT.toLocaleString()} character limit`)
  }
}

function assertRevision(registration: ActiveEditor, expectedRevision: string): void {
  const actualRevision = snapshot(registration).revision
  if (actualRevision !== expectedRevision) {
    throw new Error(
      `Revision conflict: expected ${expectedRevision}, but the live draft is ${actualRevision}. Read the project again and reconcile before writing.`,
    )
  }
}

function snapshot(registration: ActiveEditor): AutomationEditorSnapshot {
  const editorState = registration.editor.getEditorState()
  const { blocks, scenarioIds } = editorState.read(() => ({
    blocks: $getRoot().getChildren().map(readBlock),
    scenarioIds: $nodesOfType(ScenarioReferenceNode).map((node) => node.getScenarioId()).sort(),
  }))
  const serialized = JSON.stringify(editorState.toJSON())
  return {
    projectId: registration.projectId,
    revision: `lexical-${registration.sessionId}-${registration.generation}-${fnv1a(serialized)}`,
    text: blocks.map(formatBlock).join('\n'),
    blocks,
    scenarioIds: [...new Set(scenarioIds)],
  }
}

function readBlock(node: LexicalNode): AutomationDocumentBlock {
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
}

function formatBlock(block: AutomationDocumentBlock): string {
  if (block.kind === 'policy') return `[policy:${block.policyId}:${block.status}] ${block.text}`
  if (block.kind === 'heading1') return `# ${block.text}`
  if (block.kind === 'heading2') return `## ${block.text}`
  if (block.kind === 'quote') return `> ${block.text}`
  return block.text
}

function parseBlocks(content: string): AutomationDocumentBlock[] {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const blocks = lines.map<AutomationDocumentBlock>((line) => {
    const policy = /^\[policy:([A-Za-z0-9][A-Za-z0-9._-]{0,199}):(draft|review|approved)\] (.*)$/.exec(line)
    if (policy) {
      return { kind: 'policy', policyId: policy[1], status: policy[2] as 'draft' | 'review' | 'approved', text: policy[3] }
    }
    if (line.startsWith('## ')) return { kind: 'heading2', text: line.slice(3) }
    if (line.startsWith('# ')) return { kind: 'heading1', text: line.slice(2) }
    if (line.startsWith('> ')) return { kind: 'quote', text: line.slice(2) }
    return { kind: 'paragraph', text: line }
  })
  return blocks.length ? blocks : [{ kind: 'paragraph', text: '' }]
}

function createNode(block: AutomationDocumentBlock): LexicalNode {
  let node: ElementNode
  if (block.kind === 'policy') {
    if (!block.policyId || !block.status) throw new Error('Policy automation block requires identity and status')
    node = $createPolicyBlockNode(block.policyId, block.status)
  } else if (block.kind === 'heading1') node = $createHeadingNode('h1')
  else if (block.kind === 'heading2') node = $createHeadingNode('h2')
  else if (block.kind === 'quote') node = $createQuoteNode()
  else node = $createParagraphNode()
  appendInlineContent(node, block.text)
  return node
}

function appendInlineContent(node: ElementNode, text: string): void {
  const pattern = /\[scenario:([A-Za-z0-9][A-Za-z0-9._:@-]{0,199})\]/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? offset
    if (index > offset) node.append($createTextNode(text.slice(offset, index)))
    node.append($createScenarioReferenceNode(match[1]))
    offset = index + match[0].length
  }
  if (offset < text.length || node.getChildrenSize() === 0) node.append($createTextNode(text.slice(offset)))
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(0, 12)
}
