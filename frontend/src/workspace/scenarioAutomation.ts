import type * as Y from 'yjs'
import { getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { addScenarioTurn, createScenario, type ScenarioStatus, type ScenarioTurnRole, updateScenarioTurn } from './scenarioModel'

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
