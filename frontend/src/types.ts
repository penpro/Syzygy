export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  reasoning?: string
  error?: boolean
  createdAt: number
}

export interface Settings {
  baseUrl: string
  model: string
  temperature: number
  topP: number
  maxTokens: number // 0 = unlimited (recommended for this reasoning model)
  contextLength: number
  autoExpandReasoning: boolean
  keepLoaded: boolean // pin the model in VRAM (keep_alive -1) instead of idle-unloading
  localAiEnabled: boolean // load the bundled local model at startup; false leaves projects + remote APIs available
  researcherId: string // stable per-install attribution identity for collaborative research events
  researcherName: string // editable display name captured into immutable history at write time
  proofread: boolean // re-run each reply through the model to fix spelling/grammar
  seenTutorial: boolean // the "how it works" architecture modal has been shown
  seenWelcome: boolean // the first-run welcome tour was dismissed with "don't show again"
  theme: string // accent/void preset: penumbra | synthwave | cyber | ember | bloodmoon
  visionModel: string // '' = off, else a VISION_MODELS id — a vision-capable model for image tasks
  intentRouter: 'off' | 'quick' | 'full' // control-net: off | classify only action-like prompts | classify every prompt
  reduceMotion: boolean // accessibility: force-disable animations/transitions (also auto-on via OS prefers-reduced-motion)
  highContrast: boolean // accessibility: full-strength secondary text + stronger borders
  sidebarCollapsed?: boolean // dock the left navigator away for an immersive work area
  crashReports?: boolean // opt-in anonymous crash reports (Sentry, errors only) — default OFF, disclosed in Settings
  googleClientId: string // OAuth Client ID (Desktop app) for Google Drive linking; '' = not configured
  googleClientSecret: string // Google requires this at the token endpoint for Desktop clients (not confidential for installed apps)
  // advanced sampling — defaults match llama.cpp, so behavior is unchanged until tuned
  topK: number
  minP: number
  typicalP: number
  repeatPenalty: number
  repeatLastN: number
  presencePenalty: number
  frequencyPenalty: number
  mirostat: number
  mirostatTau: number
  mirostatEta: number
  dryMultiplier: number
  dryBase: number
  dryAllowedLength: number
  seed: number
}

export type AppView = 'ask' | 'workspace'

/** A reference document that sits in context (style/lore/facts) — like a text LoRA. */
export interface Source {
  id: string
  name: string
  text: string
}

/** A selectable "expert" — a named system-prompt rule set used by the Ask view. */
export interface Expert {
  id: string
  name: string
  emoji: string
  systemPrompt: string
  builtin?: boolean
  createdAt: number
}

/** A multi-turn expert Q&A conversation, steered by a selected Expert. */
export interface Ask {
  id: string
  title: string
  expertId: string | null
  messages: ChatMessage[]
  think: boolean
  knowledgeFolder?: string // read/write folder: reference docs in, generated documents out
  syncToDrive?: boolean // mirror each sent prompt to the shared Drive folder (collab test)
  createdAt: number
  updatedAt: number
}
