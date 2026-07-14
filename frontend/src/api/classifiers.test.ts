import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyImage, runIntentClassifier } from './classifiers'

afterEach(() => vi.unstubAllGlobals())

// Stub fetch with a fake completion that echoes `content`.
const stub = (content: string, ok = true) => {
  const f = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) }))
  vi.stubGlobal('fetch', f)
  return f
}

describe('classifyImage', () => {
  it('returns true when the model answers yes', async () => {
    stub('Yes, it does.')
    expect(await classifyImage('http://x/v1', 'data:image/png;base64,AAA', 'a cat')).toBe(true)
  })

  it('returns false when the model answers no', async () => {
    stub('No.')
    expect(await classifyImage('http://x/v1', 'data:image/png;base64,AAA', 'a cat')).toBe(false)
  })

  it('sends the question and image data URL to /chat/completions', async () => {
    const f = stub('yes')
    await classifyImage('http://x/v1', 'data:image/png;base64,ZZZ', 'a red car')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://x/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    const parts = body.messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts.find((p) => p.type === 'text')?.text).toContain('a red car')
    expect(parts.find((p) => p.type === 'image_url')?.image_url?.url).toBe('data:image/png;base64,ZZZ')
  })

  it('throws on a non-ok response', async () => {
    stub('', false)
    await expect(classifyImage('http://x/v1', 'data:image/png;base64,AAA', 'x')).rejects.toThrow(/HTTP 500/)
  })
})

describe('runIntentClassifier', () => {
  it('returns the raw model text for intent.ts to parse', async () => {
    stub('{"intent":"make_document"}')
    expect(await runIntentClassifier('http://x/v1', 'classify this')).toBe('{"intent":"make_document"}')
  })

  it('sends a temperature-0 single-message prompt', async () => {
    const f = stub('ok')
    await runIntentClassifier('http://x/v1', 'classify this')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://x/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.temperature).toBe(0)
    expect(body.messages).toEqual([{ role: 'user', content: 'classify this' }])
  })

  it('throws on a non-ok response', async () => {
    stub('', false)
    await expect(runIntentClassifier('http://x/v1', 'x')).rejects.toThrow(/HTTP 500/)
  })
})
