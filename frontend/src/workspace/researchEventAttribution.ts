import type * as Y from 'yjs'
import type { ProjectResearchEventKind } from '../tauri'
import { getProjectSharedTypes } from './projectModel'
import {
  createProjectResearchEventAttestation,
  publishProjectResearchEventAttestation,
  type ProjectResearchEventAttestationRecord,
  type ProjectResearchEventResolver,
} from './projectResearchEventAttestation'
import {
  inspectProjectDeviceDirectory,
  type ProjectDeviceDirectoryInspection,
} from './projectDeviceDirectory'
import {
  readScenarioAnnotationEvent,
  scenarioAnnotationEventSha256,
  type ScenarioAnnotationEvent,
} from './scenarioAnnotationModel'
import {
  readScenarioLabelAssignmentEvent,
  readScenarioLabelEvent,
  scenarioLabelAssignmentEventSha256,
  scenarioLabelEventSha256,
  type ScenarioLabelAssignmentEvent,
  type ScenarioLabelEvent,
} from './scenarioLabelModel'
import {
  policyVersionEventSha256,
  readPolicyVersion,
  type PolicyVersion,
} from './policyVersionModel'
import {
  readScenarioTurnRevision,
  scenarioTurnRevisionSha256,
  type ResearchScenario,
  type ScenarioTurnRevision,
} from './scenarioModel'
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

export interface AttributedScenarioAnnotation {
  event: ScenarioAnnotationEvent
  attribution: ResearchEventAttributionResult
}

export type ScenarioLabelResearchEvent = ScenarioLabelEvent | ScenarioLabelAssignmentEvent

export interface AttributedScenarioLabelEvent {
  event: ScenarioLabelResearchEvent
  attribution: ResearchEventAttributionResult
}

export interface AttributedScenarioTurnRevision {
  scenario: ResearchScenario
  revision: ScenarioTurnRevision
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

export function scenarioAnnotationAttestationEventId(event: ScenarioAnnotationEvent): string {
  return `${event.scenarioId.length}:${event.scenarioId}${event.eventId}`
}

export function scenarioLabelAttestationEventId(event: ScenarioLabelResearchEvent): string {
  if ('scenarioId' in event) {
    return `a:${event.scenarioId.length}:${event.scenarioId}${event.labelId.length}:${event.labelId}${event.eventId}`
  }
  return `l:${event.labelId.length}:${event.labelId}${event.eventId}`
}

export function scenarioTurnAttestationEventId(
  scenarioId: string,
  turnId: string,
  revision: ScenarioTurnRevision,
): string {
  return `t:${scenarioId.length}:${scenarioId}${turnId.length}:${turnId}${revision.editId}`
}

function parseLengthPrefixed(
  value: string,
  cursor: number,
): { segment: string; cursor: number } | null {
  const separator = value.indexOf(':', cursor)
  if (separator < 1) return null
  const lengthText = value.slice(cursor, separator)
  if (!/^\d{1,3}$/.test(lengthText)) return null
  const length = Number(lengthText)
  const start = separator + 1
  const segment = value.slice(start, start + length)
  if (segment.length !== length || !segment) return null
  return { segment, cursor: start + length }
}

function parseScenarioAttestationEventId(value: string): { scenarioId: string; eventId: string } | null {
  const scenario = parseLengthPrefixed(value, 0)
  if (!scenario) return null
  const eventId = value.slice(scenario.cursor)
  return eventId ? { scenarioId: scenario.segment, eventId } : null
}

type ScenarioLabelAttestationIdentity = {
  recordType: 'label'
  labelId: string
  eventId: string
} | {
  recordType: 'assignment'
  scenarioId: string
  labelId: string
  eventId: string
}

function parseScenarioLabelAttestationEventId(value: string): ScenarioLabelAttestationIdentity | null {
  if (value.startsWith('l:')) {
    const label = parseLengthPrefixed(value, 2)
    if (!label) return null
    const eventId = value.slice(label.cursor)
    return eventId ? { recordType: 'label', labelId: label.segment, eventId } : null
  }
  if (!value.startsWith('a:')) return null
  const scenario = parseLengthPrefixed(value, 2)
  if (!scenario) return null
  const label = parseLengthPrefixed(value, scenario.cursor)
  if (!label) return null
  const eventId = value.slice(label.cursor)
  return eventId ? {
    recordType: 'assignment', scenarioId: scenario.segment, labelId: label.segment, eventId,
  } : null
}

function parseScenarioTurnAttestationEventId(value: string): {
  scenarioId: string
  turnId: string
  editId: string
} | null {
  if (!value.startsWith('t:')) return null
  const scenario = parseLengthPrefixed(value, 2)
  if (!scenario) return null
  const turn = parseLengthPrefixed(value, scenario.cursor)
  if (!turn) return null
  const editId = value.slice(turn.cursor)
  return editId ? { scenarioId: scenario.segment, turnId: turn.segment, editId } : null
}

export function researchEventAttestationResolver(
  discussions: Y.Map<unknown>,
  settings?: Y.Map<unknown>,
  versions?: Y.Map<unknown>,
  scenarios?: Y.Map<unknown>,
): ProjectResearchEventResolver {
  const cache = new Map<string, Promise<{ eventSha256: string; participantId: string } | null>>()
  return (eventKind, attestationEventId) => {
    if (eventKind !== 'scenario-vote' && eventKind !== 'scenario-annotation' &&
      eventKind !== 'scenario-label' && eventKind !== 'policy-version' &&
      eventKind !== 'scenario-turn') return null
    const cacheKey = `${eventKind}:${attestationEventId}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const resolved = (async () => {
      if (eventKind === 'scenario-turn') {
        if (!scenarios) return null
        const identity = parseScenarioTurnAttestationEventId(attestationEventId)
        if (!identity) return null
        const revision = readScenarioTurnRevision(
          scenarios, identity.scenarioId, identity.turnId, identity.editId,
        )
        return revision ? {
          eventSha256: await scenarioTurnRevisionSha256(revision),
          participantId: revision.authorId,
        } : null
      }
      if (eventKind === 'policy-version') {
        if (!versions) return null
        const version = await readPolicyVersion(versions, attestationEventId)
        return version ? {
          eventSha256: await policyVersionEventSha256(version),
          participantId: version.author.participantId,
        } : null
      }
      if (eventKind === 'scenario-label') {
        if (!settings) return null
        const identity = parseScenarioLabelAttestationEventId(attestationEventId)
        if (!identity) return null
        if (identity.recordType === 'label') {
          const event = readScenarioLabelEvent(settings, identity.labelId, identity.eventId)
          return event ? {
            eventSha256: await scenarioLabelEventSha256(event), participantId: event.authorId,
          } : null
        }
        const event = readScenarioLabelAssignmentEvent(
          settings, identity.scenarioId, identity.labelId, identity.eventId,
        )
        return event ? {
          eventSha256: await scenarioLabelAssignmentEventSha256(event), participantId: event.authorId,
        } : null
      }
      const identity = parseScenarioAttestationEventId(attestationEventId)
      if (!identity) return null
      if (eventKind === 'scenario-vote') {
        const event = readScenarioVoteEvent(discussions, identity.scenarioId, identity.eventId)
        return event ? {
          eventSha256: await scenarioVoteEventSha256(event), participantId: event.participantId,
        } : null
      }
      const event = readScenarioAnnotationEvent(discussions, identity.scenarioId, identity.eventId)
      return event ? {
        eventSha256: await scenarioAnnotationEventSha256(event), participantId: event.authorId,
      } : null
    })()
    cache.set(cacheKey, resolved)
    return resolved
  }
}

async function attestResearchEvent(
  document: Y.Doc,
  projectId: string,
  eventKind: 'scenario-vote' | 'scenario-annotation' | 'scenario-label' | 'policy-version' | 'scenario-turn',
  eventId: string,
  participantId: string,
  eventHash: () => Promise<string>,
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
  let eventSha256: string
  let record: ProjectResearchEventAttestationRecord
  try {
    eventSha256 = await eventHash()
    record = await dependencies.create(
      projectId, participantId, eventKind, eventId, eventSha256,
    )
  } catch {
    return {
      status: 'unsigned',
      reason: 'signing-or-registration-unavailable',
      authority: 'installation-device-not-human-identity',
    }
  }
  try {
    const { discussions, settings, versions, scenarios } = getProjectSharedTypes(document)
    const inspection = await publishProjectResearchEventAttestation(
      settings,
      projectId,
      directory,
      researchEventAttestationResolver(discussions, settings, versions, scenarios),
      record,
    )
    return {
      status: 'signed-device',
      keyId: record.proof.keyId,
      eventKind,
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
 * Best-effort durable device attribution after a vote event has committed. Failure never rolls back
 * or disguises the research mutation; callers receive an explicit unsigned result.
 */
export async function attestScenarioVoteEvent(
  document: Y.Doc,
  projectId: string,
  event: ScenarioVoteEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'scenario-vote',
    scenarioVoteAttestationEventId(event),
    event.participantId,
    () => scenarioVoteEventSha256(event),
    dependencies,
  )
}

/** Best-effort device attribution after a create/edit/resolve/reopen event has committed. */
export async function attestScenarioAnnotationEvent(
  document: Y.Doc,
  projectId: string,
  event: ScenarioAnnotationEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'scenario-annotation',
    scenarioAnnotationAttestationEventId(event),
    event.authorId,
    () => scenarioAnnotationEventSha256(event),
    dependencies,
  )
}

/** Best-effort device attribution after a label create/rename/add/remove event has committed. */
export async function attestScenarioLabelEvent(
  document: Y.Doc,
  projectId: string,
  event: ScenarioLabelResearchEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'scenario-label',
    scenarioLabelAttestationEventId(event),
    event.authorId,
    () => 'scenarioId' in event
      ? scenarioLabelAssignmentEventSha256(event)
      : scenarioLabelEventSha256(event),
    dependencies,
  )
}

/** Best-effort device attribution after an immutable save or restore checkpoint has committed. */
export async function attestPolicyVersionEvent(
  document: Y.Doc,
  projectId: string,
  version: PolicyVersion,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'policy-version',
    version.versionId,
    version.author.participantId,
    () => policyVersionEventSha256(version),
    dependencies,
  )
}

/** Best-effort device attribution after an immutable scenario-turn revision has committed. */
export async function attestScenarioTurnRevisionEvent(
  document: Y.Doc,
  projectId: string,
  scenarioId: string,
  turnId: string,
  revision: ScenarioTurnRevision,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'scenario-turn',
    scenarioTurnAttestationEventId(scenarioId, turnId, revision),
    revision.authorId,
    () => scenarioTurnRevisionSha256(revision),
    dependencies,
  )
}

/** Product turn path: validate identity, commit once, resolve the exact revision, then attest. */
export async function commitScenarioTurnWithAttribution(
  document: Y.Doc,
  projectId: string,
  scenarioId: string,
  turnId: string,
  editId: string,
  commit: () => ResearchScenario,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<AttributedScenarioTurnRevision> {
  const shared = getProjectSharedTypes(document)
  if (shared.metadata.get('projectId') !== projectId) {
    throw new Error('Live collaboration document project identity does not match')
  }
  const scenario = commit()
  const revision = readScenarioTurnRevision(shared.scenarios, scenarioId, turnId, editId)
  if (!revision) throw new Error('Scenario turn revision was not retained')
  return {
    scenario,
    revision,
    attribution: await attestScenarioTurnRevisionEvent(
      document, projectId, scenarioId, turnId, revision, dependencies,
    ),
  }
}

/** Product annotation path: validate project identity, commit once, then attest best-effort. */
export async function commitScenarioAnnotationWithAttribution(
  document: Y.Doc,
  projectId: string,
  commit: () => ScenarioAnnotationEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<AttributedScenarioAnnotation> {
  if (getProjectSharedTypes(document).metadata.get('projectId') !== projectId) {
    throw new Error('Project identity does not match the annotation document')
  }
  const event = commit()
  return {
    event,
    attribution: await attestScenarioAnnotationEvent(document, projectId, event, dependencies),
  }
}

/** Product label path: validate project identity, commit once, then attest best-effort. */
export async function commitScenarioLabelWithAttribution(
  document: Y.Doc,
  projectId: string,
  commit: () => ScenarioLabelResearchEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<AttributedScenarioLabelEvent> {
  if (getProjectSharedTypes(document).metadata.get('projectId') !== projectId) {
    throw new Error('Project identity does not match the label document')
  }
  const event = commit()
  return {
    event,
    attribution: await attestScenarioLabelEvent(document, projectId, event, dependencies),
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
