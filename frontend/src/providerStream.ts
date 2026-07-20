export const MAX_PROVIDER_STREAM_TEXT_CHARS = 8 * 1024 * 1024
export const MAX_PROVIDER_STREAM_WARNINGS = 64

export type ProviderStreamUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type ProviderStreamEvent =
  | { type: 'message-start'; provider: string; responseId: string }
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: ProviderStreamUsage }
  | { type: 'finish'; status: string }
  | { type: 'provider-warning'; eventType: string }
  | { type: 'provider-error'; code: string }
  | { type: 'stream-end' }

export type ProviderStreamPhase =
  | 'waiting'
  | 'streaming'
  | 'finished'
  | 'failed'
  | 'ended'

export type ProviderStreamState = {
  phase: ProviderStreamPhase
  provider: string | null
  responseId: string | null
  text: string
  usage: ProviderStreamUsage | null
  finishStatus: string | null
  warnings: string[]
  errorCode: string | null
}

export class ProviderStreamProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamProtocolError'
  }
}

export function initialProviderStreamState(): ProviderStreamState {
  return {
    phase: 'waiting',
    provider: null,
    responseId: null,
    text: '',
    usage: null,
    finishStatus: null,
    warnings: [],
    errorCode: null,
  }
}

function assertBoundedText(value: string, label: string, maxChars = 512): void {
  if (!value || value.length > maxChars || Array.from(value).some((char) => char === '\0')) {
    throw new ProviderStreamProtocolError(`Invalid ${label}`)
  }
}

function assertUsage(usage: ProviderStreamUsage): void {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.totalTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProviderStreamProtocolError('Invalid provider usage')
    }
  }
  if (usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new ProviderStreamProtocolError('Inconsistent provider usage')
  }
}

function assertActive(state: ProviderStreamState, eventType: string): void {
  if (state.phase !== 'streaming') {
    throw new ProviderStreamProtocolError(`${eventType} arrived outside an active stream`)
  }
}

export function applyProviderStreamEvent(
  state: ProviderStreamState,
  event: ProviderStreamEvent,
): ProviderStreamState {
  switch (event.type) {
    case 'message-start': {
      if (state.phase !== 'waiting') {
        throw new ProviderStreamProtocolError('Duplicate or out-of-order message start')
      }
      assertBoundedText(event.provider, 'provider', 64)
      assertBoundedText(event.responseId, 'response ID', 512)
      return {
        ...state,
        phase: 'streaming',
        provider: event.provider,
        responseId: event.responseId,
      }
    }
    case 'text-delta': {
      assertActive(state, 'Text delta')
      if (!event.text || event.text.includes('\0')) {
        throw new ProviderStreamProtocolError('Invalid text delta')
      }
      if (state.text.length + event.text.length > MAX_PROVIDER_STREAM_TEXT_CHARS) {
        throw new ProviderStreamProtocolError('Provider stream text exceeds the product bound')
      }
      return { ...state, text: state.text + event.text }
    }
    case 'usage': {
      assertActive(state, 'Usage')
      if (state.usage !== null) {
        throw new ProviderStreamProtocolError('Duplicate provider usage')
      }
      assertUsage(event.usage)
      return { ...state, usage: { ...event.usage } }
    }
    case 'provider-warning': {
      if (state.phase === 'ended') {
        throw new ProviderStreamProtocolError('Provider warning arrived after stream end')
      }
      assertBoundedText(event.eventType, 'provider warning', 256)
      if (state.warnings.length >= MAX_PROVIDER_STREAM_WARNINGS) {
        throw new ProviderStreamProtocolError('Too many provider warnings')
      }
      return { ...state, warnings: [...state.warnings, event.eventType] }
    }
    case 'finish': {
      assertActive(state, 'Finish')
      assertBoundedText(event.status, 'finish status', 64)
      return { ...state, phase: 'finished', finishStatus: event.status }
    }
    case 'provider-error': {
      if (state.phase === 'ended' || state.phase === 'failed') {
        throw new ProviderStreamProtocolError('Duplicate or out-of-order provider error')
      }
      assertBoundedText(event.code, 'provider error code', 128)
      return { ...state, phase: 'failed', errorCode: event.code }
    }
    case 'stream-end': {
      if (state.phase !== 'finished') {
        throw new ProviderStreamProtocolError('Stream ended before a terminal event')
      }
      return { ...state, phase: 'ended' }
    }
  }
}

export function providerStreamIsComplete(state: ProviderStreamState): boolean {
  return state.phase === 'ended' && state.errorCode === null
}
