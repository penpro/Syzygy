import {
  providerAdversarialAuthorize,
  providerAdversarialExecute,
  providerAdversarialRevoke,
  providerCancel,
  type ProviderAdversarialCallRequest,
  type ProviderTaskOutcome,
} from '../tauri'
import type { ProviderRunRecord } from './providerRunRecord'
import {
  runAdversarialPanel,
  type AdversarialExecutor,
  type AdversarialExecutorCall,
  type AdversarialExecutorResult,
  type AdversarialRunnerOutcome,
  type AdversarialRunnerRequest,
} from './adversarialRunner'
import {
  buildNativeAdversarialScope,
  type NativeAdversarialAuthorizationScope,
} from './adversarialNativePlan'

type ExecuteNativeCall = (request: ProviderAdversarialCallRequest) => Promise<ProviderTaskOutcome>
type CancelNativeCall = (callId: string) => Promise<boolean>

const ALLOWED_RESULT_KEYS: Record<AdversarialExecutorCall['phase'], ReadonlySet<string>> = {
  proposal: new Set(['kind', 'proposal', 'claims']),
  critique: new Set(['kind', 'summary']),
  'evidence-audit': new Set(['kind', 'entries']),
  judgment: new Set(['kind', 'ranking', 'minorityFindings', 'synthesis']),
  baseline: new Set(['kind', 'text']),
}

function hasPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateReasoning)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(
    ([key, nested]) => /^(?:chainOfThought|hiddenReasoning|reasoningTrace)$/i.test(key) || hasPrivateReasoning(nested),
  )
}

export class NativeAdversarialExecutorError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Native adversarial executor failed')
    this.name = 'NativeAdversarialExecutorError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new NativeAdversarialExecutorError(code)
}

export function parseNativeAdversarialResult(
  call: AdversarialExecutorCall,
  outcome: ProviderTaskOutcome,
): AdversarialExecutorResult {
  if (outcome.errorCode) fail(outcome.errorCode)
  if (!outcome.response) fail('missing-provider-response')
  if (!outcome.response.usage) fail('missing-provider-usage')
  let parsed: unknown
  try {
    parsed = JSON.parse(outcome.response.text)
  } catch {
    fail('invalid-provider-json')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || hasPrivateReasoning(parsed)) {
    fail('invalid-provider-result')
  }
  const record = parsed as Record<string, unknown>
  if (record.kind !== call.phase || Object.keys(record).some((key) => !ALLOWED_RESULT_KEYS[call.phase].has(key))) {
    fail('invalid-provider-result')
  }
  const usage = {
    inputTokens: outcome.response.usage.inputTokens,
    outputTokens: outcome.response.usage.outputTokens,
    costUsd: null,
  }
  return { ...record, usage } as AdversarialExecutorResult
}

export interface NativeAdversarialExecutorOptions {
  authorizationId: string
  request: AdversarialRunnerRequest
  scope?: NativeAdversarialAuthorizationScope
  execute?: ExecuteNativeCall
  cancel?: CancelNativeCall
  onRunRecord?: (record: ProviderRunRecord) => void
}

export function createNativeAdversarialExecutor(options: NativeAdversarialExecutorOptions): AdversarialExecutor {
  const scope = options.scope ?? buildNativeAdversarialScope(options.request)
  const plannedById = new Map(scope.calls.map((call) => [call.callId, call]))
  const rawOutputs = new Map<string, string>()
  const execute = options.execute ?? providerAdversarialExecute
  const cancel = options.cancel ?? providerCancel

  return async (call, signal) => {
    const planned = plannedById.get(call.callId)
    if (
      !planned ||
      planned.phase !== call.phase ||
      planned.provider !== call.route.providerId ||
      planned.model !== call.route.modelId
    ) {
      fail('unauthorized-call-graph')
    }
    if (signal?.aborted) fail('cancelled')
    const upstreamOutputs = planned.upstreamCallIds.map((callId) => {
      const output = rawOutputs.get(callId)
      if (!output) fail('missing-upstream-output')
      return { callId, output }
    })
    const onAbort = () => {
      void cancel(call.callId).catch(() => undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const outcome = await execute({
        authorizationId: options.authorizationId,
        runId: options.request.runId,
        callId: call.callId,
        question: options.request.input.question,
        sources: options.request.sources.map((source) => ({ ...source })),
        upstreamOutputs,
      })
      const result = parseNativeAdversarialResult(call, outcome)
      rawOutputs.set(call.callId, outcome.response!.text)
      options.onRunRecord?.(structuredClone(outcome.runRecord))
      return result
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export interface NativeAdversarialPanelOutcome extends AdversarialRunnerOutcome {
  authorization: {
    scopeSha256: string
    totalRemoteCalls: number
  }
  providerRunRecords: ProviderRunRecord[]
}

export async function runNativeAdversarialPanel(
  request: AdversarialRunnerRequest,
  signal?: AbortSignal,
): Promise<NativeAdversarialPanelOutcome> {
  const scope = buildNativeAdversarialScope(request)
  const authorization = await providerAdversarialAuthorize(scope)
  if (!authorization.approved || !authorization.authorizationId) fail('batch-authorization-denied')
  const providerRunRecords: ProviderRunRecord[] = []
  try {
    const outcome = await runAdversarialPanel(
      request,
      createNativeAdversarialExecutor({
        authorizationId: authorization.authorizationId,
        request,
        scope,
        onRunRecord: (record) => providerRunRecords.push(record),
      }),
      signal,
    )
    return {
      ...outcome,
      authorization: {
        scopeSha256: authorization.scopeSha256,
        totalRemoteCalls: authorization.totalRemoteCalls,
      },
      providerRunRecords,
    }
  } finally {
    await providerAdversarialRevoke(authorization.authorizationId).catch(() => false)
  }
}
