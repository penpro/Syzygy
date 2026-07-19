import {
  $applyNodeReplacement,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { useState, type ReactElement } from 'react'
import { useSuggestionState } from '../SuggestionContext'
import type { CollaborativeSuggestion, SuggestionDecisionKind } from '../suggestionModel'

export type SerializedSuggestionNode = Spread<
  {
    suggestionId: string
    type: 'suggestion'
    version: 1
  },
  SerializedLexicalNode
>

function validSuggestionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value)
}

export function SuggestionCard({
  suggestion,
  suggestionId,
  onDecision,
  onApply,
}: {
  suggestion: CollaborativeSuggestion | null
  suggestionId: string
  onDecision: (decision: SuggestionDecisionKind) => void
  onApply?: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const act = (operation: () => void) => {
    setError(null)
    try {
      operation()
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    }
  }
  const decide = (decision: SuggestionDecisionKind) => act(() => onDecision(decision))

  if (!suggestion) {
    return (
      <section className="research-suggestion missing" data-suggestion-id={suggestionId} role="alert">
        <header><span className="mono">Missing suggestion</span></header>
        <p>The shared proposal is unavailable or failed validation.</p>
        <footer><span className="mono subtle">{suggestionId}</span></footer>
      </section>
    )
  }

  const proposal = suggestion.proposal
  const source = proposal.sourceKind === 'model'
    ? `${proposal.providerId} · ${proposal.modelId} · run ${proposal.runId}`
    : `Human proposal · ${proposal.authorDisplayName}`
  return (
    <section
      className={`research-suggestion ${suggestion.status}`}
      data-suggestion-id={suggestionId}
      aria-label={`Suggestion: ${suggestion.status}`}
    >
      <header>
        <span className="mono">Suggestion</span>
        <strong>{suggestion.status === 'conflicted' ? 'Decision conflict' : suggestion.status}</strong>
      </header>
      <p className="suggestion-preview">{suggestion.content}</p>
      <div className="suggestion-provenance mono">
        {source} · source revision {suggestion.sourceDocumentRevision}
      </div>
      {suggestion.status === 'pending' ? (
        <div className="suggestion-actions" aria-label="Review suggestion">
          <button type="button" className="btn sm primary" onClick={() => decide('accepted')}>Accept</button>
          <button type="button" className="btn sm ghost" onClick={() => decide('rejected')}>Reject</button>
        </div>
      ) : null}
      {suggestion.status === 'accepted' && onApply ? (
        <div className="suggestion-actions" aria-label="Apply accepted suggestion">
          <button type="button" className="btn sm primary" onClick={() => act(onApply)}>Apply to draft</button>
          <span>Replaces this card with a review policy block only if the policy content is unchanged.</span>
        </div>
      ) : null}
      {suggestion.status === 'conflicted' ? (
        <p role="alert">Two collaborators made opposite decisions while disconnected. Review the decision history before applying this proposal.</p>
      ) : null}
      {suggestion.decisions.length > 0 ? (
        <ul className="suggestion-decisions" aria-label="Suggestion decision history">
          {suggestion.decisions.map((decision) => (
            <li key={decision.eventId}>
              <span className="mono">{decision.decision}</span> by {decision.reviewerDisplayName}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="suggestion-error" role="alert">{error}</p> : null}
      <footer><span className="mono subtle">{suggestionId}</span></footer>
    </section>
  )
}

function ConnectedSuggestionCard({ suggestionId }: { suggestionId: string }) {
  const { suggestions, decide, apply } = useSuggestionState()
  const suggestion = suggestions.find(({ id }) => id === suggestionId) ?? null
  return (
    <SuggestionCard
      suggestion={suggestion}
      suggestionId={suggestionId}
      onDecision={(decision) => {
        if (!suggestion) throw new Error('Suggestion is unavailable')
        decide(suggestionId, suggestion.proposal.eventId, decision)
      }}
      onApply={suggestion?.status === 'accepted' ? () => {
        const accepted = suggestion.decisions.find(({ decision }) => decision === 'accepted')
        if (!accepted) throw new Error('Accepted decision is unavailable')
        apply(suggestionId, suggestion.proposal.eventId, accepted.eventId)
      } : undefined}
    />
  )
}

/** Stable project-relative projection of a shared proposal and its immutable human decisions. */
export class SuggestionNode extends DecoratorNode<ReactElement> {
  __suggestionId: string

  static getType(): string {
    return 'suggestion'
  }

  static clone(node: SuggestionNode): SuggestionNode {
    return new SuggestionNode(node.__suggestionId, node.__key)
  }

  static importJSON(serializedNode: SerializedSuggestionNode): SuggestionNode {
    if (!validSuggestionId(serializedNode.suggestionId)) throw new Error('Suggestion node requires a stable suggestionId')
    return new SuggestionNode(serializedNode.suggestionId)
  }

  constructor(suggestionId = '', key?: NodeKey) {
    super(key)
    this.__suggestionId = suggestionId
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement('div')
    element.className = 'research-suggestion-host'
    return element
  }

  updateDOM(): false {
    return false
  }

  decorate(): ReactElement {
    return <ConnectedSuggestionCard suggestionId={this.getSuggestionId()} />
  }

  exportJSON(): SerializedSuggestionNode {
    if (!validSuggestionId(this.__suggestionId)) throw new Error('Suggestion node requires a stable suggestionId')
    return {
      ...super.exportJSON(),
      suggestionId: this.__suggestionId,
      type: 'suggestion',
      version: 1,
    }
  }

  getSuggestionId(): string {
    return this.getLatest().__suggestionId
  }

  getTextContent(): string {
    return `[suggestion:${this.getSuggestionId()}]`
  }

  isInline(): false {
    return false
  }
}

export function $createSuggestionNode(suggestionId: string): SuggestionNode {
  if (!validSuggestionId(suggestionId)) throw new Error('Suggestion node requires a stable suggestionId')
  return $applyNodeReplacement(new SuggestionNode(suggestionId))
}

export function $isSuggestionNode(node: LexicalNode | null | undefined): node is SuggestionNode {
  return node instanceof SuggestionNode
}
