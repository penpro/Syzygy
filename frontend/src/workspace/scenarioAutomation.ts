import type * as Y from 'yjs'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { addScenarioTurn, createScenario, inspectScenarioGraph, readScenario, reconcileScenarioTurn, type ScenarioStatus, type ScenarioTurnRole, updateScenarioTurn } from './scenarioModel'
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

export interface ReconcileAutomationScenarioTurnInput extends MutateAutomationScenarioTurnInput {
  expectedCurrentEditId: string
  expectedTipEditIds: string[]
}

export interface ReadAutomationScenarioInput {
  scenarioId: string
}

export interface ReadAutomationScenarioTurnRevisionInput extends ReadAutomationScenarioInput {
  turnId: string
  revisionEditId?: string
  revisionIndex?: number
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

function readableScenario(doc: Y.Doc, expectedProjectId: string, scenarioId: string) {
  const { metadata, scenarios } = getProjectSharedTypes(doc)
  if (metadata.get('projectId') !== expectedProjectId) throw new Error('Live collaboration document project identity does not match')
  const integrity = inspectScenarioGraph(scenarios)
  if (!integrity.healthy) throw new Error('Scenario data failed integrity checks')
  const scenario = readScenario(scenarios, scenarioId)
  if (!scenario) throw new Error('Scenario not found or invalid')
  return scenario
}

export function readAutomationScenario(doc: Y.Doc, expectedProjectId: string, input: ReadAutomationScenarioInput) {
  const scenario = readableScenario(doc, expectedProjectId, input.scenarioId)
  return {
    scenario: {
      id: scenario.id, title: scenario.title, background: scenario.background, status: scenario.status,
      parentScenarioId: scenario.parentScenarioId, createdBy: scenario.createdBy, createdAt: scenario.createdAt,
      editCount: scenario.edits.length, turnCount: scenario.turns.length,
    },
    turns: scenario.turns.map((turn) => ({
      id: turn.id, role: turn.role, createdBy: turn.createdBy, createdAt: turn.createdAt,
      revisionCount: turn.revisions.length, currentEditId: turn.headEditId,
      tipEditIds: [...turn.tipEditIds], requiresReconciliation: turn.tipEditIds.length > 1,
    })),
    researchRevision: projectStateFingerprint(doc),
  }
}

export function readAutomationScenarioTurnRevision(
  doc: Y.Doc, expectedProjectId: string, input: ReadAutomationScenarioTurnRevisionInput,
) {
  const scenario = readableScenario(doc, expectedProjectId, input.scenarioId)
  const turn = scenario.turns.find((candidate) => candidate.id === input.turnId)
  if (!turn) throw new Error('Scenario turn not found or invalid')
  if (input.revisionEditId !== undefined && input.revisionIndex !== undefined) {
    throw new Error('Choose revisionEditId or revisionIndex, not both')
  }
  if (input.revisionIndex !== undefined && (!Number.isInteger(input.revisionIndex) || input.revisionIndex < 0)) {
    throw new Error('Scenario turn revision index is invalid')
  }
  const revision = input.revisionEditId !== undefined
    ? turn.revisions.find((candidate) => candidate.editId === input.revisionEditId)
    : input.revisionIndex !== undefined
      ? turn.revisions[input.revisionIndex]
      : turn.revisions.find((candidate) => candidate.editId === turn.headEditId)
  if (!revision) throw new Error('Scenario turn revision not found')
  const current = turn.revisions.find((candidate) => candidate.editId === turn.headEditId)!
  return {
    scenario: {
      id: scenario.id, title: scenario.title, status: scenario.status,
      parentScenarioId: scenario.parentScenarioId, createdBy: scenario.createdBy,
      createdAt: scenario.createdAt, turnCount: scenario.turns.length,
    },
    turn: {
      id: turn.id, createdBy: turn.createdBy, createdAt: turn.createdAt,
      revisionCount: turn.revisions.length, currentEditId: current.editId,
      tipEditIds: [...turn.tipEditIds], requiresReconciliation: turn.tipEditIds.length > 1,
    },
    revision: { ...revision }, revisionIndex: turn.revisions.indexOf(revision),
    currentEditId: current.editId,
    researchRevision: projectStateFingerprint(doc),
  }
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
  const current = readScenario(scenarios, input.scenarioId)
  const currentTurn = current?.turns.find((turn) => turn.id === input.turnId)
  const expectedCurrentEditId = currentTurn?.headEditId
  if (!expectedCurrentEditId) throw new Error('Scenario turn not found or invalid')
  const scenario = updateScenarioTurn(scenarios, {
    scenarioId: input.scenarioId, turnId: input.turnId, role: input.role, content: input.content,
    authorId: input.participantId, timestamp: input.timestamp, editId: input.editId, expectedCurrentEditId,
  })
  const turn = scenario.turns.find((candidate) => candidate.id === input.turnId)!
  return { scenario, turn, researchRevision: projectStateFingerprint(doc) }
}

export function reconcileAutomationScenarioTurn(
  doc: Y.Doc, expectedProjectId: string, input: ReconcileAutomationScenarioTurnInput,
) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const scenario = reconcileScenarioTurn(scenarios, {
    scenarioId: input.scenarioId, turnId: input.turnId, role: input.role, content: input.content,
    authorId: input.participantId, timestamp: input.timestamp, editId: input.editId,
    expectedCurrentEditId: input.expectedCurrentEditId, expectedTipEditIds: input.expectedTipEditIds,
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
  const event = summary.history.find((candidate) =>
    candidate.scenarioId === input.scenarioId && candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario vote event was not retained')
  return { summary, event, researchRevision: projectStateFingerprint(doc) }
}

export function createAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: CreateAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = createScenarioAnnotation(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    turnId: input.turnId, kind: input.kind, body: input.body, authorId: input.participantId,
    displayName: input.displayName, timestamp: input.timestamp,
  })
  const event = annotation.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario annotation event was not retained')
  return { annotation, event, researchRevision: projectStateFingerprint(doc) }
}

export function updateAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: UpdateAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = updateScenarioAnnotation(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    expectedCurrentEventId: input.expectedCurrentEventId, body: input.body, authorId: input.participantId,
    displayName: input.displayName, timestamp: input.timestamp,
  })
  const event = annotation.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario annotation event was not retained')
  return { annotation, event, researchRevision: projectStateFingerprint(doc) }
}

export function resolveAutomationScenarioAnnotation(doc: Y.Doc, expectedProjectId: string, input: ResolveAutomationScenarioAnnotationInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { discussions } = getProjectSharedTypes(doc)
  const annotation = setScenarioAnnotationResolution(discussions, scenarios, {
    annotationId: input.annotationId, eventId: input.eventId, scenarioId: input.scenarioId,
    expectedCurrentEventId: input.expectedCurrentEventId, resolved: input.resolved,
    authorId: input.participantId, displayName: input.displayName, timestamp: input.timestamp,
  })
  const event = annotation.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario annotation event was not retained')
  return { annotation, event, researchRevision: projectStateFingerprint(doc) }
}

export function createAutomationScenarioLabel(doc: Y.Doc, expectedProjectId: string, input: CreateAutomationScenarioLabelInput) {
  guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const label = createScenarioLabel(settings, {
    labelId: input.labelId, eventId: input.eventId, name: input.name,
    authorId: input.participantId, timestamp: input.timestamp,
  })
  const event = label.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario label event was not retained')
  return { label, event, researchRevision: projectStateFingerprint(doc) }
}

export function renameAutomationScenarioLabel(doc: Y.Doc, expectedProjectId: string, input: RenameAutomationScenarioLabelInput) {
  guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const label = renameScenarioLabel(settings, {
    labelId: input.labelId, eventId: input.eventId, expectedCurrentEventId: input.expectedCurrentEventId,
    name: input.name, authorId: input.participantId, timestamp: input.timestamp,
  })
  const event = label.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario label event was not retained')
  return { label, event, researchRevision: projectStateFingerprint(doc) }
}

export function setAutomationScenarioLabelAssignment(doc: Y.Doc, expectedProjectId: string, input: SetAutomationScenarioLabelAssignmentInput) {
  const scenarios = guardedScenarios(doc, expectedProjectId, input.expectedResearchRevision)
  const { settings } = getProjectSharedTypes(doc)
  const assignment = setScenarioLabelAssignment(settings, scenarios, {
    scenarioId: input.scenarioId, labelId: input.labelId, eventId: input.eventId,
    expectedCurrentEventId: input.expectedCurrentEventId, assigned: input.assigned,
    authorId: input.participantId, timestamp: input.timestamp,
  })
  const event = assignment.events.find((candidate) => candidate.eventId === input.eventId)
  if (!event) throw new Error('Scenario label assignment event was not retained')
  return { assignment, event, researchRevision: projectStateFingerprint(doc) }
}
