import { describe, expect, it } from 'vitest'
import { buildRemoteReviewRequest, REMOTE_REVIEW_PROVIDERS } from './remoteResearchTask'

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
})
