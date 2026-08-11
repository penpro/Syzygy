import type { ProviderResearchTaskRequest, ProviderToolDefinition, RemoteProviderId } from '../tauri'

const MAX_TOOL_DEFINITIONS = 32
const MAX_TOOL_DEFINITION_JSON_CHARS = 256 * 1024

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseProviderToolDefinitions(value: string): ProviderToolDefinition[] {
  if (!value.trim()) return []
  if (value.length > MAX_TOOL_DEFINITION_JSON_CHARS) throw new Error('Tool definitions exceed 256 KiB')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Tool definitions must be a JSON array')
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_TOOL_DEFINITIONS) {
    throw new Error('Tool definitions must be an array of at most 32 functions')
  }
  const names = new Set<string>()
  return parsed.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Each tool definition must be an object')
    const name = candidate.name
    const description = candidate.description
    const parameters = candidate.parameters
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || names.has(name)) {
      throw new Error('Tool names must be unique and use 1–64 letters, numbers, underscores, or hyphens')
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 4_096 || [...description].some((character) => character < ' ')) {
      throw new Error(`Tool ${name} needs a printable description of at most 4,096 characters`)
    }
    if (!isRecord(parameters) || parameters.type !== 'object') {
      throw new Error(`Tool ${name} parameters must be a JSON Schema object with type "object"`)
    }
    if (JSON.stringify(parameters).length > 64 * 1024) throw new Error(`Tool ${name} schema exceeds 64 KiB`)
    names.add(name)
    return { name, description, parameters }
  })
}

export async function buildRemoteReviewRequest(input: {
  provider: RemoteProviderId
  model: string
  question: string
  runId: string
  callId: string
  draft: RemoteReviewDraft
  toolDefinitions?: ProviderToolDefinition[]
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
    toolDefinitions: input.toolDefinitions ?? [],
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
