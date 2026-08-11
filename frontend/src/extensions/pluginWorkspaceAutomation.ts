import type * as Y from 'yjs'
import { now, uid } from '../util'
import {
  getAutomationEditorController,
  type AutomationEditorController,
} from '../workspace/editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from '../workspace/projectModel'
import {
  attestPluginReviewEvent,
  type ResearchEventAttributionResult,
} from '../workspace/researchEventAttribution'
import {
  pluginPackageRegistry,
  type LoadedPluginPackageSummary,
  type PluginPackageRegistry,
} from './pluginPackageRegistry'
import { pluginInstallationCatalog } from './pluginInstallationStore'
import { applyAcceptedPluginReview } from './pluginReviewApplication'
import {
  zeroAuthorityPluginExecutor,
  type PluginExecutionOutcome,
  type ZeroAuthorityPluginExecutor,
} from './pluginExecution'
import {
  createPluginReviews,
  decidePluginReview,
  inspectPluginReviews,
  listPluginReviews,
  readPluginReview,
  type CollaborativePluginReview,
  type PluginReviewDecision,
} from './pluginReviewModel'

export interface PluginRunnerIdentity {
  participantId: string
  displayName: string
}

export interface RunLoadedPluginInput extends PluginRunnerIdentity {
  packageId: string
  contributionId: string
  expectedDocumentRevision: string
  expectedResearchRevision?: string
}

export interface DecidePluginReviewAutomationInput extends PluginRunnerIdentity {
  reviewId: string
  expectedProposalEventId: string
  expectedResearchRevision: string
  decision: PluginReviewDecision
}

export interface ApplyPluginReviewAutomationInput {
  reviewId: string
  expectedProposalEventId: string
  expectedDecisionEventId: string
  expectedDocumentRevision: string
  expectedResearchRevision: string
  confirmFullReplacement: boolean
}

export interface PluginRunPublication {
  outcome: PluginExecutionOutcome
  reviews: CollaborativePluginReview[]
  attributions: ResearchEventAttributionResult[]
  researchRevision: string
}

const identity = (value: PluginRunnerIdentity) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value.participantId) ||
    !value.displayName.trim() || value.displayName.length > 200 || value.displayName.includes('\u0000')) {
    throw new Error('Set a valid researcher identity before running or reviewing a plugin')
  }
  return { participantId: value.participantId, displayName: value.displayName.trim() }
}

export async function runLoadedPluginForProject(
  doc: Y.Doc,
  projectId: string,
  input: RunLoadedPluginInput,
  dependencies: {
    packages?: PluginPackageRegistry
    executor?: ZeroAuthorityPluginExecutor
    attest?: typeof attestPluginReviewEvent
    clock?: () => number
    id?: () => string
  } = {},
): Promise<PluginRunPublication> {
  const runner = identity(input)
  const packages = dependencies.packages ?? pluginPackageRegistry
  const executor = dependencies.executor ?? zeroAuthorityPluginExecutor
  const clock = dependencies.clock ?? now
  const id = dependencies.id ?? uid
  const controller = getAutomationEditorController(projectId)
  const before = controller.read()
  if (before.projectId !== projectId || before.revision !== input.expectedDocumentRevision) {
    throw new Error('Document revision conflict; read the active project again before running the plugin')
  }
  if (input.expectedResearchRevision !== undefined && projectStateFingerprint(doc) !== input.expectedResearchRevision) {
    throw new Error('Research revision conflict; inspect plugin reviews again before running the plugin')
  }
  const plugin = packages.get(input.packageId)
  const outcome = await executor.execute({
    plugin,
    contributionId: input.contributionId,
    project: {
      projectId,
      revision: before.revision,
      documentText: before.text,
      sources: [],
    },
  })
  if (outcome.status === 'no-change') {
    return { outcome, reviews: [], attributions: [], researchRevision: projectStateFingerprint(doc) }
  }
  const shared = getProjectSharedTypes(doc)
  const reviews = createPluginReviews(shared.discussions, outcome.receipts.map(({ proposal }) => ({
    reviewId: id(),
    eventId: id(),
    pluginVersion: outcome.pluginVersion,
    componentSha256: outcome.componentSha256,
    contributionId: outcome.contributionId,
    proposal,
    runnerId: runner.participantId,
    runnerDisplayName: runner.displayName,
    timestamp: clock(),
  })))
  const attest = dependencies.attest ?? attestPluginReviewEvent
  const attributions: ResearchEventAttributionResult[] = []
  for (const review of reviews) {
    attributions.push(await attest(doc, projectId, review.proposal))
  }
  return { outcome, reviews, attributions, researchRevision: projectStateFingerprint(doc) }
}

export function inspectPluginWorkspace(
  doc: Y.Doc,
  packages: PluginPackageRegistry = pluginPackageRegistry,
) {
  const shared = getProjectSharedTypes(doc)
  const inspection = inspectPluginReviews(shared.discussions)
  return {
    loadedPackages: packages.list(),
    installedPackages: pluginInstallationCatalog.list(),
    reviews: listPluginReviews(shared.discussions).slice(-200).map((review) => ({
      reviewId: review.id,
      proposalEventId: review.proposal.eventId,
      pluginProposalId: review.proposal.pluginProposalId,
      pluginId: review.proposal.pluginId,
      pluginVersion: review.proposal.pluginVersion,
      componentSha256: review.proposal.componentSha256,
      contributionId: review.proposal.contributionId,
      projectId: review.proposal.projectId,
      expectedRevision: review.proposal.expectedRevision,
      operation: review.proposal.operation,
      summary: review.proposal.summary,
      runnerId: review.proposal.runnerId,
      runnerDisplayName: review.proposal.runnerDisplayName,
      timestamp: review.proposal.timestamp,
      status: review.status,
      decisionCount: review.decisions.length,
      acceptedDecisionEventId: review.status === 'accepted'
        ? review.decisions.find((decision) => decision.decision === 'accepted')?.eventId ?? null
        : null,
    })),
    inspection,
    researchRevision: projectStateFingerprint(doc),
    contentOmitted: true,
    automaticDraftMutation: false,
  }
}

export async function decidePluginReviewForProject(
  doc: Y.Doc,
  projectId: string,
  input: DecidePluginReviewAutomationInput,
  dependencies: {
    clock?: () => number
    id?: () => string
    attest?: typeof attestPluginReviewEvent
  } = {},
) {
  const reviewer = identity(input)
  if (projectStateFingerprint(doc) !== input.expectedResearchRevision) {
    throw new Error('Research revision conflict; inspect plugin reviews again before deciding')
  }
  const shared = getProjectSharedTypes(doc)
  const pendingReview = readPluginReview(shared.discussions, input.reviewId)
  if (!pendingReview || pendingReview.proposal.projectId !== projectId) {
    throw new Error('Plugin review project identity mismatch')
  }
  const decisionEventId = (dependencies.id ?? uid)()
  const decisionTimestamp = (dependencies.clock ?? now)()
  const review = decidePluginReview(shared.discussions, {
    reviewId: input.reviewId,
    eventId: decisionEventId,
    expectedProposalEventId: input.expectedProposalEventId,
    decision: input.decision,
    reviewerId: reviewer.participantId,
    reviewerDisplayName: reviewer.displayName,
    timestamp: decisionTimestamp,
  })
  const decisionEvent = review.decisions.find((candidate) => candidate.eventId === decisionEventId)
  if (!decisionEvent) throw new Error('Plugin review decision was not retained')
  const attribution = await (dependencies.attest ?? attestPluginReviewEvent)(doc, projectId, decisionEvent)
  return {
    review,
    attribution,
    researchRevision: projectStateFingerprint(doc),
    automaticDraftMutation: false,
  }
}

export function applyPluginReviewForProject(
  doc: Y.Doc,
  projectId: string,
  input: ApplyPluginReviewAutomationInput,
  dependencies: { controller?: AutomationEditorController } = {},
) {
  if (projectStateFingerprint(doc) !== input.expectedResearchRevision) {
    throw new Error('Research revision conflict; inspect plugin reviews again before applying')
  }
  const controller = dependencies.controller ?? getAutomationEditorController(projectId)
  const shared = getProjectSharedTypes(doc)
  const review = readPluginReview(shared.discussions, input.reviewId)
  if (!review) throw new Error('Plugin review is missing or invalid')
  if (input.confirmFullReplacement !== (review.proposal.operation === 'replace')) {
    throw new Error('Full-draft replacement confirmation does not match the retained proposal operation')
  }
  const document = applyAcceptedPluginReview(shared.discussions, controller, projectId, input)
  return {
    reviewId: review.id,
    proposalEventId: review.proposal.eventId,
    decisionEventId: input.expectedDecisionEventId,
    operation: review.proposal.operation,
    pluginId: review.proposal.pluginId,
    pluginVersion: review.proposal.pluginVersion,
    componentSha256: review.proposal.componentSha256,
    linkedPolicyId: review.id,
    documentRevision: document.revision,
    documentBlockCount: document.blocks.length,
    researchRevision: projectStateFingerprint(doc),
    contentOmitted: true,
    explicitDraftMutation: true,
    automaticDraftMutation: false,
  }
}

export type { LoadedPluginPackageSummary }
