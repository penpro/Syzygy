import {
  $createTextNode,
  $isTextNode,
  $parseSerializedNode,
  type LexicalNode,
} from 'lexical'
import {
  normalizePolicyContentDelta,
  type PolicyContentDelta,
  type PolicyContentSegment,
  type PolicyTextAttributes,
  type StablePolicyStatus,
} from './policyContentModel'
import type { PolicyBlockNode } from './nodes/PolicyBlockNode'

function textAttributes(node: ReturnType<typeof $createTextNode>): PolicyTextAttributes {
  const result: PolicyTextAttributes = {}
  if (node.getFormat()) result.format = node.getFormat()
  if (node.getStyle()) result.style = node.getStyle()
  if (node.getDetail()) result.detail = node.getDetail()
  if (node.getMode() !== 'normal') result.mode = node.getMode()
  return result
}

function sameAttributes(left: PolicyTextAttributes | undefined, right: PolicyTextAttributes | undefined): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {})
}

function appendSegment(delta: PolicyContentDelta, segment: PolicyContentSegment): void {
  const previous = delta[delta.length - 1]
  if (previous && typeof previous.insert === 'string' && typeof segment.insert === 'string' &&
    sameAttributes(previous.attributes, segment.attributes)) {
    previous.insert += segment.insert
    return
  }
  delta.push(segment)
}

export function readPolicyBlockContent(node: PolicyBlockNode): PolicyContentDelta {
  const delta: PolicyContentDelta = []
  for (const child of node.getChildren()) {
    if ($isTextNode(child)) {
      const attributes = textAttributes(child)
      appendSegment(delta, Object.keys(attributes).length
        ? { insert: child.getTextContent(), attributes }
        : { insert: child.getTextContent() })
      continue
    }
    appendSegment(delta, {
      insert: {
        schemaVersion: 1,
        kind: 'lexical-node',
        node: child.exportJSON(),
      },
    })
  }
  return normalizePolicyContentDelta(delta)
}

function lexicalChildren(deltaValue: unknown): LexicalNode[] {
  const delta = normalizePolicyContentDelta(deltaValue)
  return delta.map(({ insert, attributes = {} }) => {
    if (typeof insert !== 'string') {
      const child = $parseSerializedNode(insert.node)
      if ($isTextNode(child) || !child.isInline()) throw new Error('Policy content embed must be a non-text inline node')
      return child
    }
    const child = $createTextNode(insert)
    if (attributes.format !== undefined) child.setFormat(attributes.format)
    if (attributes.style !== undefined) child.setStyle(attributes.style)
    if (attributes.detail !== undefined) child.setDetail(attributes.detail)
    if (attributes.mode !== undefined) child.setMode(attributes.mode)
    return child
  })
}

export function replacePolicyBlockContent(
  node: PolicyBlockNode,
  deltaValue: unknown,
  status: StablePolicyStatus,
): void {
  const children = lexicalChildren(deltaValue)
  node.clear()
  if (children.length) node.append(...children)
  node.setStatus(status)
}
