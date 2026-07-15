import type * as Y from 'yjs'
import { listHeuristics } from './heuristicsModel'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { listPolicyVersions, readPolicyVersionHead, readPolicyVersionLineage } from './policyVersionModel'
import type { PolicyVersion } from './policyVersionModel'
import { inspectScenarioGraph, listScenarios } from './scenarioModel'
import { inspectScenarioAnnotations, listScenarioAnnotationSummaries } from './scenarioAnnotationModel'
import { inspectScenarioVotes, listScenarioVoteSummaries } from './scenarioVoteModel'

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
  const { metadata, discussions, heuristics: heuristicMap, scenarios: scenarioMap, versions: versionMap } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== expectedProjectId) throw new Error('Live collaboration document project identity does not match')

  const validHeuristics = listHeuristics(heuristicMap)
  const validScenarios = listScenarios(scenarioMap)
  const scenarioGraph = inspectScenarioGraph(scenarioMap)
  const annotationSummaries = listScenarioAnnotationSummaries(discussions)
  const annotationInspection = inspectScenarioAnnotations(discussions, scenarioMap)
  const voteSummaries = listScenarioVoteSummaries(discussions)
  const voteInspection = inspectScenarioVotes(discussions, scenarioMap)
  const allVersions = await listPolicyVersions(versionMap)
  const versions = allVersions.filter((version) => version.projectId === expectedProjectId)
  const foreignProjectVersions = allVersions.length - versions.length
  const invalidLineageRecords = countInvalidLineages(versions)
  const invalidHeuristicRecords = heuristicMap.size - validHeuristics.length
  const invalidVersionRecords = versionMap.size - allVersions.length
  const issues: string[] = []
  if (invalidHeuristicRecords > 0) issues.push(`${invalidHeuristicRecords} heuristic record(s) failed validation`)
  issues.push(...scenarioGraph.issues)
  issues.push(...annotationInspection.issues)
  issues.push(...voteInspection.issues)
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
        createdAt: annotation.createdAt,
        lastActionAt: annotation.lastActionAt,
        eventCount: annotation.events.length,
      })),
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
      'read-only MCP inspection; no version, heuristic, scenario, vote, flag, or note mutation authority',
      'local live collaboration document; Drive/WebSocket project transport is not implemented',
      'counts and integrity are checked; policy text, heuristic guidance, scenario background/turn content/revision bodies, annotation/voter bodies, edit values, and version notes are omitted',
    ],
  }
}
