export const MAX_PROVIDER_STREAM_TEXT_CHARS = 8 * 1024 * 1024
export const MAX_PROVIDER_STREAM_WARNINGS = 64
export const MAX_PROVIDER_STREAM_TOOL_CALLS = 32
export const MAX_PROVIDER_STREAM_TOOL_ARGUMENT_CHARS = 256 * 1024
export const MAX_PROVIDER_STREAM_TOOL_ARGUMENT_TOTAL_CHARS = 1024 * 1024

export type ProviderStreamUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type ProviderStreamEvent =
  | { type: 'message-start'; provider: string; responseId: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: string; name: string }
  | { type: 'tool-call-delta'; callId: string; argumentsDelta: string }
  | { type: 'tool-call-complete'; callId: string; name: string; arguments: Record<string, unknown> }
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
  toolCalls: ProviderStreamToolCall[]
}

export type ProviderStreamToolCall = {
  callId: string
  name: string
  argumentsText: string
  arguments: Record<string, unknown> | null
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
    toolCalls: [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new ProviderStreamProtocolError('Tool arguments contain a non-JSON value')
  }
  return encoded
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
    case 'tool-call-start': {
      assertActive(state, 'Tool call start')
      assertBoundedText(event.callId, 'tool call ID', 512)
      assertBoundedText(event.name, 'tool name', 64)
      if (!/^[A-Za-z0-9_-]+$/.test(event.name)) {
        throw new ProviderStreamProtocolError('Invalid tool name')
      }
      if (state.toolCalls.length >= MAX_PROVIDER_STREAM_TOOL_CALLS || state.toolCalls.some(({ callId }) => callId === event.callId)) {
        throw new ProviderStreamProtocolError('Duplicate or excessive tool call')
      }
      return {
        ...state,
        toolCalls: [...state.toolCalls, { callId: event.callId, name: event.name, argumentsText: '', arguments: null }],
      }
    }
    case 'tool-call-delta': {
      assertActive(state, 'Tool call delta')
      if (!event.argumentsDelta || event.argumentsDelta.includes('\0')) {
        throw new ProviderStreamProtocolError('Invalid tool argument delta')
      }
      const index = state.toolCalls.findIndex(({ callId }) => callId === event.callId)
      if (index < 0 || state.toolCalls[index].arguments !== null) {
        throw new ProviderStreamProtocolError('Tool argument delta has no active call')
      }
      const nextText = state.toolCalls[index].argumentsText + event.argumentsDelta
      const total = state.toolCalls.reduce((sum, tool, toolIndex) => sum + (toolIndex === index ? nextText.length : tool.argumentsText.length), 0)
      if (nextText.length > MAX_PROVIDER_STREAM_TOOL_ARGUMENT_CHARS || total > MAX_PROVIDER_STREAM_TOOL_ARGUMENT_TOTAL_CHARS) {
        throw new ProviderStreamProtocolError('Tool arguments exceed the product bound')
      }
      const toolCalls = [...state.toolCalls]
      toolCalls[index] = { ...toolCalls[index], argumentsText: nextText }
      return { ...state, toolCalls }
    }
    case 'tool-call-complete': {
      assertActive(state, 'Tool call complete')
      const index = state.toolCalls.findIndex(({ callId }) => callId === event.callId)
      if (index < 0 || state.toolCalls[index].arguments !== null || state.toolCalls[index].name !== event.name || !isRecord(event.arguments)) {
        throw new ProviderStreamProtocolError('Tool completion does not match an active call')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(state.toolCalls[index].argumentsText)
      } catch {
        throw new ProviderStreamProtocolError('Tool arguments are not complete JSON')
      }
      if (!isRecord(parsed) || canonicalJson(parsed) !== canonicalJson(event.arguments)) {
        throw new ProviderStreamProtocolError('Tool completion arguments do not match streamed arguments')
      }
      const toolCalls = [...state.toolCalls]
      toolCalls[index] = { ...toolCalls[index], arguments: event.arguments }
      return { ...state, toolCalls }
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
      if (state.toolCalls.some(({ arguments: value }) => value === null)) {
        throw new ProviderStreamProtocolError('Provider finished with an incomplete tool call')
      }
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
