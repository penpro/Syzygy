import { describe, expect, it } from 'vitest'
import {
  MAX_PROVIDER_STREAM_TEXT_CHARS,
  ProviderStreamProtocolError,
  applyProviderStreamEvent,
  initialProviderStreamState,
  providerStreamIsComplete,
  type ProviderStreamEvent,
} from './providerStream'

function apply(events: ProviderStreamEvent[]) {
  return events.reduce(applyProviderStreamEvent, initialProviderStreamState())
}

describe('provider stream state machine', () => {
  it('assembles a bounded successful stream without inventing shared state', () => {
    const state = apply([
      { type: 'message-start', provider: 'openai', responseId: 'response-001' },
      { type: 'text-delta', text: 'Evidence ' },
      { type: 'provider-warning', eventType: 'response.incomplete_details' },
      { type: 'text-delta', text: 'reviewed.' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      { type: 'finish', status: 'completed' },
      { type: 'stream-end' },
    ])

    expect(state).toEqual({
      phase: 'ended',
      provider: 'openai',
      responseId: 'response-001',
      text: 'Evidence reviewed.',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      finishStatus: 'completed',
      warnings: ['response.incomplete_details'],
      errorCode: null,
      toolCalls: [],
    })
    expect(providerStreamIsComplete(state)).toBe(true)
    expect(Object.keys(state)).not.toContain('project')
    expect(Object.keys(state)).not.toContain('document')
  })

  it('fails closed on missing, duplicate, or out-of-order protocol events', () => {
    expect(() => apply([{ type: 'text-delta', text: 'early' }])).toThrow(
      ProviderStreamProtocolError,
    )
    expect(() =>
      apply([
        { type: 'message-start', provider: 'openai', responseId: 'one' },
        { type: 'message-start', provider: 'openai', responseId: 'two' },
      ]),
    ).toThrow(ProviderStreamProtocolError)
    expect(() =>
      apply([
        { type: 'message-start', provider: 'openai', responseId: 'one' },
        { type: 'stream-end' },
      ]),
    ).toThrow(ProviderStreamProtocolError)
  })

  it('rejects oversized output and inconsistent token accounting', () => {
    const started = applyProviderStreamEvent(initialProviderStreamState(), {
      type: 'message-start',
      provider: 'openai',
      responseId: 'response-001',
    })
    const nearlyFull = { ...started, text: 'x'.repeat(MAX_PROVIDER_STREAM_TEXT_CHARS) }
    expect(() =>
      applyProviderStreamEvent(nearlyFull, { type: 'text-delta', text: 'overflow' }),
    ).toThrow('exceeds the product bound')
    expect(() =>
      applyProviderStreamEvent(started, {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 12 },
      }),
    ).toThrow('Inconsistent provider usage')
  })

  it('retains only a normalized provider error code', () => {
    const state = apply([
      { type: 'provider-warning', eventType: 'future.preamble' },
      { type: 'provider-error', code: 'rate-limit' },
    ])

    expect(state.phase).toBe('failed')
    expect(state.errorCode).toBe('rate-limit')
    expect(state.warnings).toEqual(['future.preamble'])
    expect(state.text).toBe('')
    expect(providerStreamIsComplete(state)).toBe(false)
  })

  it('assembles inspectable tool proposals without adding execution authority', () => {
    const state = apply([
      { type: 'message-start', provider: 'anthropic', responseId: 'response-tools' },
      { type: 'tool-call-start', callId: 'call-1', name: 'lookup_source' },
      { type: 'tool-call-delta', callId: 'call-1', argumentsDelta: '{"query":' },
      { type: 'tool-call-delta', callId: 'call-1', argumentsDelta: '"budget"}' },
      { type: 'tool-call-complete', callId: 'call-1', name: 'lookup_source', arguments: { query: 'budget' } },
      { type: 'finish', status: 'tool_use' },
      { type: 'stream-end' },
    ])

    expect(state.toolCalls).toEqual([{
      callId: 'call-1',
      name: 'lookup_source',
      argumentsText: '{"query":"budget"}',
      arguments: { query: 'budget' },
    }])
    expect(Object.keys(state)).not.toContain('execute')
    expect(Object.keys(state)).not.toContain('toolResults')
  })

  it('fails closed on orphaned, mismatched, or incomplete tool proposals', () => {
    const started = applyProviderStreamEvent(initialProviderStreamState(), {
      type: 'message-start', provider: 'openai', responseId: 'response-tools',
    })
    expect(() => applyProviderStreamEvent(started, {
      type: 'tool-call-delta', callId: 'missing', argumentsDelta: '{}',
    })).toThrow('no active call')

    const withTool = applyProviderStreamEvent(started, {
      type: 'tool-call-start', callId: 'call-1', name: 'lookup_source',
    })
    const withArguments = applyProviderStreamEvent(withTool, {
      type: 'tool-call-delta', callId: 'call-1', argumentsDelta: '{}',
    })
    expect(() => applyProviderStreamEvent(withArguments, {
      type: 'tool-call-complete', callId: 'call-1', name: 'lookup_source', arguments: { forged: true },
    })).toThrow('do not match')
    expect(() => applyProviderStreamEvent(withArguments, {
      type: 'tool-call-complete',
      callId: 'call-1',
      name: 'lookup_source',
      arguments: { query: undefined } as unknown as Record<string, unknown>,
    })).toThrow('non-JSON value')
    expect(() => applyProviderStreamEvent(withTool, {
      type: 'finish', status: 'completed',
    })).toThrow('incomplete tool call')
  })
})
