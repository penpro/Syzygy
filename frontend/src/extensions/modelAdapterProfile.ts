export const MODEL_ADAPTER_PROFILE_VERSION = 1 as const

export interface ModelAdapterProfile {
  schemaVersion: typeof MODEL_ADAPTER_PROFILE_VERSION
  id: string
  name: string
  version: string
  description: string
  protocol: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'
  endpoint: {
    baseUrl: string
    path: '/v1/responses' | '/v1/chat/completions' | '/v1/messages'
    locality: 'literal-loopback' | 'remote'
    authentication: 'none' | 'bearer-api-key' | 'x-api-key'
  }
  capabilities: {
    streaming: boolean
    toolCalls: boolean
    structuredOutputs: boolean
    imageInput: boolean
    usage: boolean
  }
  dataPolicy: {
    storageControl: 'local-only' | 'request-disabled' | 'provider-controlled' | 'unknown'
    trainingUse: 'never' | 'account-dependent' | 'provider-defined' | 'unknown'
    zeroRetention: 'not-applicable' | 'optional' | 'required' | 'unknown'
    policyUrl: string | null
    policyCheckedAt: string | null
  }
  limitations: string[]
}

const expectedPaths: Record<ModelAdapterProfile['protocol'], ModelAdapterProfile['endpoint']['path']> = {
  'openai-responses': '/v1/responses',
  'openai-chat-completions': '/v1/chat/completions',
  'anthropic-messages': '/v1/messages',
}

const literalLoopback = (hostname: string) => hostname === '127.0.0.1' || hostname === '[::1]'

export function validateModelAdapterProfile(profile: ModelAdapterProfile): string[] {
  const errors: string[] = []
  if (profile.schemaVersion !== MODEL_ADAPTER_PROFILE_VERSION) errors.push('unsupported schemaVersion')
  if (['local', 'openai', 'anthropic', 'gemini', 'xai'].includes(profile.id)) {
    errors.push('custom adapter ID must not shadow a built-in provider')
  }
  if (profile.endpoint.path !== expectedPaths[profile.protocol]) {
    errors.push('endpoint path must match the declared compatibility protocol')
  }
  let endpoint: URL | null = null
  try {
    endpoint = new URL(profile.endpoint.baseUrl)
  } catch {
    errors.push('baseUrl must be an absolute URL')
  }
  if (endpoint && (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)) {
    errors.push('baseUrl must not contain credentials, query parameters, or fragments')
  }
  if (endpoint && endpoint.pathname !== '/' && endpoint.pathname !== '') {
    errors.push('baseUrl must contain only the origin; endpoint path is declared separately')
  }
  if (profile.endpoint.locality === 'literal-loopback') {
    if (endpoint && !literalLoopback(endpoint.hostname)) errors.push('local adapter must use literal loopback')
    if (profile.dataPolicy.storageControl !== 'local-only') errors.push('local adapter must declare local-only storage')
    if (profile.dataPolicy.zeroRetention !== 'not-applicable') {
      errors.push('local adapter must mark provider zero retention not applicable')
    }
    if (profile.dataPolicy.policyUrl || profile.dataPolicy.policyCheckedAt) {
      errors.push('local adapter must not fabricate a remote provider policy review')
    }
  } else {
    if (endpoint?.protocol !== 'https:') errors.push('remote adapter must use HTTPS')
    if (profile.endpoint.authentication === 'none') errors.push('remote adapter must declare credential authentication')
    if (!profile.dataPolicy.policyUrl || !profile.dataPolicy.policyCheckedAt) {
      errors.push('remote adapter requires a dated provider policy reference')
    }
    if (profile.dataPolicy.storageControl === 'local-only') {
      errors.push('remote adapter cannot claim local-only storage')
    }
  }
  if (profile.endpoint.authentication === 'x-api-key' && profile.protocol !== 'anthropic-messages') {
    errors.push('x-api-key authentication is limited to the Anthropic-compatible protocol')
  }
  if (new Set(profile.limitations).size !== profile.limitations.length || profile.limitations.some((value) => !value.trim())) {
    errors.push('limitations must be unique and non-empty')
  }
  return errors
}

export function evaluateModelAdapterEndpoint(profile: ModelAdapterProfile, candidate: string): 'allow' | 'deny' {
  try {
    const base = new URL(profile.endpoint.baseUrl)
    const target = new URL(candidate)
    const expected = new URL(profile.endpoint.path, base)
    if (target.username || target.password || target.search || target.hash) return 'deny'
    return target.origin === expected.origin && target.pathname === expected.pathname ? 'allow' : 'deny'
  } catch {
    return 'deny'
  }
}
