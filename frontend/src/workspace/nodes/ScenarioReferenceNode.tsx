import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { ReactElement } from 'react'
import { scenarioReferenceLabel, useScenarioReferenceState } from '../ScenarioReferenceContext'

export type SerializedScenarioReferenceNode = Spread<
  {
    scenarioId: string
    type: 'scenario-reference'
    version: 1
  },
  SerializedLexicalNode
>

function validScenarioId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value)
}

function ScenarioReferenceChip({ scenarioId }: { scenarioId: string }) {
  const { scenarios } = useScenarioReferenceState()
  const reference = scenarioReferenceLabel(scenarios, scenarioId)
  return (
    <span
      className={`scenario-reference-chip${reference.missing ? ' missing' : ''}`}
      data-scenario-id={scenarioId}
      aria-label={`Scenario reference: ${reference.label}`}
      title={reference.missing ? 'This scenario is not available in the shared project.' : `Linked to scenario ${scenarioId}`}
    >
      <span aria-hidden="true">Scenario</span>
      {reference.label}
    </span>
  )
}

/** Inline project-relative scenario link. The stable ID is the only persisted display input. */
export class ScenarioReferenceNode extends DecoratorNode<ReactElement> {
  __scenarioId: string

  static getType(): string {
    return 'scenario-reference'
  }

  static clone(node: ScenarioReferenceNode): ScenarioReferenceNode {
    return new ScenarioReferenceNode(node.__scenarioId, node.__key)
  }

  static importJSON(serializedNode: SerializedScenarioReferenceNode): ScenarioReferenceNode {
    if (!validScenarioId(serializedNode.scenarioId)) throw new Error('Scenario reference requires a stable scenarioId')
    return new ScenarioReferenceNode(serializedNode.scenarioId)
  }

  constructor(scenarioId = '', key?: NodeKey) {
    super(key)
    // Yjs constructs registered nodes with no arguments before applying shared properties.
    this.__scenarioId = scenarioId
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('span')
    element.className = 'scenario-reference-host'
    return element
  }

  updateDOM(): false {
    return false
  }

  decorate(): ReactElement {
    return <ScenarioReferenceChip scenarioId={this.getScenarioId()} />
  }

  exportJSON(): SerializedScenarioReferenceNode {
    if (!validScenarioId(this.__scenarioId)) throw new Error('Scenario reference requires a stable scenarioId')
    return {
      ...super.exportJSON(),
      scenarioId: this.__scenarioId,
      type: 'scenario-reference',
      version: 1,
    }
  }

  getScenarioId(): string {
    return this.getLatest().__scenarioId
  }

  getTextContent(): string {
    return `[scenario:${this.getScenarioId()}]`
  }

  isInline(): true {
    return true
  }
}

export function $createScenarioReferenceNode(scenarioId: string): ScenarioReferenceNode {
  if (!validScenarioId(scenarioId)) throw new Error('Scenario reference requires a stable scenarioId')
  return $applyNodeReplacement(new ScenarioReferenceNode(scenarioId))
}

export function $isScenarioReferenceNode(node: LexicalNode | null | undefined): node is ScenarioReferenceNode {
  return node instanceof ScenarioReferenceNode
}
