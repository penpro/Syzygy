import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyProviderStreamEvent, initialProviderStreamState } from '../providerStream'
import { RemoteResearchReviewResult } from './RemoteResearchReview'

describe('remote research streaming result', () => {
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
})
