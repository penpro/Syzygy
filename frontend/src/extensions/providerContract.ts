export const MODEL_PROVIDER_CONTRACT_VERSION = 1 as const

export type ProviderTransport =
  | 'local-openai-compatible'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-interactions'
  | 'xai-responses'
  | 'custom'

export type ProviderStorageMode = 'local-only' | 'never' | 'optional' | 'default-on' | 'provider-defined'
export type ProviderTrainingMode = 'never' | 'paid-tier-no' | 'account-dependent' | 'provider-defined'

export interface ModelProviderCapabilities {
  streaming: boolean
  toolCalls: boolean
  parallelToolCalls: boolean
  structuredOutputs: boolean
  remoteMcp: boolean
  imageInput: boolean
  statefulResponses: boolean
}

export interface ProviderDataPolicy {
  remote: boolean
  applicationState: ProviderStorageMode
  trainingUse: ProviderTrainingMode
  zeroRetentionOption: boolean
  disclosureRequired: boolean
  policyUrl?: string
}

export interface ModelProviderDescriptor {
  contractVersion: typeof MODEL_PROVIDER_CONTRACT_VERSION
  id: string
  displayName: string
  transport: ProviderTransport
  credential: 'none' | 'api-key' | 'oauth'
  implementation: 'available' | 'planned' | 'plugin'
  defaultBaseUrl?: string
  capabilities: ModelProviderCapabilities
  dataPolicy: ProviderDataPolicy
}

const localCapabilities: ModelProviderCapabilities = {
  streaming: true,
  toolCalls: false,
  parallelToolCalls: false,
  structuredOutputs: false,
  remoteMcp: false,
  imageInput: false,
  statefulResponses: false,
}

const remoteCapabilities: ModelProviderCapabilities = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: true,
  structuredOutputs: true,
  remoteMcp: false,
  imageInput: true,
  statefulResponses: true,
}

/**
 * Product-visible provider capabilities. Remote entries are contracts, not claims that their
 * adapters or credential storage have shipped. Local inference remains the only available tier.
 */
export const BUILTIN_PROVIDER_DESCRIPTORS: readonly ModelProviderDescriptor[] = [
  {
    contractVersion: MODEL_PROVIDER_CONTRACT_VERSION,
    id: 'local',
    displayName: 'Syzygy local model',
    transport: 'local-openai-compatible',
    credential: 'none',
    implementation: 'available',
    defaultBaseUrl: 'http://127.0.0.1:11435/v1',
    capabilities: localCapabilities,
    dataPolicy: {
      remote: false,
      applicationState: 'local-only',
      trainingUse: 'never',
      zeroRetentionOption: true,
      disclosureRequired: false,
    },
  },
  {
    contractVersion: MODEL_PROVIDER_CONTRACT_VERSION,
    id: 'openai',
    displayName: 'OpenAI',
    transport: 'openai-responses',
    credential: 'api-key',
    implementation: 'planned',
    defaultBaseUrl: 'https://api.openai.com/v1',
    capabilities: { ...remoteCapabilities, remoteMcp: true },
    dataPolicy: {
      remote: true,
      applicationState: 'default-on',
      trainingUse: 'never',
      zeroRetentionOption: true,
      disclosureRequired: true,
      policyUrl: 'https://platform.openai.com/docs/models/default-usage-policies-by-endpoint',
    },
  },
  {
    contractVersion: MODEL_PROVIDER_CONTRACT_VERSION,
    id: 'anthropic',
    displayName: 'Anthropic',
    transport: 'anthropic-messages',
    credential: 'api-key',
    implementation: 'planned',
    defaultBaseUrl: 'https://api.anthropic.com',
    capabilities: { ...remoteCapabilities, statefulResponses: false },
    dataPolicy: {
      remote: true,
      applicationState: 'provider-defined',
      trainingUse: 'provider-defined',
      zeroRetentionOption: true,
      disclosureRequired: true,
      policyUrl: 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention',
    },
  },
  {
    contractVersion: MODEL_PROVIDER_CONTRACT_VERSION,
    id: 'gemini',
    displayName: 'Google Gemini',
    transport: 'gemini-interactions',
    credential: 'api-key',
    implementation: 'planned',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    capabilities: remoteCapabilities,
    dataPolicy: {
      remote: true,
      applicationState: 'default-on',
      trainingUse: 'account-dependent',
      zeroRetentionOption: false,
      disclosureRequired: true,
      policyUrl: 'https://ai.google.dev/gemini-api/terms',
    },
  },
  {
    contractVersion: MODEL_PROVIDER_CONTRACT_VERSION,
    id: 'xai',
    displayName: 'xAI',
    transport: 'xai-responses',
    credential: 'api-key',
    implementation: 'planned',
    defaultBaseUrl: 'https://api.x.ai/v1',
    capabilities: { ...remoteCapabilities, remoteMcp: true },
    dataPolicy: {
      remote: true,
      applicationState: 'optional',
      trainingUse: 'never',
      zeroRetentionOption: true,
      disclosureRequired: true,
      policyUrl: 'https://docs.x.ai/developers/faq/security',
    },
  },
]

export function validateProviderDescriptor(value: ModelProviderDescriptor): string[] {
  const errors: string[] = []
  if (value.contractVersion !== MODEL_PROVIDER_CONTRACT_VERSION) errors.push('unsupported contractVersion')
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(value.id)) errors.push('id must be a lowercase stable identifier')
  if (!value.displayName.trim()) errors.push('displayName is required')
  if (value.dataPolicy.remote !== value.dataPolicy.disclosureRequired) {
    errors.push('remote providers must require disclosure and local providers must not')
  }
  if (value.dataPolicy.remote && !value.dataPolicy.policyUrl) errors.push('remote providers require a policyUrl')
  if (value.defaultBaseUrl) {
    try {
      const url = new URL(value.defaultBaseUrl)
      if (value.dataPolicy.remote && url.protocol !== 'https:') errors.push('remote defaultBaseUrl must use HTTPS')
      if (!value.dataPolicy.remote && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
        errors.push('local defaultBaseUrl must be loopback')
      }
    } catch {
      errors.push('defaultBaseUrl must be an absolute URL')
    }
  }
  return errors
}
