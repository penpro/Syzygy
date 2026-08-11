import type * as Y from 'yjs'
import { inspectAdversarialReviewHistory } from '../extensions/adversarialHistory'
import { listHeuristics } from './heuristicsModel'
import { inspectHeuristicExamples } from './heuristicExampleModel'
import { inspectHeuristicCheckResults } from './heuristicCheckResultModel'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { listPolicyVersions, readPolicyVersionHead, readPolicyVersionLineage } from './policyVersionModel'
import type { PolicyVersion } from './policyVersionModel'
import { inspectScenarioGraph, listScenarios } from './scenarioModel'
import { inspectScenarioRerunQueues, listScenarioRerunJobs } from './scenarioRerunQueue'
import { countComparableScenarioRerunPairs } from './scenarioComparison'
import { inspectScenarioAnnotations, listScenarioAnnotationSummaries } from './scenarioAnnotationModel'
import { inspectScenarioVotes, listScenarioVoteSummaries } from './scenarioVoteModel'
import { inspectScenarioLabels, listScenarioIdsForLabel, listScenarioLabels } from './scenarioLabelModel'
import { inspectSuggestions, listSuggestions } from './suggestionModel'
import { inspectRegisteredProjectPresence } from './presenceRegistry'
import { inspectProjectDeviceDirectory } from './projectDeviceDirectory'
import { inspectProjectRelayAdminApprovals } from './projectRelayAdminApproval'
import { inspectProjectResearchEventAttestations } from './projectResearchEventAttestation'
import { researchEventAttestationResolver } from './researchEventAttribution'

const MAX_RETURNED_ITEMS = 200

function countInvalidLineages(versions: PolicyVersion[]): number {
  const byId = new Map(versions.map((version) => [version.versionId, version]))
  const valid = new Set<string>()
  const invalid = new Set<string>()
  for (const start of versions) {
    const path: string[] = []
    const visiting = new Set<string>()
    let cursor: PolicyVersion | undefined = start
    let pathValid = true
    while (cursor) {
      if (valid.has(cursor.versionId)) break
      if (invalid.has(cursor.versionId) || visiting.has(cursor.versionId)) { pathValid = false; break }
      visiting.add(cursor.versionId)
      path.push(cursor.versionId)
      if (cursor.parentVersionId === null) break
      const parent = byId.get(cursor.parentVersionId)
      if (!parent || parent.projectId !== start.projectId) { pathValid = false; break }
      cursor = parent
    }
    path.forEach((id) => (pathValid ? valid : invalid).add(id))
  }
  return invalid.size
}

export async function inspectResearchState(doc: Y.Doc, expectedProjectId: string) {
  const startingRevision = projectStateFingerprint(doc)
  const { metadata, discussions, heuristics: heuristicMap, scenarios: scenarioMap, settings, versions: versionMap } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== expectedProjectId) throw new Error('Live collaboration document project identity does not match')

  const validHeuristics = listHeuristics(heuristicMap)
  const heuristicExampleInspection = inspectHeuristicExamples(discussions, heuristicMap)
  const heuristicCheckInspection = inspectHeuristicCheckResults(discussions, heuristicMap)
  const validScenarios = listScenarios(scenarioMap)
  const scenarioGraph = inspectScenarioGraph(scenarioMap)
  const scenarioRerunInspection = inspectScenarioRerunQueues(settings, discussions, scenarioMap)
  const scenarioRerunJobs = listScenarioRerunJobs(settings, discussions)
  const annotationSummaries = listScenarioAnnotationSummaries(discussions)
  const annotationInspection = inspectScenarioAnnotations(discussions, scenarioMap)
  const voteSummaries = listScenarioVoteSummaries(discussions)
  const voteInspection = inspectScenarioVotes(discussions, scenarioMap)
  const scenarioLabels = listScenarioLabels(settings)
  const labelInspection = inspectScenarioLabels(settings, scenarioMap)
  const suggestions = listSuggestions(discussions)
  const suggestionInspection = inspectSuggestions(discussions)
  const presence = inspectRegisteredProjectPresence(expectedProjectId)
  const projectDevices = await inspectProjectDeviceDirectory(settings, expectedProjectId)
  const relayAdminApprovals = await inspectProjectRelayAdminApprovals(
    settings,
    expectedProjectId,
    projectDevices,
  )
  const researchEventAttestations = await inspectProjectResearchEventAttestations(
    settings,
    expectedProjectId,
    projectDevices,
    researchEventAttestationResolver(discussions, settings),
  )
  const adversarialReviewInspection = await inspectAdversarialReviewHistory(discussions)
  const allVersions = await listPolicyVersions(versionMap)
  const versions = allVersions.filter((version) => version.projectId === expectedProjectId)
  const foreignProjectVersions = allVersions.length - versions.length
  const invalidLineageRecords = countInvalidLineages(versions)
  const verifiedVersionIds = new Set(versions.map(({ versionId }) => versionId))
  const orphanRerunPolicyVersionIds = Array.from(new Set(scenarioRerunJobs.flatMap(({ definition }) =>
    verifiedVersionIds.has(definition.policyVersionId) ? [] : [definition.policyVersionId]))).sort()
  const foreignProjectRerunJobCount = scenarioRerunJobs.filter(({ definition }) => definition.projectId !== expectedProjectId).length
  const invalidHeuristicRecords = heuristicMap.size - validHeuristics.length
  const invalidVersionRecords = versionMap.size - allVersions.length
  const issues: string[] = []
  if (invalidHeuristicRecords > 0) issues.push(`${invalidHeuristicRecords} heuristic record(s) failed validation`)
  issues.push(...heuristicExampleInspection.issues)
  issues.push(...heuristicCheckInspection.issues)
  issues.push(...scenarioGraph.issues)
  issues.push(...scenarioRerunInspection.issues)
  orphanRerunPolicyVersionIds.forEach((id) => issues.push(`Scenario rerun queue targets missing or invalid policy version ${id}`))
  if (foreignProjectRerunJobCount) issues.push(`${foreignProjectRerunJobCount} scenario rerun queue(s) belong to another project`)
  issues.push(...annotationInspection.issues)
  issues.push(...voteInspection.issues)
  issues.push(...labelInspection.issues)
  issues.push(...suggestionInspection.issues)
  issues.push(...adversarialReviewInspection.issues)
  if (presence.available && !presence.healthy) issues.push(`${presence.invalidRecords} presence record(s) failed validation or exceeded the bound`)
  if (!projectDevices.healthy) {
    issues.push(`${projectDevices.invalidRecords + projectDevices.unavailableRecords} project device registration(s) failed validation, verification, or bounds`)
  }
  if (projectDevices.conflictingDevices > 0) {
    issues.push(`${projectDevices.conflictingDevices} project device key(s) claim conflicting participant IDs`)
  }
  if (!relayAdminApprovals.healthy) {
    issues.push(`${relayAdminApprovals.invalidRecords + relayAdminApprovals.unavailableRecords} relay administration approval(s) failed validation, verification, or bounds`)
  }
  if (relayAdminApprovals.conflictingSigners > 0) {
    issues.push(`${relayAdminApprovals.conflictingSigners} project device(s) approved conflicting relay actions at the same revision`)
  }
  if (!researchEventAttestations.healthy) {
    issues.push(`${researchEventAttestations.invalidRecords + researchEventAttestations.unavailableRecords} research event attestation(s) failed event, directory, signature, or bounds validation`)
  }
  if (invalidVersionRecords > 0) issues.push(`${invalidVersionRecords} version record(s) failed hash/schema validation`)
  if (foreignProjectVersions > 0) issues.push(`${foreignProjectVersions} version record(s) belong to another project`)
  if (invalidLineageRecords > 0) issues.push(`${invalidLineageRecords} version record(s) have missing, cross-project, or cyclic ancestry`)

  let headVersionId: string | null = null
  let headLineageDepth = 0
  try {
    headVersionId = readPolicyVersionHead(metadata)
    if (headVersionId !== null) {
      const lineage = await readPolicyVersionLineage(versionMap, headVersionId)
      if (!lineage || lineage[0]?.projectId !== expectedProjectId) issues.push('The policy version head or its lineage is invalid')
      else headLineageDepth = lineage.length
    } else if (versions.length > 0) issues.push('Version records exist without a policy version head')
  } catch {
    issues.push('The policy version head has an invalid shape')
  }

  if (projectStateFingerprint(doc) !== startingRevision) throw new Error('Research state changed during inspection; inspect again')
  return {
    schemaVersion: 1,
    projectId: expectedProjectId,
    revision: startingRevision,
    presence,
    projectDevices: {
      registrationCount: projectDevices.registrationCount,
      deviceCount: projectDevices.devices.length,
      conflictingDevices: projectDevices.conflictingDevices,
      invalidRecords: projectDevices.invalidRecords,
      unavailableRecords: projectDevices.unavailableRecords,
      excessRecords: projectDevices.excessRecords,
      truncated: projectDevices.devices.length > MAX_RETURNED_ITEMS,
      items: projectDevices.devices.slice(0, MAX_RETURNED_ITEMS).map((device) => ({
        keyId: device.keyId,
        fingerprint: device.fingerprint,
        participantIds: device.participantIds,
        status: device.status,
        registrationCount: device.registrationCount,
      })),
    },
    relayAdminApprovals: {
      approvalCount: relayAdminApprovals.approvalCount,
      activeIntentCount: relayAdminApprovals.intents.length,
      activeApprovalCount: relayAdminApprovals.intents.reduce(
        (total, intent) => total + intent.approvalCount,
        0,
      ),
      conflictingSigners: relayAdminApprovals.conflictingSigners,
      expiredApprovals: relayAdminApprovals.expiredApprovals,
      invalidRecords: relayAdminApprovals.invalidRecords,
      unavailableRecords: relayAdminApprovals.unavailableRecords,
      excessRecords: relayAdminApprovals.excessRecords,
      truncated: relayAdminApprovals.intents.length > MAX_RETURNED_ITEMS,
      items: relayAdminApprovals.intents.slice(0, MAX_RETURNED_ITEMS).map((intent) => ({
        expectedRevision: intent.expectedRevision,
        actionKind: intent.action.kind,
        approvalCount: intent.approvalCount,
      })),
      enforcement: 'relay-policy-state-not-part-of-shared-project' as const,
    },
    researchEventAttestations: {
      attestationCount: researchEventAttestations.attestationCount,
      invalidRecords: researchEventAttestations.invalidRecords,
      unavailableRecords: researchEventAttestations.unavailableRecords,
      excessRecords: researchEventAttestations.excessRecords,
      truncated: researchEventAttestations.attestations.length > MAX_RETURNED_ITEMS,
      items: researchEventAttestations.attestations.slice(0, MAX_RETURNED_ITEMS),
      authority: 'installation-device-not-human-identity' as const,
      proofBodiesReturned: false as const,
    },
    heuristics: {
      totalRecords: heuristicMap.size,
      validRecords: validHeuristics.length,
      invalidRecords: invalidHeuristicRecords,
      truncated: validHeuristics.length > MAX_RETURNED_ITEMS,
      items: validHeuristics.slice(0, MAX_RETURNED_ITEMS).map((heuristic) => ({
        id: heuristic.id,
        title: heuristic.title,
        priority: heuristic.priority,
        enabled: heuristic.enabled,
        createdBy: heuristic.createdBy,
        createdAt: heuristic.createdAt,
        editCount: heuristic.edits.length,
        lastEditedAt: heuristic.edits[heuristic.edits.length - 1]?.timestamp ?? heuristic.createdAt,
      })),
    },
    heuristicExamples: {
      exampleCount: heuristicExampleInspection.exampleCount,
      removedCount: heuristicExampleInspection.removedCount,
      positiveCount: heuristicExampleInspection.positiveCount,
      negativeCount: heuristicExampleInspection.negativeCount,
      invalidRecords: heuristicExampleInspection.invalidRecords,
      orphanHeuristicIds: heuristicExampleInspection.orphanHeuristicIds,
    },
    heuristicChecks: {
      resultCount: heuristicCheckInspection.resultCount,
      passCount: heuristicCheckInspection.passCount,
      failCount: heuristicCheckInspection.failCount,
      uncertainCount: heuristicCheckInspection.uncertainCount,
      localCount: heuristicCheckInspection.localCount,
      remoteCount: heuristicCheckInspection.remoteCount,
      invalidRecords: heuristicCheckInspection.invalidRecords,
      orphanHeuristicIds: heuristicCheckInspection.orphanHeuristicIds,
    },
    scenarios: {
      totalRecords: scenarioMap.size,
      validRecords: validScenarios.length,
      invalidRecords: scenarioGraph.invalidRecords,
      rootCount: scenarioGraph.roots.length,
      branchCount: scenarioGraph.edges.length,
      truncated: validScenarios.length > MAX_RETURNED_ITEMS,
      items: validScenarios.slice(0, MAX_RETURNED_ITEMS).map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        status: scenario.status,
        parentScenarioId: scenario.parentScenarioId,
        createdBy: scenario.createdBy,
        createdAt: scenario.createdAt,
        turnCount: scenario.turns.length,
        turnRevisionCount: scenario.turns.reduce((total, turn) => total + turn.revisions.length, 0),
        editCount: scenario.edits.length,
      })),
    },
    scenarioReruns: {
      jobCount: scenarioRerunInspection.jobCount,
      runningCount: scenarioRerunInspection.runningCount,
      pausedCount: scenarioRerunInspection.pausedCount,
      cancelledCount: scenarioRerunInspection.cancelledCount,
      completeCount: scenarioRerunInspection.completeCount,
      itemCount: scenarioRerunInspection.itemCount,
      completedItemCount: scenarioRerunInspection.completedItemCount,
      failedItemCount: scenarioRerunInspection.failedItemCount,
      interruptedItemCount: scenarioRerunInspection.interruptedItemCount,
      localJobCount: scenarioRerunJobs.filter(({ definition }) => definition.providerId === 'local').length,
      remoteJobCount: scenarioRerunJobs.filter(({ definition }) => definition.providerId !== 'local').length,
      comparablePairCount: countComparableScenarioRerunPairs(scenarioRerunJobs),
      invalidRecords: scenarioRerunInspection.invalidRecords,
      orphanScenarioIds: scenarioRerunInspection.orphanScenarioIds,
      orphanPolicyVersionIds: orphanRerunPolicyVersionIds,
      foreignProjectJobCount: foreignProjectRerunJobCount,
    },
    scenarioVotes: {
      summaryCount: voteInspection.summaryCount,
      invalidRecords: voteInspection.invalidRecords,
      orphanScenarioIds: voteInspection.orphanScenarioIds,
      truncated: voteSummaries.length > MAX_RETURNED_ITEMS,
      items: voteSummaries.slice(0, MAX_RETURNED_ITEMS).map((summary) => ({
        scenarioId: summary.scenarioId,
        counts: { ...summary.counts },
        activeVoteCount: summary.activeVotes.length,
        eventCount: summary.history.length,
      })),
    },
    scenarioAnnotations: {
      annotationCount: annotationInspection.annotationCount,
      invalidRecords: annotationInspection.invalidRecords,
      orphanScenarioIds: annotationInspection.orphanScenarioIds,
      orphanTurnTargets: annotationInspection.orphanTurnTargets,
      openCount: annotationSummaries.filter((annotation) => annotation.status === 'open').length,
      resolvedCount: annotationSummaries.filter((annotation) => annotation.status === 'resolved').length,
      truncated: annotationSummaries.length > MAX_RETURNED_ITEMS,
      items: annotationSummaries.slice(0, MAX_RETURNED_ITEMS).map((annotation) => ({
        id: annotation.id,
        scenarioId: annotation.scenarioId,
        turnId: annotation.turnId,
        kind: annotation.kind,
        status: annotation.status,
        currentEventId: annotation.currentEventId,
        createdAt: annotation.createdAt,
        lastActionAt: annotation.lastActionAt,
        eventCount: annotation.events.length,
      })),
    },
    scenarioLabels: {
      labelCount: labelInspection.labelCount,
      assignmentCount: labelInspection.assignmentCount,
      invalidRecords: labelInspection.invalidRecords,
      orphanScenarioIds: labelInspection.orphanScenarioIds,
      orphanLabelIds: labelInspection.orphanLabelIds,
      truncated: scenarioLabels.length > MAX_RETURNED_ITEMS,
      items: scenarioLabels.slice(0, MAX_RETURNED_ITEMS).map((label) => ({
        id: label.id,
        name: label.name,
        currentEventId: label.currentEventId,
        createdBy: label.createdBy,
        createdAt: label.createdAt,
        lastActionBy: label.lastActionBy,
        lastActionAt: label.lastActionAt,
        eventCount: label.events.length,
        scenarioIds: listScenarioIdsForLabel(settings, label.id).slice(0, MAX_RETURNED_ITEMS),
      })),
    },
    suggestions: {
      suggestionCount: suggestionInspection.suggestionCount,
      pendingCount: suggestionInspection.pendingCount,
      invalidRecords: suggestionInspection.invalidRecords,
      conflictedSuggestionIds: suggestionInspection.conflictedSuggestionIds,
      truncated: suggestions.length > MAX_RETURNED_ITEMS,
      items: suggestions.slice(0, MAX_RETURNED_ITEMS).map((suggestion) => ({
        id: suggestion.id,
        status: suggestion.status,
        proposalEventId: suggestion.proposal.eventId,
        sourceKind: suggestion.proposal.sourceKind,
        providerId: suggestion.proposal.providerId,
        modelId: suggestion.proposal.modelId,
        runId: suggestion.proposal.runId,
        authorId: suggestion.proposal.authorId,
        authorDisplayName: suggestion.proposal.authorDisplayName,
        createdAt: suggestion.proposal.timestamp,
        decisionCount: suggestion.decisions.length,
      })),
    },
    adversarialReviews: {
      archiveCount: adversarialReviewInspection.archiveCount,
      decisionCount: adversarialReviewInspection.decisionCount,
      invalidRecords: adversarialReviewInspection.invalidRecords,
      conflictedRunIds: adversarialReviewInspection.conflictedRunIds,
      truncated: adversarialReviewInspection.items.length > MAX_RETURNED_ITEMS,
      items: adversarialReviewInspection.items.slice(0, MAX_RETURNED_ITEMS),
    },
    versions: {
      totalRecords: versionMap.size,
      validRecords: versions.length,
      invalidRecords: invalidVersionRecords,
      foreignProjectRecords: foreignProjectVersions,
      invalidLineageRecords,
      headVersionId,
      headLineageDepth,
      truncated: versions.length > MAX_RETURNED_ITEMS,
      items: versions.slice(-MAX_RETURNED_ITEMS).map((version) => ({
        versionId: version.versionId,
        parentVersionId: version.parentVersionId,
        participantId: version.author.participantId,
        displayName: version.author.displayName,
        createdAt: version.createdAt,
        blockCount: version.policy.blocks.length,
        scenarioCount: version.scenarioIds.length,
        hasNote: version.note !== null,
        isHead: version.versionId === headVersionId,
      })),
    },
    selfCheck: { healthy: issues.length === 0, issues },
    limitations: [
      'inspection itself is read-only; separate revision-guarded MCP tools can mutate scenarios, votes, annotations, labels, and policy versions, but suggestion decisions, heuristic mutation, and broader scenario lifecycle remain unavailable through MCP',
      'presence reports only active provider mode and bounded session counts; Drive polling is explicitly not live presence, and inspection does not prove an underlying transport healthy',
      'project device registrations expose stable public fingerprints and self-reported participant IDs from shared project state; they prove only possession of self-issued keys and grant no identity, role, revocation, or relay authority',
      'counts and integrity are checked; policy text, adversarial-review question/source/result/decision-note bodies, suggestion content and decision bodies, heuristic guidance, example bodies/attribution, and heuristic-check rationale, uncertainty, citation text, scenario background/turn content/revision bodies, scenario-evaluation response/rationale/uncertainty bodies, annotation/voter bodies, label event bodies, edit values, and version notes are omitted',
    ],
  }
}
