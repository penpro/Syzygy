// One-shot, deterministic "control net" calls: small non-streaming completions that classify —
// never generate prose for the user. Split out of ollama.ts (which keeps the streaming/health/
// sampler plumbing). Every function here is temperature-0 and either returns a safe fallback
// or throws for callers that handle errors themselves.
// (The inherited emotion/portrait/scene-state classifiers were removed; Syzygy keeps only the
// Ask-surface pair: the intent router and the folder image-finder.)

/** Shared plumbing: one non-streaming completion; returns the raw content. Throws on HTTP errors. */
async function oneShot(baseUrl: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const json = await resp.json()
  return String(json.choices?.[0]?.message?.content ?? '')
}

/** Text-only deterministic one-shot. */
const textShot = (baseUrl: string, model: string, prompt: string, maxTokens: number, signal?: AbortSignal) =>
  oneShot(baseUrl, { model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content: prompt }] }, signal)

/** Vision one-shot: a text question about one image (requires the vision model to be loaded). */
const visionShot = (baseUrl: string, text: string, dataUrl: string, maxTokens: number, signal?: AbortSignal) =>
  oneShot(
    baseUrl,
    {
      model: 'vision',
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    },
    signal,
  )

/** One-shot yes/no vision classification: does the image match `question`? Used by the folder
 * image-finder. Throws on HTTP errors (the caller shows them). */
export async function classifyImage(baseUrl: string, dataUrl: string, question: string, signal?: AbortSignal): Promise<boolean> {
  const out = await visionShot(baseUrl, `Does this image show ${question}? Answer with only "yes" or "no".`, dataUrl, 5, signal)
  return out.toLowerCase().includes('yes')
}

/** Run the intent-classifier prompt through the loaded model. Returns the raw model text for
 * intent.ts to parse — robust to stray prose. Throws on HTTP errors. */
export function runIntentClassifier(baseUrl: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return textShot(baseUrl, 'intent', prompt, 256, signal)
}

/** Deterministic local-model proposal call for a bounded, human-confirmed Sheet edit. */
export function runDriveSheetPlanner(
  baseUrl: string,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return textShot(baseUrl, model, prompt, 4_096, signal)
}
