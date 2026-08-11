import type * as Y from 'yjs'
import type { ProjectResearchEventKind } from '../tauri'
import {
  adversarialReviewArchiveEventSha256,
  adversarialReviewDecisionEventSha256,
  readAdversarialReviewArchive,
  readAdversarialReviewDecisionEvent,
  type AdversarialReviewArchive,
  type AdversarialReviewDecisionEvent,
} from '../extensions/adversarialHistory'
import {
  pluginReviewEventSha256,
  readPluginReviewEvent,
  type PluginReviewEvent,
} from '../extensions/pluginReviewModel'
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
  readScenarioEdit,
  readScenarioTurnRevision,
  scenarioEditSha256,
  scenarioTurnRevisionSha256,
  type ResearchScenario,
  type ScenarioEdit,
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
import {
  readSuggestionEvent,
  suggestionEventSha256,
  type SuggestionEvent,
} from './suggestionModel'
import {
  heuristicEditSha256,
  readHeuristicEdit,
  type HeuristicEdit,
} from './heuristicsModel'
import {
  heuristicExampleEventSha256,
  readHeuristicExampleEvent,
  type HeuristicExampleEvent,
} from './heuristicExampleModel'
import {
  heuristicCheckResultSha256,
  readHeuristicCheckResult,
  type HeuristicCheckResult,
} from './heuristicCheckResultModel'
import {
  readScenarioEvaluationResult,
  readScenarioRerunControlEvent,
  readScenarioRerunDefinition,
  readScenarioRerunItemEvent,
  scenarioRerunResearchEventSha256,
  type ScenarioEvaluationResult,
  type ScenarioRerunControlEvent,
  type ScenarioRerunItemEvent,
  type ScenarioRerunJobDefinition,
  type ScenarioRerunResearchEvent,
} from './scenarioRerunQueue'

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

export interface AttributedScenarioEdit {
  scenario: ResearchScenario
  edit: ScenarioEdit
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

export function scenarioEditAttestationEventId(scenarioId: string, edit: ScenarioEdit): string {
  return `s:${scenarioId.length}:${scenarioId}${edit.editId}`
}

export function adversarialReviewArchiveAttestationEventId(
  archive: AdversarialReviewArchive,
): string {
  return `a:${archive.runId}`
}

export function adversarialReviewDecisionAttestationEventId(
  event: AdversarialReviewDecisionEvent,
): string {
  return `d:${event.runId.length}:${event.runId}${event.eventId}`
}

export function suggestionAttestationEventId(event: SuggestionEvent): string {
  return `${event.suggestionId.length}:${event.suggestionId}${event.eventId}`
}

export function pluginReviewAttestationEventId(event: PluginReviewEvent): string {
  return `${event.reviewId.length}:${event.reviewId}${event.eventId}`
}

function pluginReviewParticipantId(event: PluginReviewEvent): string {
  return event.kind === 'proposal' ? event.runnerId
    : event.kind === 'decision' ? event.reviewerId : event.applierId
}

export function heuristicEditAttestationEventId(heuristicId: string, edit: HeuristicEdit): string {
  return `h:${heuristicId.length}:${heuristicId}${edit.editId}`
}

export function heuristicExampleAttestationEventId(event: HeuristicExampleEvent): string {
  return `e:${event.heuristicId.length}:${event.heuristicId}${event.exampleId.length}:${event.exampleId}${event.eventId}`
}

export function heuristicCheckResultAttestationEventId(result: HeuristicCheckResult): string {
  return `r:${result.heuristicId.length}:${result.heuristicId}${result.resultId}`
}

export function scenarioRerunDefinitionAttestationEventId(definition: ScenarioRerunJobDefinition): string {
  return `d:${definition.jobId.length}:${definition.jobId}`
}

export function scenarioRerunControlAttestationEventId(event: ScenarioRerunControlEvent): string {
  return `c:${event.jobId.length}:${event.jobId}${event.eventId}`
}

export function scenarioRerunItemAttestationEventId(event: ScenarioRerunItemEvent): string {
  return `i:${event.jobId.length}:${event.jobId}${event.itemId.length}:${event.itemId}${event.eventId}`
}

export function scenarioEvaluationResultAttestationEventId(result: ScenarioEvaluationResult): string {
  return `r:${result.jobId.length}:${result.jobId}${result.resultId}`
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

function parseScenarioEditAttestationEventId(value: string): {
  scenarioId: string
  editId: string
} | null {
  if (!value.startsWith('s:')) return null
  const scenario = parseLengthPrefixed(value, 2)
  if (!scenario) return null
  const editId = value.slice(scenario.cursor)
  return editId ? { scenarioId: scenario.segment, editId } : null
}

type AdversarialReviewAttestationIdentity = {
  recordType: 'archive'
  runId: string
} | {
  recordType: 'decision'
  runId: string
  eventId: string
}

function parseAdversarialReviewAttestationEventId(
  value: string,
): AdversarialReviewAttestationIdentity | null {
  if (value.startsWith('a:')) {
    const runId = value.slice(2)
    return runId ? { recordType: 'archive', runId } : null
  }
  if (!value.startsWith('d:')) return null
  const run = parseLengthPrefixed(value, 2)
  if (!run) return null
  const eventId = value.slice(run.cursor)
  return eventId ? { recordType: 'decision', runId: run.segment, eventId } : null
}

type HeuristicAttestationIdentity = {
  recordType: 'edit' | 'result'
  heuristicId: string
  eventId: string
} | {
  recordType: 'example'
  heuristicId: string
  exampleId: string
  eventId: string
}

function parseHeuristicAttestationEventId(value: string): HeuristicAttestationIdentity | null {
  if (!/^[her]:/.test(value)) return null
  const recordType = value[0] === 'h' ? 'edit' : value[0] === 'e' ? 'example' : 'result'
  const heuristic = parseLengthPrefixed(value, 2)
  if (!heuristic) return null
  if (recordType !== 'example') {
    const eventId = value.slice(heuristic.cursor)
    return eventId ? { recordType, heuristicId: heuristic.segment, eventId } : null
  }
  const example = parseLengthPrefixed(value, heuristic.cursor)
  if (!example) return null
  const eventId = value.slice(example.cursor)
  return eventId ? {
    recordType, heuristicId: heuristic.segment, exampleId: example.segment, eventId,
  } : null
}

type ScenarioRerunAttestationIdentity = {
  recordType: 'definition'
  jobId: string
} | {
  recordType: 'control'
  jobId: string
  eventId: string
} | {
  recordType: 'item'
  jobId: string
  itemId: string
  eventId: string
} | {
  recordType: 'result'
  jobId: string
  resultId: string
}

function parseScenarioRerunAttestationEventId(value: string): ScenarioRerunAttestationIdentity | null {
  if (value.startsWith('d:')) {
    const job = parseLengthPrefixed(value, 2)
    return job && job.cursor === value.length ? { recordType: 'definition', jobId: job.segment } : null
  }
  if (!/^[cir]:/.test(value)) return null
  const job = parseLengthPrefixed(value, 2)
  if (!job) return null
  if (value.startsWith('i:')) {
    const item = parseLengthPrefixed(value, job.cursor)
    if (!item) return null
    const eventId = value.slice(item.cursor)
    return eventId ? {
      recordType: 'item', jobId: job.segment, itemId: item.segment, eventId,
    } : null
  }
  const retainedId = value.slice(job.cursor)
  if (!retainedId) return null
  return value.startsWith('c:')
    ? { recordType: 'control', jobId: job.segment, eventId: retainedId }
    : { recordType: 'result', jobId: job.segment, resultId: retainedId }
}

export function researchEventAttestationResolver(
  discussions: Y.Map<unknown>,
  settings?: Y.Map<unknown>,
  versions?: Y.Map<unknown>,
  scenarios?: Y.Map<unknown>,
  heuristics?: Y.Map<unknown>,
): ProjectResearchEventResolver {
  const cache = new Map<string, Promise<{ eventSha256: string; participantId: string } | null>>()
  return (eventKind, attestationEventId) => {
    if (eventKind !== 'scenario' && eventKind !== 'scenario-vote' && eventKind !== 'scenario-annotation' &&
      eventKind !== 'scenario-label' && eventKind !== 'policy-version' &&
      eventKind !== 'scenario-turn' && eventKind !== 'adversarial-review' &&
      eventKind !== 'plugin-review' &&
      eventKind !== 'suggestion' && eventKind !== 'heuristic' && eventKind !== 'scenario-rerun') return null
    const cacheKey = `${eventKind}:${attestationEventId}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const resolved = (async () => {
      if (eventKind === 'scenario-rerun') {
        if (!settings) return null
        const identity = parseScenarioRerunAttestationEventId(attestationEventId)
        if (!identity) return null
        let record: ScenarioRerunResearchEvent | null = null
        if (identity.recordType === 'definition') {
          const definition = readScenarioRerunDefinition(settings, discussions, identity.jobId)
          record = definition ? { recordType: 'definition', definition } : null
        } else if (identity.recordType === 'control') {
          const event = readScenarioRerunControlEvent(
            settings, discussions, identity.jobId, identity.eventId,
          )
          record = event ? { recordType: 'control', event } : null
        } else if (identity.recordType === 'item') {
          const event = readScenarioRerunItemEvent(
            settings, discussions, identity.jobId, identity.itemId, identity.eventId,
          )
          record = event ? { recordType: 'item', event } : null
        } else {
          const result = readScenarioEvaluationResult(
            settings, discussions, identity.jobId, identity.resultId,
          )
          record = result ? { recordType: 'result', result } : null
        }
        if (!record) return null
        const participantId = record.recordType === 'definition' ? record.definition.createdBy
          : record.recordType === 'result' ? record.result.authorId : record.event.authorId
        return { eventSha256: await scenarioRerunResearchEventSha256(record), participantId }
      }
      if (eventKind === 'heuristic') {
        const identity = parseHeuristicAttestationEventId(attestationEventId)
        if (!identity) return null
        if (identity.recordType === 'edit') {
          if (!heuristics) return null
          const edit = readHeuristicEdit(heuristics, identity.heuristicId, identity.eventId)
          return edit ? {
            eventSha256: await heuristicEditSha256(identity.heuristicId, edit),
            participantId: edit.authorId,
          } : null
        }
        if (identity.recordType === 'example') {
          const event = readHeuristicExampleEvent(
            discussions, identity.heuristicId, identity.exampleId, identity.eventId,
          )
          return event ? {
            eventSha256: await heuristicExampleEventSha256(event), participantId: event.participantId,
          } : null
        }
        const result = readHeuristicCheckResult(discussions, identity.heuristicId, identity.eventId)
        return result ? {
          eventSha256: await heuristicCheckResultSha256(result), participantId: result.authorId,
        } : null
      }
      if (eventKind === 'suggestion') {
        const identity = parseScenarioAttestationEventId(attestationEventId)
        if (!identity) return null
        const event = readSuggestionEvent(discussions, identity.scenarioId, identity.eventId)
        return event ? {
          eventSha256: await suggestionEventSha256(event),
          participantId: event.kind === 'proposal' ? event.authorId : event.reviewerId,
        } : null
      }
      if (eventKind === 'plugin-review') {
        const identity = parseScenarioAttestationEventId(attestationEventId)
        if (!identity) return null
        const event = readPluginReviewEvent(discussions, identity.scenarioId, identity.eventId)
        return event ? {
          eventSha256: await pluginReviewEventSha256(event),
          participantId: pluginReviewParticipantId(event),
        } : null
      }
      if (eventKind === 'adversarial-review') {
        const identity = parseAdversarialReviewAttestationEventId(attestationEventId)
        if (!identity) return null
        if (identity.recordType === 'archive') {
          const archive = await readAdversarialReviewArchive(discussions, identity.runId)
          return archive ? {
            eventSha256: await adversarialReviewArchiveEventSha256(archive),
            participantId: archive.createdBy.participantId,
          } : null
        }
        const event = readAdversarialReviewDecisionEvent(
          discussions, identity.runId, identity.eventId,
        )
        return event ? {
          eventSha256: await adversarialReviewDecisionEventSha256(event),
          participantId: event.participantId,
        } : null
      }
      if (eventKind === 'scenario') {
        if (!scenarios) return null
        const identity = parseScenarioEditAttestationEventId(attestationEventId)
        if (!identity) return null
        const edit = readScenarioEdit(scenarios, identity.scenarioId, identity.editId)
        return edit ? {
          eventSha256: await scenarioEditSha256(edit),
          participantId: edit.authorId,
        } : null
      }
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
  eventKind: 'scenario' | 'scenario-vote' | 'scenario-annotation' | 'scenario-label' |
    'policy-version' | 'scenario-turn' | 'adversarial-review' | 'plugin-review' | 'suggestion' | 'heuristic' | 'scenario-rerun',
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
    const { discussions, settings, versions, scenarios, heuristics } = getProjectSharedTypes(document)
    const inspection = await publishProjectResearchEventAttestation(
      settings,
      projectId,
      directory,
      researchEventAttestationResolver(discussions, settings, versions, scenarios, heuristics),
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

export async function attestHeuristicEditEvent(
  document: Y.Doc, projectId: string, heuristicId: string, edit: HeuristicEdit,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(document, projectId, 'heuristic',
    heuristicEditAttestationEventId(heuristicId, edit), edit.authorId,
    () => heuristicEditSha256(heuristicId, edit), dependencies)
}

export async function attestHeuristicExampleEvent(
  document: Y.Doc, projectId: string, event: HeuristicExampleEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(document, projectId, 'heuristic',
    heuristicExampleAttestationEventId(event), event.participantId,
    () => heuristicExampleEventSha256(event), dependencies)
}

export async function attestHeuristicCheckResultEvent(
  document: Y.Doc, projectId: string, result: HeuristicCheckResult,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(document, projectId, 'heuristic',
    heuristicCheckResultAttestationEventId(result), result.authorId,
    () => heuristicCheckResultSha256(result), dependencies)
}

/** Best-effort device attribution after one validated queue record has committed. */
export async function attestScenarioRerunResearchEvent(
  document: Y.Doc,
  projectId: string,
  record: ScenarioRerunResearchEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  const eventId = record.recordType === 'definition'
    ? scenarioRerunDefinitionAttestationEventId(record.definition)
    : record.recordType === 'control'
      ? scenarioRerunControlAttestationEventId(record.event)
      : record.recordType === 'item'
        ? scenarioRerunItemAttestationEventId(record.event)
        : scenarioEvaluationResultAttestationEventId(record.result)
  const participantId = record.recordType === 'definition' ? record.definition.createdBy
    : record.recordType === 'result' ? record.result.authorId : record.event.authorId
  return attestResearchEvent(
    document,
    projectId,
    'scenario-rerun',
    eventId,
    participantId,
    () => scenarioRerunResearchEventSha256(record),
    dependencies,
  )
}

/** Best-effort device attribution after an immutable suggestion proposal or decision commits. */
export async function attestSuggestionEvent(
  document: Y.Doc,
  projectId: string,
  event: SuggestionEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'suggestion',
    suggestionAttestationEventId(event),
    event.kind === 'proposal' ? event.authorId : event.reviewerId,
    () => suggestionEventSha256(event),
    dependencies,
  )
}

/** Best-effort device attribution after an immutable plugin proposal, decision, or application commits. */
export async function attestPluginReviewEvent(
  document: Y.Doc,
  projectId: string,
  event: PluginReviewEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'plugin-review',
    pluginReviewAttestationEventId(event),
    pluginReviewParticipantId(event),
    () => pluginReviewEventSha256(event),
    dependencies,
  )
}

/** Best-effort device attribution after an immutable adversarial archive has committed. */
export async function attestAdversarialReviewArchiveEvent(
  document: Y.Doc,
  projectId: string,
  archive: AdversarialReviewArchive,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'adversarial-review',
    adversarialReviewArchiveAttestationEventId(archive),
    archive.createdBy.participantId,
    () => adversarialReviewArchiveEventSha256(archive),
    dependencies,
  )
}

/** Best-effort device attribution after one immutable adversarial decision has committed. */
export async function attestAdversarialReviewDecisionEvent(
  document: Y.Doc,
  projectId: string,
  event: AdversarialReviewDecisionEvent,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'adversarial-review',
    adversarialReviewDecisionAttestationEventId(event),
    event.participantId,
    () => adversarialReviewDecisionEventSha256(event),
    dependencies,
  )
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

/** Best-effort device attribution after an immutable scenario create/edit/status event commits. */
export async function attestScenarioEditEvent(
  document: Y.Doc,
  projectId: string,
  scenarioId: string,
  edit: ScenarioEdit,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResearchEventAttributionResult> {
  return attestResearchEvent(
    document,
    projectId,
    'scenario',
    scenarioEditAttestationEventId(scenarioId, edit),
    edit.authorId,
    () => scenarioEditSha256(edit),
    dependencies,
  )
}

/** Product scenario path: validate identity, commit once, resolve the exact edit, then attest. */
export async function commitScenarioEditWithAttribution(
  document: Y.Doc,
  projectId: string,
  scenarioId: string,
  editId: string,
  commit: () => ResearchScenario,
  dependencies: ResearchEventAttributionDependencies = DEFAULT_DEPENDENCIES,
): Promise<AttributedScenarioEdit> {
  const shared = getProjectSharedTypes(document)
  if (shared.metadata.get('projectId') !== projectId) {
    throw new Error('Live collaboration document project identity does not match')
  }
  const scenario = commit()
  const edit = readScenarioEdit(shared.scenarios, scenarioId, editId)
  if (!edit) throw new Error('Scenario edit was not retained')
  return {
    scenario,
    edit,
    attribution: await attestScenarioEditEvent(
      document, projectId, scenarioId, edit, dependencies,
    ),
  }
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
