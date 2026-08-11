import type * as Y from 'yjs'
import type { ProjectResearchEventKind } from '../tauri'
import { getProjectSharedTypes } from './projectModel'
import {
  createProjectResearchEventAttestation,
  publishProjectResearchEventAttestation,
  type ProjectResearchEventAttestationRecord,
  type ProjectResearchEventHashResolver,
} from './projectResearchEventAttestation'
import {
  inspectProjectDeviceDirectory,
  type ProjectDeviceDirectoryInspection,
} from './projectDeviceDirectory'
import {
  castScenarioVote,
  readScenarioVoteEvent,
  scenarioVoteEventSha256,
  type CastScenarioVoteInput,
  type ScenarioVoteEvent,
  type ScenarioVoteSummary,
} from './scenarioVoteModel'

export type ResearchEventAttributionResult = {
  status: 'signed-device'
  keyId: string
  eventKind: ProjectResearchEventKind
  eventId: string
  eventSha256: string
  attestationCount: number
  authority: 'installation-device-not-human-identity'
} | {
  status: 'unsigned'
  reason: 'device-directory-unhealthy' | 'signing-or-registration-unavailable' | 'attestation-history-unhealthy'
  authority: 'installation-device-not-human-identity'
}

export interface ResearchEventAttributionDependencies {
  inspectDirectory: (
    document: Y.Doc,
    projectId: string,
  ) => Promise<ProjectDeviceDirectoryInspection>
  create: (
    projectId: string,
    participantId: string,
    eventKind: ProjectResearchEventKind,
    eventId: string,
    eventSha256: string,
  ) => Promise<ProjectResearchEventAttestationRecord>
}

export interface AttributedScenarioVote {
  summary: ScenarioVoteSummary
  event: ScenarioVoteEvent
  attribution: ResearchEventAttributionResult
}

const DEFAULT_DEPENDENCIES: ResearchEventAttributionDependencies = {
  inspectDirectory: (document, projectId) => inspectProjectDeviceDirectory(
    getProjectSharedTypes(document).settings,
    projectId,
  ),
  create: createProjectResearchEventAttestation,
}

export function scenarioVoteAttestationEventId(event: ScenarioVoteEvent): string {
  return `${event.scenarioId.length}:${event.scenarioId}${event.eventId}`
}

function parseScenarioVoteAttestationEventId(value: string): { scenarioId: string; eventId: string } | null {
  const separator = value.indexOf(':')
  if (separator < 1) return null
  const lengthText = value.slice(0, separator)
  if (!/^\d{1,3}$/.test(lengthText)) return null
  const scenarioLength = Number(lengthText)
  const start = separator + 1
  const scenarioId = value.slice(start, start + scenarioLength)
  const eventId = value.slice(start + scenarioLength)
  if (scenarioId.length !== scenarioLength || !scenarioId || !eventId) return null
  return { scenarioId, eventId }
}

export function scenarioVoteAttestationResolver(
  discussions: Y.Map<unknown>,
): ProjectResearchEventHashResolver {
  const cache = new Map<string, Promise<string | null>>()
  return (eventKind, attestationEventId) => {
    if (eventKind !== 'scenario-vote') return null
    const cached = cache.get(attestationEventId)
    if (cached) return cached
    const resolved = (async () => {
      const identity = parseScenarioVoteAttestationEventId(attestationEventId)
      if (!identity) return null
      const event = readScenarioVoteEvent(discussions, identity.scenarioId, identity.eventId)
      return event ? scenarioVoteEventSha256(event) : null
    })()
    cache.set(attestationEventId, resolved)
    return resolved
  }
}

/**
 * Best-effort durable device attribution after a vote event has committed. Failure never rolls back
 * or disguises the research mutation; callers receive an explicit unsigned result.
 */
export async function attestScenarioVoteEvent(
  document: Y.Doc,
  projectId: string,
  event: ScenarioVoteEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  let directory: ProjectDeviceDirectoryInspection
  try {
    directory = await dependencies.inspectDirectory(document, projectId)
  } catch {
    return {
      status: 'unsigned',
      reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    }
  }
  if (!directory.healthy) {
    return {
      status: 'unsigned',
      reason: 'device-directory-unhealthy',
      authority: 'installation-device-not-human-identity',
    }
  }
  const { discussions, settings } = getProjectSharedTypes(document)
  const eventId = scenarioVoteAttestationEventId(event)
  let eventSha256: string
  let record: ProjectResearchEventAttestationRecord
  try {
    eventSha256 = await scenarioVoteEventSha256(event)
    record = await dependencies.create(
      projectId, event.participantId, 'scenario-vote', eventId, eventSha256,
    )
  } catch {
    return {
      status: 'unsigned',
      reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    }
  }
  try {
    const inspection = await publishProjectResearchEventAttestation(
      settings,
      projectId,
      directory,
      scenarioVoteAttestationResolver(discussions),
      record,
    )
    return {
      status: 'signed-device',
      keyId: record.proof.keyId,
      eventKind: 'scenario-vote',
      eventId,
      eventSha256,
      attestationCount: inspection.attestationCount,
      authority: 'installation-device-not-human-identity',
    }
  } catch (error) {
    return {
      status: 'unsigned',
      reason: error instanceof Error && error.message.includes('history is not safe')
        ? 'attestation-history-unhealthy'
        : 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    }
  }
}

/**
 * Product vote path: retain the immutable event first, then attempt the same best-effort device
 * attribution used by MCP. Attribution failure is data returned to the UI, never a vote rollback.
 */
export async function castScenarioVoteWithAttribution(
  document: Y.Doc,
  projectId: string,
  input: CastScenarioVoteInput,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<AttributedScenarioVote> {
  const { metadata, discussions, scenarios } = getProjectSharedTypes(document)
  if (metadata.get('projectId') !== projectId) {
    throw new Error('Project identity does not match the vote document')
  }
  const summary = castScenarioVote(discussions, scenarios, input)
  const event = readScenarioVoteEvent(discussions, input.scenarioId, input.eventId)
  if (!event) throw new Error('Scenario vote event was not retained')
  return {
    summary,
    event,
    attribution: await attestScenarioVoteEvent(document, projectId, event, dependencies),
  }
}
