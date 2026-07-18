import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { ReactElement } from 'react'
import { scenarioReferenceLabel, useScenarioReferenceState } from '../ScenarioReferenceContext'
import { $createScenarioReferenceNode } from './ScenarioReferenceNode'

export type SerializedScenarioSpotlightNode = Spread<
  {
    scenarioId: string
    type: 'scenario-spotlight'
    version: 1
  },
  SerializedLexicalNode
>

function validScenarioId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value)
}

function ScenarioSpotlightCard({ scenarioId, nodeKey }: { scenarioId: string; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext()
  const { scenarios } = useScenarioReferenceState()
  const scenario = scenarios.find((candidate) => candidate.id === scenarioId)
  const reference = scenarioReferenceLabel(scenarios, scenarioId)
  const collapse = () => {
    editor.update(
      () => {
        const node = $getNodeByKey(nodeKey)
        if ($isScenarioSpotlightNode(node)) $unembedScenarioSpotlight(node)
      },
      { tag: 'syzygy-scenario-unembed' },
    )
  }

  return (
    <section
      className={`scenario-spotlight${reference.missing ? ' missing' : ''}`}
      data-scenario-id={scenarioId}
      aria-label={`Spotlight scenario: ${reference.label}`}
    >
      <header>
        <span className="mono">Scenario spotlight</span>
        <strong>{reference.label}</strong>
        {scenario ? <span className="mono subtle">{scenario.status}</span> : null}
      </header>
      {scenario?.background ? <p>{scenario.background}</p> : null}
      {scenario?.turns.length ? (
        <ol>
          {scenario.turns.map((turn) => (
            <li key={turn.id}>
              <span className="mono">{turn.role}</span>
              <span>{turn.content}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="subtle">{reference.missing ? 'The linked scenario is not available in this project.' : 'No scenario turns yet.'}</p>
      )}
      <footer>
        <span className="mono subtle">{scenarioId}</span>
        <button type="button" className="btn sm ghost" onClick={collapse}>
          Collapse to scenario link
        </button>
      </footer>
    </section>
  )
}

/** Block-level, project-relative scenario projection. Only the stable scenario ID is persisted. */
export class ScenarioSpotlightNode extends DecoratorNode<ReactElement> {
  __scenarioId: string

  static getType(): string {
    return 'scenario-spotlight'
  }

  static clone(node: ScenarioSpotlightNode): ScenarioSpotlightNode {
    return new ScenarioSpotlightNode(node.__scenarioId, node.__key)
  }

  static importJSON(serializedNode: SerializedScenarioSpotlightNode): ScenarioSpotlightNode {
    if (!validScenarioId(serializedNode.scenarioId)) throw new Error('Scenario spotlight requires a stable scenarioId')
    return new ScenarioSpotlightNode(serializedNode.scenarioId)
  }

  constructor(scenarioId = '', key?: NodeKey) {
    super(key)
    this.__scenarioId = scenarioId
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    element.className = 'scenario-spotlight-host'
    return element
  }

  updateDOM(): false {
    return false
  }

  decorate(): ReactElement {
    return <ScenarioSpotlightCard scenarioId={this.getScenarioId()} nodeKey={this.getKey()} />
  }

  exportJSON(): SerializedScenarioSpotlightNode {
    if (!validScenarioId(this.__scenarioId)) throw new Error('Scenario spotlight requires a stable scenarioId')
    return {
      ...super.exportJSON(),
      scenarioId: this.__scenarioId,
      type: 'scenario-spotlight',
      version: 1,
    }
  }

  getScenarioId(): string {
    return this.getLatest().__scenarioId
  }

  getTextContent(): string {
    return `[spotlight:${this.getScenarioId()}]`
  }

  isInline(): false {
    return false
  }
}

export function $createScenarioSpotlightNode(scenarioId: string): ScenarioSpotlightNode {
  if (!validScenarioId(scenarioId)) throw new Error('Scenario spotlight requires a stable scenarioId')
  return $applyNodeReplacement(new ScenarioSpotlightNode(scenarioId))
}

export function $isScenarioSpotlightNode(node: LexicalNode | null | undefined): node is ScenarioSpotlightNode {
  return node instanceof ScenarioSpotlightNode
}

export function $unembedScenarioSpotlight(node: ScenarioSpotlightNode): void {
  const paragraph = $createParagraphNode().append($createScenarioReferenceNode(node.getScenarioId()))
  node.replace(paragraph)
}
