import type { ProviderResearchTaskRequest, RemoteProviderId } from '../tauri'

export const REMOTE_REVIEW_PROVIDERS: ReadonlyArray<{
  id: RemoteProviderId
  name: string
  defaultModel: string
}> = [
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.2' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-3.5-flash' },
  { id: 'xai', name: 'xAI', defaultModel: 'grok-4.5' },
]

export interface RemoteReviewDraft {
  projectId: string
  documentId: string
  projectTitle: string
  revision: string
  text: string
}

export async function buildRemoteReviewRequest(input: {
  provider: RemoteProviderId
  model: string
  question: string
  runId: string
  callId: string
  draft: RemoteReviewDraft
}): Promise<ProviderResearchTaskRequest> {
  const model = input.model.trim()
  const question = input.question.trim()
  const draftText = input.draft.text.trim()
  if (!REMOTE_REVIEW_PROVIDERS.some(({ id }) => id === input.provider)) throw new Error('Choose a supported remote provider')
  if (!model || model.length > 200 || [...model].some((character) => character < ' ')) throw new Error('Enter a valid provider model ID')
  if (!question || question.length > 20_000) throw new Error('Enter a review question of at most 20,000 characters')
  if (!draftText) throw new Error('The current draft is empty')
  const fingerprint = await sha256(`${input.draft.documentId}\n${input.draft.revision}\n${draftText}`)
  return {
    runId: input.runId,
    callId: input.callId,
    taskType: 'research.remote-review',
    provider: input.provider,
    timeoutMs: 120_000,
    model,
    developerInstructions: 'Audit the supplied draft against the researcher question. Separate direct observations, uncertainties, and suggested follow-up checks. Do not claim access to sources that were not supplied.',
    question,
    sources: [{
      snapshotId: `document-${input.draft.documentId}-${fingerprint}`,
      label: `Current shared draft: ${input.draft.projectTitle}`,
      excerpt: draftText,
    }],
    maxOutputTokens: 1_200,
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
