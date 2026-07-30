import type { RemoteProviderId } from '../tauri'
import {
  validateAdversarialRunnerRequest,
  type AdversarialRunnerRequest,
} from './adversarialRunner'
import { createAdversarialRunPlan } from './adversarialProtocol'

export type NativeAdversarialPhase =
  | 'proposal'
  | 'critique'
  | 'evidence-audit'
  | 'judgment'
  | 'baseline'

export type NativeAdversarialPlannedCall = {
  callId: string
  phase: NativeAdversarialPhase
  provider: RemoteProviderId
  model: string
  upstreamCallIds: string[]
  presentationOrder: string[]
  finalPass: boolean
  timeoutMs: number
  maxOutputTokens: number
}

export type NativeAdversarialRouteBudget = {
  provider: RemoteProviderId
  model: string
  maxCalls: number
}

export type NativeAdversarialAuthorizationScope = {
  runId: string
  question: string
  sources: AdversarialRunnerRequest['sources']
  routes: NativeAdversarialRouteBudget[]
  totalRemoteCalls: number
  calls: NativeAdversarialPlannedCall[]
}

const PROVIDERS = new Set<RemoteProviderId>(['openai', 'anthropic', 'gemini', 'xai'])
const EXECUTION_LIMITS: Record<NativeAdversarialPhase, { timeoutMs: number; maxOutputTokens: number }> = {
  proposal: { timeoutMs: 120_000, maxOutputTokens: 4_096 },
  critique: { timeoutMs: 120_000, maxOutputTokens: 2_048 },
  'evidence-audit': { timeoutMs: 120_000, maxOutputTokens: 4_096 },
  judgment: { timeoutMs: 120_000, maxOutputTokens: 4_096 },
  baseline: { timeoutMs: 120_000, maxOutputTokens: 4_096 },
}

function executionLimits(phase: NativeAdversarialPhase) {
  return { ...EXECUTION_LIMITS[phase] }
}

function remoteProvider(value: string): RemoteProviderId {
  if (!PROVIDERS.has(value as RemoteProviderId)) {
    throw new Error(`unsupported remote provider: ${value}`)
  }
  return value as RemoteProviderId
}

function routeKey(provider: RemoteProviderId, model: string): string {
  return `${provider}\u0000${model}`
}

export function validateNativeAdversarialScope(scope: NativeAdversarialAuthorizationScope): string[] {
  const errors: string[] = []
  const callsById = new Map(scope.calls.map((call) => [call.callId, call]))
  if (callsById.size !== scope.calls.length) errors.push('call IDs must be unique')
  if (scope.totalRemoteCalls !== scope.calls.length) errors.push('totalRemoteCalls must equal the exact call graph size')

  const seen = new Set<string>()
  for (const call of scope.calls) {
    if (!call.callId.startsWith(`${scope.runId}:`)) errors.push(`call ${call.callId} is outside the run namespace`)
    if (!Number.isSafeInteger(call.timeoutMs) || call.timeoutMs < 1_000 || call.timeoutMs > 300_000) {
      errors.push(`call ${call.callId} has an invalid timeout`)
    }
    if (!Number.isSafeInteger(call.maxOutputTokens) || call.maxOutputTokens < 1 || call.maxOutputTokens > 65_536) {
      errors.push(`call ${call.callId} has an invalid output-token budget`)
    }
    if (new Set(call.upstreamCallIds).size !== call.upstreamCallIds.length) {
      errors.push(`call ${call.callId} repeats an upstream dependency`)
    }
    if (call.upstreamCallIds.some((callId) => !seen.has(callId))) {
      errors.push(`call ${call.callId} has an unknown or forward dependency`)
    }
    if (call.phase === 'proposal' || call.phase === 'baseline') {
      if (call.upstreamCallIds.length || call.presentationOrder.length || call.finalPass) {
        errors.push(`call ${call.callId} has forbidden phase metadata`)
      }
    }
    if (call.phase === 'critique' && call.upstreamCallIds.length !== 1) {
      errors.push(`critique ${call.callId} must depend on exactly one proposal`)
    }
    if (call.phase === 'evidence-audit' && call.upstreamCallIds.some((id) => callsById.get(id)?.phase !== 'proposal')) {
      errors.push(`evidence audit ${call.callId} may depend only on proposals`)
    }
    if (call.phase === 'judgment') {
      const proposalDependencies = call.upstreamCallIds.filter((id) => callsById.get(id)?.phase === 'proposal')
      if (
        call.presentationOrder.length !== proposalDependencies.length ||
        new Set(call.presentationOrder).size !== call.presentationOrder.length ||
        call.presentationOrder.some((id) => !proposalDependencies.includes(id))
      ) {
        errors.push(`judgment ${call.callId} presentation order must be an exact proposal permutation`)
      }
    } else if (call.presentationOrder.length || call.finalPass) {
      errors.push(`call ${call.callId} has judgment-only metadata`)
    }
    seen.add(call.callId)
  }

  const actualBudgets = new Map<string, number>()
  for (const call of scope.calls) {
    const key = routeKey(call.provider, call.model)
    actualBudgets.set(key, (actualBudgets.get(key) ?? 0) + 1)
  }
  const declaredKeys = new Set<string>()
  for (const route of scope.routes) {
    const key = routeKey(route.provider, route.model)
    if (declaredKeys.has(key)) errors.push(`route ${key} is duplicated`)
    declaredKeys.add(key)
    if (route.maxCalls !== actualBudgets.get(key)) errors.push(`route ${key} budget does not match the call graph`)
  }
  if (declaredKeys.size !== actualBudgets.size || [...actualBudgets.keys()].some((key) => !declaredKeys.has(key))) {
    errors.push('declared routes must exactly cover the call graph')
  }
  return [...new Set(errors)].sort()
}

export function buildNativeAdversarialScope(
  request: AdversarialRunnerRequest,
): NativeAdversarialAuthorizationScope {
  validateAdversarialRunnerRequest(request)
  const plan = createAdversarialRunPlan(request.input)
  const participantBySlot = new Map(request.input.participants.map((participant) => [participant.slotId, participant]))
  const proposalCallByCandidate = new Map(
    plan.blindedCandidates.map(({ candidateId }) => [candidateId, `${request.runId}:proposal:${candidateId}`]),
  )

  const calls: NativeAdversarialPlannedCall[] = plan.blindedCandidates.map(({ candidateId, slotId }) => {
    const route = participantBySlot.get(slotId)!
    return {
      callId: proposalCallByCandidate.get(candidateId)!,
      phase: 'proposal',
      provider: remoteProvider(route.providerId),
      model: route.modelId,
      upstreamCallIds: [],
      presentationOrder: [],
      finalPass: false,
      ...executionLimits('proposal'),
    }
  })

  const critiqueCallIds: string[] = []
  plan.blindedCandidates.forEach(({ candidateId, slotId }, index) => {
    const target = plan.blindedCandidates[(index + 1) % plan.blindedCandidates.length]
    const route = participantBySlot.get(slotId)!
    const callId = `${request.runId}:critique:${candidateId}`
    critiqueCallIds.push(callId)
    calls.push({
      callId,
      phase: 'critique',
      provider: remoteProvider(route.providerId),
      model: route.modelId,
      upstreamCallIds: [proposalCallByCandidate.get(target.candidateId)!],
      presentationOrder: [],
      finalPass: false,
      ...executionLimits('critique'),
    })
  })

  const proposalCallIds = plan.blindedCandidates.map(({ candidateId }) => proposalCallByCandidate.get(candidateId)!)
  const auditCallId = `${request.runId}:evidence-audit`
  calls.push({
    callId: auditCallId,
    phase: 'evidence-audit',
    provider: remoteProvider(request.input.judge.providerId),
    model: request.input.judge.modelId,
    upstreamCallIds: proposalCallIds,
    presentationOrder: [],
    finalPass: false,
    ...executionLimits('evidence-audit'),
  })

  plan.judgeOrders.forEach((order, index) => {
    const presentationOrder = order.map((candidateId) => proposalCallByCandidate.get(candidateId)!)
    calls.push({
      callId: `${request.runId}:judgment:${index + 1}`,
      phase: 'judgment',
      provider: remoteProvider(request.input.judge.providerId),
      model: request.input.judge.modelId,
      upstreamCallIds: [...proposalCallIds, ...critiqueCallIds, auditCallId],
      presentationOrder,
      finalPass: index === plan.judgeOrders.length - 1,
      ...executionLimits('judgment'),
    })
  })

  for (let index = 0; index < plan.computeMatchedBaselineCallBudget; index += 1) {
    calls.push({
      callId: `${request.runId}:baseline:${index + 1}`,
      phase: 'baseline',
      provider: remoteProvider(request.input.baseline.providerId),
      model: request.input.baseline.modelId,
      upstreamCallIds: [],
      presentationOrder: [],
      finalPass: false,
      ...executionLimits('baseline'),
    })
  }

  const budgets = new Map<string, NativeAdversarialRouteBudget>()
  for (const call of calls) {
    const key = routeKey(call.provider, call.model)
    const current = budgets.get(key)
    if (current) current.maxCalls += 1
    else budgets.set(key, { provider: call.provider, model: call.model, maxCalls: 1 })
  }
  const scope: NativeAdversarialAuthorizationScope = {
    runId: request.runId,
    question: request.input.question,
    sources: request.sources.map((source) => ({ ...source })),
    routes: [...budgets.values()].sort((left, right) =>
      `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`),
    ),
    totalRemoteCalls: calls.length,
    calls,
  }
  const errors = validateNativeAdversarialScope(scope)
  if (errors.length) throw new Error(errors.join('; '))
  return scope
}
