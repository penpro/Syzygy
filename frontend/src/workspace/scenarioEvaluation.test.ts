import { describe, expect, it, vi } from 'vitest'
import type { PolicyVersion } from './policyVersionModel'
import {
  buildScenarioEvaluationRequest,
  runScenarioEvaluation,
  SCENARIO_EVALUATION_CONTRACT_VERSION,
  SCENARIO_EVALUATION_PROMPT_VERSION,
  MAX_SCENARIO_EVALUATION_OUTPUT,
  validateScenarioEvaluationOutput,
  type ScenarioEvaluationAdapter,
  type ScenarioEvaluationOutput,
} from './scenarioEvaluation'
import type { ResearchScenario } from './scenarioModel'
import { createProjectManifest } from './schema'

const project = createProjectManifest({ id: 'evaluation-project', documentId: 'evaluation-document', timestamp: 1 })
const policyVersion: PolicyVersion = {
  schemaVersion: 1,
  versionId: 'a'.repeat(64), projectId: project.id, parentVersionId: null,
  policy: { format: 'syzygy-semantic-blocks-v1', blocks: [
    { kind: 'heading1', text: 'Appeals' },
    { kind: 'policy', policyId: 'appeal-rule', status: 'approved', text: 'Every denial receives a written appeal path.' },
    { kind: 'suggestion', suggestionId: 'ignored-card', text: '' },
  ] },
  scenarioIds: [], author: { participantId: 'alice', displayName: 'Alice' }, createdAt: 1, note: null,
}
const scenario: ResearchScenario = {
  schemaVersion: 1, id: 'denial-scenario', title: 'Service denial', background: 'A resident is denied service.',
  status: 'ready', parentScenarioId: null, createdBy: 'alice', createdAt: 1,
  turns: [{ id: 'turn-1', createdBy: 'alice', createdAt: 1, role: 'user', content: 'How can I appeal?', revisions: [{ editId: 'turn-edit', authorId: 'alice', timestamp: 1, role: 'user', content: 'How can I appeal?' }] }],
  edits: [{ editId: 'scenario-create', authorId: 'alice', timestamp: 1, fields: ['title'], changes: { title: 'Service denial' } }],
}

const request = () => buildScenarioEvaluationRequest({
  jobId: 'job-1', itemId: 'item-1', attempt: 1, runId: 'run-1', providerId: 'local',
  requestedModelId: 'local-model', project, policyVersion, scenario,
})
const output = (): ScenarioEvaluationOutput => ({
  contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
  promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
  jobId: 'job-1', itemId: 'item-1', attempt: 1, runId: 'run-1', providerId: 'local',
  requestedModelId: 'local-model', executedModelId: 'local-model', outcome: 'handled',
  response: 'The resident receives written appeal instructions.',
  rationale: 'The approved rule directly covers a denial.',
  uncertainty: 'The policy does not specify an appeal deadline.',
})

describe('version-bound scenario evaluation contract', () => {
  it('freezes one immutable policy version and exact scenario revision without suggestion cards', () => {
    const built = request()
    expect(built.policyVersionId).toBe('a'.repeat(64))
    expect(built.policyText).toContain('[Policy appeal-rule · approved]')
    expect(built.policyText).not.toContain('ignored-card')
    expect(built.scenarioRevision).toContain('scenario-create')
    expect(built.scenarioTurns).toEqual([{ role: 'user', content: 'How can I appeal?' }])
  })

  it('rejects ambient fields, route substitution, oversized bodies, and invalid semantic values', () => {
    expect(validateScenarioEvaluationOutput(request(), output())).toEqual(output())
    expect(() => validateScenarioEvaluationOutput(request(), { ...output(), itemId: 'other' })).toThrow('route or result schema')
    expect(() => validateScenarioEvaluationOutput(request(), { ...output(), providerId: 'openai' })).toThrow('route or result schema')
    expect(() => validateScenarioEvaluationOutput(request(), { ...output(), response: 'x'.repeat(MAX_SCENARIO_EVALUATION_OUTPUT + 1) })).toThrow('route or result schema')
    expect(() => validateScenarioEvaluationOutput(request(), { ...output(), uncertainty: '' })).toThrow('route or result schema')
    expect(() => validateScenarioEvaluationOutput(request(), { ...output(), command: 'delete-files' })).toThrow('invalid response envelope')
  })

  it('honors route binding and cancellation before provider work', async () => {
    const wrong: ScenarioEvaluationAdapter = { providerId: 'openai', evaluate: vi.fn() }
    await expect(runScenarioEvaluation(wrong, request(), new AbortController().signal)).rejects.toThrow('route mismatch')
    expect(wrong.evaluate).not.toHaveBeenCalled()
    const controller = new AbortController(); controller.abort()
    const local: ScenarioEvaluationAdapter = { providerId: 'local', evaluate: vi.fn() }
    await expect(runScenarioEvaluation(local, request(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(local.evaluate).not.toHaveBeenCalled()
  })

  it('rejects cross-project versions and invalid attempts before execution', () => {
    expect(() => buildScenarioEvaluationRequest({
      jobId: 'job-1', itemId: 'item-1', attempt: 1, runId: 'run-1', providerId: 'local',
      requestedModelId: 'local-model', project, policyVersion: { ...policyVersion, projectId: 'other-project' }, scenario,
    })).toThrow('another project')
    expect(() => buildScenarioEvaluationRequest({
      jobId: 'job-1', itemId: 'item-1', attempt: 4, runId: 'run-1', providerId: 'local',
      requestedModelId: 'local-model', project, policyVersion, scenario,
    })).toThrow('attempt')
  })
})
