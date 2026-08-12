import { describe, expect, it } from 'vitest'
import {
  buildRemoteReviewRequest,
  parseProviderToolDefinitions,
  REMOTE_REVIEW_PROVIDERS,
  SOURCE_LOCATOR_TOOL_NAME,
} from './remoteResearchTask'

const draft = {
  projectId: 'project-1',
  documentId: 'document-1',
  projectTitle: 'Access policy',
  revision: 'revision-7',
  text: 'Only supplied policy text should leave after native approval.',
}

describe('remote research review request', () => {
  it('publishes editable current model defaults for all four built-in routes', () => {
    expect(REMOTE_REVIEW_PROVIDERS).toEqual([
      { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.2' },
      { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
      { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-3.5-flash' },
      { id: 'xai', name: 'xAI', defaultModel: 'grok-4.5' },
    ])
  })

  it('binds one current draft snapshot without forging disclosure or provenance fields', async () => {
    const request = await buildRemoteReviewRequest({
      provider: 'anthropic', model: ' claude-sonnet-5 ', question: ' Find unsupported claims. ',
      runId: 'run-1', callId: 'call-1', draft,
    })
    expect(request).toMatchObject({
      provider: 'anthropic', model: 'claude-sonnet-5', question: 'Find unsupported claims.',
      taskType: 'research.remote-review', timeoutMs: 120_000, maxOutputTokens: 1_200,
    })
    expect(request.sources).toHaveLength(1)
    expect(request.sources[0]).toMatchObject({ label: 'Current shared draft: Access policy', excerpt: draft.text })
    expect(request.sources[0].snapshotId).toMatch(/^document-document-1-[a-f0-9]{64}$/)
    expect(request).not.toHaveProperty('contentCategories')
    expect(request).not.toHaveProperty('approval')
    expect(request).not.toHaveProperty('apiKey')
  })

  it('changes snapshot identity when the revision or content changes and rejects empty work', async () => {
    const common = { provider: 'openai' as const, model: 'gpt-5.2', question: 'Review it', runId: 'run-1', callId: 'call-1' }
    const first = await buildRemoteReviewRequest({ ...common, draft })
    const changed = await buildRemoteReviewRequest({ ...common, draft: { ...draft, revision: 'revision-8' } })
    expect(changed.sources[0].snapshotId).not.toBe(first.sources[0].snapshotId)
    await expect(buildRemoteReviewRequest({ ...common, question: ' ', draft })).rejects.toThrow('Enter a review question')
    await expect(buildRemoteReviewRequest({ ...common, draft: { ...draft, text: ' ' } })).rejects.toThrow('current draft is empty')
  })

  it('accepts bounded custom tool schemas as proposal-only request content', async () => {
    const tools = parseProviderToolDefinitions(JSON.stringify([{
      name: 'lookup_source',
      description: 'Propose a source lookup for human inspection.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }]))
    const request = await buildRemoteReviewRequest({
      provider: 'gemini', model: 'gemini-3.5-flash', question: 'Find evidence gaps',
      runId: 'run-tools', callId: 'call-tools', draft, toolDefinitions: tools,
    })
    expect(request.toolDefinitions).toEqual(tools)
    expect(request).not.toHaveProperty('toolResults')
    expect(request).not.toHaveProperty('executeTools')

    expect(() => parseProviderToolDefinitions('[{"name":"bad space","description":"x","parameters":{"type":"object"}}]')).toThrow('Tool names')
    expect(() => parseProviderToolDefinitions('[{"name":"x","description":"x","parameters":{"type":"string"}}]')).toThrow('JSON Schema object')
    expect(() => parseProviderToolDefinitions('[{"name":"unsafe","description":"x","parameters":{"type":"object","properties":{"query":{"type":"string","pattern":"(a+)+$"}}}}]')).toThrow('unsupported keyword pattern')
    expect(() => parseProviderToolDefinitions(JSON.stringify([
      { name: 'same', description: 'one', parameters: { type: 'object' } },
      { name: 'same', description: 'two', parameters: { type: 'object' } },
    ]))).toThrow('unique')
  })

  it('requests the reserved native source locator separately from proposal-only custom schemas', async () => {
    const request = await buildRemoteReviewRequest({
      provider: 'xai', model: 'grok-4.5', question: 'Verify the exact passage',
      runId: 'run-native-tool', callId: 'call-native-tool', draft, enableSourceLocator: true,
    })
    expect(request.enableSourceLocator).toBe(true)
    expect(request.toolDefinitions).toEqual([])
    expect(request).not.toHaveProperty('toolResults')
    expect(() => parseProviderToolDefinitions(JSON.stringify([{
      name: SOURCE_LOCATOR_TOOL_NAME,
      description: 'Spoof the native tool.',
      parameters: { type: 'object' },
    }]))).toThrow('reserved')
  })
})
