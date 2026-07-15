import type * as Y from 'yjs'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { addScenarioTurn, createScenario, type ScenarioStatus, type ScenarioTurnRole, updateScenarioTurn } from './scenarioModel'
import { castScenarioVote, type ScenarioVoteChoice } from './scenarioVoteModel'
import {
  createScenarioAnnotation,
  setScenarioAnnotationResolution,
  type ScenarioAnnotationKind,
  updateScenarioAnnotation,
} from './scenarioAnnotationModel'
import {
  createScenarioLabel,
  renameScenarioLabel,
  setScenarioLabelAssignment,
} from './scenarioLabelModel'

export interface CreateAutomationScenarioInput {
  expectedResearchRevision: string
  scenarioId: string
  title: string
  background: string
  status?: ScenarioStatus
  parentScenarioId?: string | null
  participantId: string
  createdAt: number
  editId: string
}

export interface MutateAutomationScenarioTurnInput {
  expectedResearchRevision: string
  scenarioId: string
  turnId: string
  role: ScenarioTurnRole
  content: string
  participantId: string
  timestamp: number
  editId: string
}

export interface CastAutomationScenarioVoteInput {
  expectedResearchRevision: string
  scenarioId: string
  participantId: string
  displayName: string
  choice: ScenarioVoteChoice
  timestamp: number
  eventId: string
}

export interface CreateAutomationScenarioAnnotationInput {
  expectedResearchRevision: string
  annotationId: string
  scenarioId: string
  turnId?: string | null
  kind: ScenarioAnnotationKind
  body: string
  participantId: string
  displayName: string
  timestamp: number
  eventId: string
}

export interface UpdateAutomationScenarioAnnotationInput {
  expectedResearchRevision: string
  annotationId: string
  scenarioId: string
  expectedCurrentEventId: string
  body: string
  participantId: string
  displayName: string
  timestamp: number
  eventId: string
}

export interface ResolveAutomationScenarioAnnotationInput {
  expectedResearchRevision: string
  annotationId: string
  scenarioId: string
  expectedCurrentEventId: string
  resolved: boolean
  participantId: string
  displayName: string
  timestamp: number
  eventId: string
}

export interface CreateAutomationScenarioLabelInput {
  expectedResearchRevision: string
  labelId: string
  name: string
  participantId: string
  timestamp: number
  eventId: string
}

export interface RenameAutomationScenarioLabelInput extends CreateAutomationScenarioLabelInput {
  expectedCurrentEventId: string
}

export interface SetAutomationScenarioLabelAssignmentInput {
  expectedResearchRevision: string
  scenarioId: string
  labelId: string
  expectedCurrentEventId: string | null
  assigned: boolean
  participantId: string
  timestamp: number
  eventId: string
}

function guardedScenarios(doc: Y.Doc, expectedProjectId: string, expectedResearchRevision: string) {
  const { metadata, scenarios } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== expectedProjectId) throw new Error('Live collaboration document project identity does not match')
  if (projectStateFingerprint(doc) !== expectedResearchRevision) throw new Error('Research state revision conflict')
  return scenarios
}

export function createAutomationScenario(doc: Y.Doc, expectedProjectId: string, input: CreateAutomationScenarioInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const scenario = createScenario(scenarios, {
    id: input.scenarioId,
    title: input.title,
    background: input.background,
    status: input.status,
    parentScenarioId: input.parentScenarioId,
    authorId: input.participantId,
    timestamp: input.createdAt,
    editId: input.editId,
  })
  return { scenario, researchRevision: projectStateFingerprint(doc) }
}

export function addAutomationScenarioTurn(doc: Y.Doc, expectedProjectId: string, input: MutateAutomationScenarioTurnInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const scenario = addScenarioTurn(scenarios, {
    scenarioId: input.scenarioId, turnId: input.turnId, role: input.role, content: input.content,
    authorId: input.participantId, timestamp: input.timestamp, editId: input.editId,
  })
  const turn = scenario.turns.find((candidate) => candidate.id === input.turnId)!
  return { scenario, turn, researchRevision: projectStateFingerprint(doc) }
}

export function reviseAutomationScenarioTurn(doc: Y.Doc, expectedProjectId: string, input: MutateAutomationScenarioTurnInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const scenario = updateScenarioTurn(scenarios, {
    scenarioId: input.scenarioId, turnId: input.turnId, role: input.role, content: input.content,
    authorId: input.participantId, timestamp: input.timestamp, editId: input.editId,
  })
  const turn = scenario.turns.find((candidate) => candidate.id === input.turnId)!
  return { scenario, turn, researchRevision: projectStateFingerprint(doc) }
}

export function castAutomationScenarioVote(doc: Y.Doc, expectedProjectId: string, input: CastAutomationScenarioVoteInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const summary = castScenarioVote(discussions, scenarios, {
    scenarioId: input.scenarioId, participantId: input.participantId, displayName: input.displayName,
    choice: input.choice, timestamp: input.timestamp, eventId: input.eventId,
  })
  return { summary, researchRevision: projectStateFingerprint(doc) }
}

export function createAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: CreateAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = createScenarioAnnotation(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    turnId: input.turnId, kind: input.kind, body: input.body, authorId: input.participantId,
    displayName: input.displayName, timestamp: input.timestamp,
  })
  return { annotation, researchRevision: projectStateFingerprint(doc) }
}

export function updateAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: UpdateAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = updateScenarioAnnotation(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    expectedCurrentEventId: input.expectedCurrentEventId, body: input.body, authorId: input.participantId,
    displayName: input.displayName, timestamp: input.timestamp,
  })
  return { annotation, researchRevision: projectStateFingerprint(doc) }
}

export function resolveAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: ResolveAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = setScenarioAnnotationResolution(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    expectedCurrentEventId: input.expectedCurrentEventId, resolved: input.resolved,
    authorId: input.participantId, displayName: input.displayName, timestamp: input.timestamp,
  })
  return { annotation, researchRevision: projectStateFingerprint(doc) }
}

export function createAutomationScenarioLabel(doc: Y.Doc, expectedProjectId: string, input: CreateAutomationScenarioLabelInput) {
  guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const label = createScenarioLabel(settings, {
    labelId: input.labelId, eventId: input.eventId, name: input.name,
    authorId: input.participantId, timestamp: input.timestamp,
  })
  return { label, researchRevision: projectStateFingerprint(doc) }
}

export function renameAutomationScenarioLabel(doc: Y.Doc, expectedProjectId: string, input: RenameAutomationScenarioLabelInput) {
  guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const label = renameScenarioLabel(settings, {
    labelId: input.labelId, eventId: input.eventId, expectedCurrentEventId: input.expectedCurrentEventId,
    name: input.name, authorId: input.participantId, timestamp: input.timestamp,
  })
  return { label, researchRevision: projectStateFingerprint(doc) }
}

export function setAutomationScenarioLabelAssignment(doc: Y.Doc, expectedProjectId: string, input: SetAutomationScenarioLabelAssignmentInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const assignment = setScenarioLabelAssignment(settings, scenarios, {
    scenarioId: input.scenarioId, labelId: input.labelId, eventId: input.eventId,
    expectedCurrentEventId: input.expectedCurrentEventId, assigned: input.assigned,
    authorId: input.participantId, timestamp: input.timestamp,
  })
  return { assignment, researchRevision: projectStateFingerprint(doc) }
}
