import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyProviderStreamEvent, initialProviderStreamState } from '../providerStream'
import { providerUsesNativeStreaming, RemoteResearchReviewResult } from './RemoteResearchReview'

describe('remote research streaming result', () => {
  it('routes every built-in remote provider through the native streaming channel', () => {
    expect(providerUsesNativeStreaming('openai')).toBe(true)
    expect(providerUsesNativeStreaming('anthropic')).toBe(true)
    expect(providerUsesNativeStreaming('gemini')).toBe(true)
    expect(providerUsesNativeStreaming('xai')).toBe(true)
  })

  it('renders incremental text as a transient review without implying a shared-draft mutation', () => {
    let streamState = initialProviderStreamState()
    streamState = applyProviderStreamEvent(streamState, {
      type: 'message-start',
      provider: 'openai',
      responseId: 'response-001',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'text-delta',
      text: 'Incremental adversarial finding.',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'usage',
      usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    })

    const html = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="openai"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
      />,
    )

    expect(html).toContain('openai · fixture-model · 12 tokens')
    expect(html).toContain('Incremental adversarial finding.')
    expect(html).toContain('Transient review · never applied to the shared draft automatically')
    expect(html).toContain('aria-live="polite"')
  })

  it('renders tool calls as proposal-only artifacts even when no prose is returned', () => {
    let streamState = initialProviderStreamState()
    streamState = applyProviderStreamEvent(streamState, {
      type: 'message-start', provider: 'xai', responseId: 'response-tool',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-start', callId: 'call-tool', name: 'lookup_source',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-delta', callId: 'call-tool', argumentsDelta: '{"query":"budget"}',
    })
    streamState = applyProviderStreamEvent(streamState, {
      type: 'tool-call-complete', callId: 'call-tool', name: 'lookup_source', arguments: { query: 'budget' },
    })

    const html = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="xai"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
        toolDefinitions={[{
          name: 'lookup_source',
          description: 'Propose a bounded source lookup.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        }]}
      />,
    )
    expect(html).toContain('Tool proposals · inspect only · not executed')
    expect(html).toContain('lookup_source')
    expect(html).toContain('&quot;query&quot;: &quot;budget&quot;')
    expect(html).toContain('Schema matches · domain unreviewed · not executable')
    expect(html).not.toContain('Run tool')
  })

  it('renders schema failure and missing-definition state without creating an execution control', () => {
    let streamState = initialProviderStreamState()
    for (const event of [
      { type: 'message-start' as const, provider: 'anthropic', responseId: 'response-invalid' },
      { type: 'tool-call-start' as const, callId: 'call-invalid', name: 'lookup_source' },
      { type: 'tool-call-delta' as const, callId: 'call-invalid', argumentsDelta: '{"query":42}' },
      { type: 'tool-call-complete' as const, callId: 'call-invalid', name: 'lookup_source', arguments: { query: 42 } },
    ]) streamState = applyProviderStreamEvent(streamState, event)

    const invalid = renderToStaticMarkup(
      <RemoteResearchReviewResult
        provider="anthropic"
        model="fixture-model"
        outcome={null}
        streamState={streamState}
        toolDefinitions={[{
          name: 'lookup_source',
          description: 'Propose a bounded source lookup.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }]}
      />,
    )
    expect(invalid).toContain('Schema mismatch · domain unreviewed · not executable')
    expect(invalid).toContain('Schema issues:')

    const missing = renderToStaticMarkup(
      <RemoteResearchReviewResult provider="anthropic" model="fixture-model" outcome={null} streamState={streamState} />,
    )
    expect(missing).toContain('Definition missing · domain unreviewed · not executable')
    expect(missing).not.toContain('Run tool')
  })
})
