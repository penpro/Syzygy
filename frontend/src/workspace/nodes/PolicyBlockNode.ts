import {
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  ParagraphNode,
  type SerializedParagraphNode,
  type Spread,
} from 'lexical'

export type PolicyBlockStatus = 'draft' | 'review' | 'approved'

export type SerializedPolicyBlockNode = Spread<
  {
    policyId: string
    status: PolicyBlockStatus
    type: 'policy-block'
    version: 1
  },
  SerializedParagraphNode
>

const statuses = new Set<PolicyBlockStatus>(['draft', 'review', 'approved'])

function validPolicyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
}

function policyStatus(value: unknown): PolicyBlockStatus {
  return statuses.has(value as PolicyBlockStatus) ? (value as PolicyBlockStatus) : 'draft'
}

/** Editable, collaborative policy statement with stable identity and review state. */
export class PolicyBlockNode extends ParagraphNode {
  __policyId: string
  __status: PolicyBlockStatus

  static getType(): string {
    return 'policy-block'
  }

  static clone(node: PolicyBlockNode): PolicyBlockNode {
    return new PolicyBlockNode(node.__policyId, node.__status, node.__key)
  }

  static importJSON(serializedNode: SerializedPolicyBlockNode): PolicyBlockNode {
    if (!validPolicyId(serializedNode.policyId)) throw new Error('Policy block requires a stable policyId')
    return new PolicyBlockNode(serializedNode.policyId, policyStatus(serializedNode.status)).updateFromJSON(serializedNode)
  }

  constructor(policyId = '', status: PolicyBlockStatus = 'draft', key?: NodeKey) {
    super(key)
    // Every custom property is initialized even for zero-argument Yjs construction.
    this.__policyId = policyId
    this.__status = policyStatus(status)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config)
    element.classList.add('research-policy-block')
    element.dataset.policyId = this.getPolicyId()
    element.dataset.policyStatus = this.getStatus()
    return element
  }

  updateDOM(previous: PolicyBlockNode, dom: HTMLElement, config: EditorConfig): boolean {
    const replace = super.updateDOM(previous, dom, config)
    if (previous.__policyId !== this.__policyId) dom.dataset.policyId = this.__policyId
    if (previous.__status !== this.__status) dom.dataset.policyStatus = this.__status
    return replace
  }

  exportJSON(): SerializedPolicyBlockNode {
    if (!validPolicyId(this.__policyId)) throw new Error('Policy block requires a stable policyId')
    return {
      ...super.exportJSON(),
      policyId: this.__policyId,
      status: this.__status,
      type: 'policy-block',
      version: 1,
    }
  }

  getPolicyId(): string {
    return this.getLatest().__policyId
  }

  setPolicyId(policyId: string): this {
    if (!validPolicyId(policyId)) throw new Error('Policy block requires a stable policyId')
    this.getWritable().__policyId = policyId.trim()
    return this
  }

  getStatus(): PolicyBlockStatus {
    return this.getLatest().__status
  }

  setStatus(status: PolicyBlockStatus): this {
    this.getWritable().__status = policyStatus(status)
    return this
  }
}

export function $createPolicyBlockNode(policyId: string, status: PolicyBlockStatus = 'draft'): PolicyBlockNode {
  if (!validPolicyId(policyId)) throw new Error('Policy block requires a stable policyId')
  return $applyNodeReplacement(new PolicyBlockNode(policyId.trim(), status))
}

export function $isPolicyBlockNode(node: LexicalNode | null | undefined): node is PolicyBlockNode {
  return node instanceof PolicyBlockNode
}

/**
 * Move the existing live node without also copying its adjacent sibling. Lexical's Yjs binding
 * still serializes a root move as delete/insert, so the expected-failure partition fixture remains
 * the gate before remote transports may claim move-versus-edit safety. Current product use is the
 * single local IndexedDB provider.
 */
export function $movePolicyBlock(node: PolicyBlockNode, direction: 'up' | 'down'): PolicyBlockNode | null {
  const sibling = direction === 'up' ? node.getPreviousSibling() : node.getNextSibling()
  if (!sibling || !node.getParent()) return null
  if (direction === 'up') sibling.insertBefore(node)
  else sibling.insertAfter(node)
  return node
}
