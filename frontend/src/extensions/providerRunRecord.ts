import type { ProviderTransport } from './providerContract'

export const PROVIDER_RUN_RECORD_VERSION = 1 as const

export type ProviderAdapterStatus =
  | 'available'
  | 'contract-only'
  | 'request-control-conformance'
  | 'request-and-stream-control-conformance'
  | 'live-verified'

export interface ProviderRunRecord {
  recordVersion: typeof PROVIDER_RUN_RECORD_VERSION
  runId: string
  callId: string
  executionMode?: 'product' | 'loopback-conformance'
  provider: {
    id: string
    transport: ProviderTransport
    model: string
    adapterStatus: ProviderAdapterStatus
    remote: boolean
  }
  request: {
    taskType: string
    startedAt: string
    completedAt: string
    sourceSnapshotIds: string[]
    inputSha256: string
    maxOutputTokens: number
    timeoutMs: number
    stream: boolean
  }
  disclosure: {
    required: boolean
    approved: boolean
    approvedAt: string | null
    destination: string
    policyUrl: string | null
    policyCheckedAt: string | null
  }
  dataHandling: {
    storageRequest: 'local-only' | 'disabled' | 'provider-controlled'
    zeroRetention: 'not-applicable' | 'requested' | 'attested' | 'not-attested' | 'unknown'
    attestation: {
      kind: 'response-header' | 'provider-contract' | 'local-execution'
      name: string
      value: boolean
    } | null
  }
  result: {
    status: 'completed' | 'failed' | 'cancelled' | 'timeout'
    outputSha256: string | null
    errorCode: string | null
  }
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    costUsd: number | null
  }
}

const unique = (values: string[]) => new Set(values).size === values.length
const validTimestamp = (value: string) => Number.isFinite(Date.parse(value)) && value.endsWith('Z')
const exactLoopback = (hostname: string) => hostname === '127.0.0.1' || hostname === '[::1]'

const containsForbiddenContent = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsForbiddenContent)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(
    ([key, nested]) =>
      /^(?:prompt|input|output|content|text|apiKey|credential|secret|authorization|rawRequest|rawResponse)$/i.test(key) ||
      containsForbiddenContent(nested),
  )
}

/** Semantic checks that JSON Schema cannot express across fields. */
export function validateProviderRunRecord(record: ProviderRunRecord): string[] {
  const errors: string[] = []
  if (record.recordVersion !== PROVIDER_RUN_RECORD_VERSION) errors.push('unsupported recordVersion')
  if (!record.runId.trim() || !record.callId.trim()) errors.push('runId and callId are required')
  if (!unique(record.request.sourceSnapshotIds) || record.request.sourceSnapshotIds.some((id) => !id.trim())) {
    errors.push('sourceSnapshotIds must be unique and non-empty')
  }
  if (
    !validTimestamp(record.request.startedAt) ||
    !validTimestamp(record.request.completedAt) ||
    Date.parse(record.request.completedAt) < Date.parse(record.request.startedAt)
  ) {
    errors.push('request timestamps must be valid UTC values in chronological order')
  }

  let destination: URL | null = null
  try {
    destination = new URL(record.disclosure.destination)
  } catch {
    errors.push('destination must be an absolute URL')
  }
  if (record.provider.remote) {
    if (!record.disclosure.required || !record.disclosure.approved || !record.disclosure.approvedAt) {
      errors.push('remote execution requires recorded human disclosure approval')
    }
    if (!record.disclosure.policyUrl || !record.disclosure.policyCheckedAt) {
      errors.push('remote execution requires a dated provider policy reference')
    }
    if (record.executionMode === 'loopback-conformance') {
      if (!destination || !exactLoopback(destination.hostname) || !['http:', 'https:'].includes(destination.protocol)) {
        errors.push('loopback conformance destination must use literal loopback')
      }
    } else if (destination?.protocol !== 'https:') {
      errors.push('remote product execution destination must use HTTPS')
    }
    if (record.dataHandling.storageRequest === 'local-only') {
      errors.push('remote execution cannot claim local-only storage')
    }
  } else {
    if (record.executionMode === 'loopback-conformance') {
      errors.push('local execution must not use the remote-adapter conformance marker')
    }
    if (record.disclosure.required || record.disclosure.approved || record.disclosure.approvedAt) {
      errors.push('local execution must not fabricate remote disclosure approval')
    }
    if (destination && !exactLoopback(destination.hostname)) errors.push('local execution destination must be literal loopback')
    if (record.dataHandling.storageRequest !== 'local-only') errors.push('local execution must record local-only storage')
    if (record.dataHandling.zeroRetention !== 'not-applicable') {
      errors.push('local execution must mark provider zero retention not applicable')
    }
  }

  const attestation = record.dataHandling.attestation
  if (record.dataHandling.zeroRetention === 'attested' && attestation?.value !== true) {
    errors.push('attested zero retention requires a true typed attestation')
  }
  if (record.dataHandling.zeroRetention === 'not-attested' && attestation?.value !== false) {
    errors.push('not-attested zero retention requires a false typed attestation')
  }
  if (!['attested', 'not-attested'].includes(record.dataHandling.zeroRetention) && attestation !== null) {
    errors.push('retention attestation is only valid for an attested or not-attested result')
  }

  if (record.result.status === 'completed') {
    if (!record.result.outputSha256 || record.result.errorCode !== null) {
      errors.push('completed execution requires an output hash and no error code')
    }
  } else if (record.result.outputSha256 !== null || !record.result.errorCode) {
    errors.push('non-completed execution requires a sanitized error code and no output hash')
  }

  const counts = [record.usage.inputTokens, record.usage.outputTokens, record.usage.totalTokens]
  if (counts.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
    errors.push('usage counts must be null or non-negative safe integers')
  }
  if (counts.every((value): value is number => value !== null) && counts[0] + counts[1] !== counts[2]) {
    errors.push('totalTokens must equal inputTokens plus outputTokens')
  }
  if (record.usage.costUsd !== null && (!Number.isFinite(record.usage.costUsd) || record.usage.costUsd < 0)) {
    errors.push('costUsd must be null or finite and non-negative')
  }
  if (containsForbiddenContent(record)) {
    errors.push('provider run records must not contain prompts, outputs, credentials, or raw payloads')
  }
  return errors
}
