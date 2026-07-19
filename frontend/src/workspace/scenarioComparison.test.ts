import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import scenarioComparisonSchema from '../../../docs/schemas/syzygy-scenario-comparison-v1.schema.json'
import { commitPolicyVersion, type PolicyVersion } from './policyVersionModel'
import { createProjectDocument, getProjectSharedTypes } from './projectModel'
import {
  buildScenarioEvaluationRequest,
  SCENARIO_EVALUATION_CONTRACT_VERSION,
  SCENARIO_EVALUATION_PROMPT_VERSION,
  type ScenarioEvaluationOutput,
} from './scenarioEvaluation'
import {
  countComparableScenarioRerunPairs,
  createScenarioComparison,
  decodeScenarioComparison,
  exportScenarioComparison,
  SCENARIO_COMPARISON_FORMAT,
  SCENARIO_COMPARISON_MAX_FILE_BYTES,
  SCENARIO_COMPARISON_NONDETERMINISM_LABEL,
} from './scenarioComparison'
import {
  beginScenarioRerunItem,
  completeScenarioRerunItem,
  controlScenarioRerunJob,
  createScenarioRerunJob,
  readScenarioRerunJob,
  type ScenarioRerunJob,
} from './scenarioRerunQueue'
import { createScenario, readScenario, updateScenario, type ResearchScenario } from './scenarioModel'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'comparison-project', documentId: 'comparison-document', timestamp: 1 })
const validatePublicSchema = new Ajv2020({ allErrors: true, strict: true }).compile(scenarioComparisonSchema)

async function fixture() {
  const doc = createProjectDocument(manifest)
  const shared = getProjectSharedTypes(doc)
  const alpha = createScenario(shared.scenarios, {
    id: 'alpha-case', title: 'Alpha case', background: 'A resident requests an appeal.', status: 'ready',
    authorId: 'alice', timestamp: 1, editId: 'create-alpha',
    turns: [{ id: 'alpha-question', role: 'user', content: 'What happens next?', editId: 'create-alpha-turn' }],
  })
  const beta = createScenario(shared.scenarios, {
    id: 'beta-case', title: 'Beta case', background: 'A deadline was missed.', status: 'ready',
    authorId: 'alice', timestamp: 2, editId: 'create-beta',
  })
  const baselineVersion = await commitPolicyVersion(shared.versions, shared.metadata, {
    projectId: manifest.id, expectedHeadVersionId: null,
    blocks: [{ kind: 'policy', policyId: 'appeal-rule', status: 'review', text: 'Appeals are accepted.' }],
    scenarioIds: [alpha.id, beta.id], participantId: 'alice', displayName: 'Alice', createdAt: 3,
  })
  const candidateVersion = await commitPolicyVersion(shared.versions, shared.metadata, {
    projectId: manifest.id, expectedHeadVersionId: baselineVersion.versionId,
    blocks: [{ kind: 'policy', policyId: 'appeal-rule', status: 'approved', text: 'Appeals are accepted within 30 days.' }],
    scenarioIds: [alpha.id, beta.id], participantId: 'bob', displayName: 'Bob', createdAt: 4,
    note: 'Adds a deadline.',
  })
  const createJob = (jobId: string, version: PolicyVersion, authorId: string, scenarios: ResearchScenario[]) =>
    createScenarioRerunJob(shared.settings, {
      jobId, project: manifest, policyVersion: version, providerId: 'local', requestedModelId: 'fixture-model',
      items: scenarios.map((scenario, index) => ({
        itemId: `${jobId}-item-${index}`, scenario,
        runIdBase: `${jobId}-run-${index}`, resultId: `${jobId}-result-${index}`,
      })),
      authorId, authorDisplayName: authorId === 'alice' ? 'Alice' : 'Bob', timestamp: jobId === 'baseline-job' ? 5 : 6,
    })
  createJob('baseline-job', baselineVersion, 'alice', [beta, alpha])
  createJob('candidate-job', candidateVersion, 'bob', [alpha, beta])

  const completeJob = async (jobId: string, version: PolicyVersion, authorId: string,
    outcomes: Record<string, ScenarioEvaluationOutput['outcome']>): Promise<ScenarioRerunJob> => {
    let job = readScenarioRerunJob(shared.settings, shared.discussions, jobId)!
    controlScenarioRerunJob(shared.settings, shared.discussions, {
      eventId: `${jobId}-start`, jobId, action: 'start', parentEventId: null,
      authorId, timestamp: 10,
    })
    for (let index = 0; index < job.items.length; index += 1) {
      const item = job.items[index]
      beginScenarioRerunItem(shared.settings, shared.discussions, {
        eventId: `${jobId}-begin-${index}`, jobId, itemId: item.definition.itemId,
        expectedCurrentEventId: null, attempt: 1, authorId, timestamp: 11 + index,
      })
      const request = buildScenarioEvaluationRequest({
        jobId, itemId: item.definition.itemId, attempt: 1, runId: `${item.definition.runIdBase}-a1`,
        providerId: 'local', requestedModelId: 'fixture-model', project: manifest, policyVersion: version,
        scenario: readScenario(shared.scenarios, item.definition.scenarioId)!,
      })
      const output: ScenarioEvaluationOutput = {
        contractVersion: SCENARIO_EVALUATION_CONTRACT_VERSION,
        promptVersion: SCENARIO_EVALUATION_PROMPT_VERSION,
        jobId, itemId: item.definition.itemId, attempt: 1, runId: request.runId,
        providerId: 'local', requestedModelId: 'fixture-model', executedModelId: 'fixture-model',
        outcome: outcomes[item.definition.scenarioId],
        response: `${jobId} response for ${item.definition.scenarioId}`,
        rationale: `${jobId} rationale for ${item.definition.scenarioId}`,
        uncertainty: `${jobId} uncertainty for ${item.definition.scenarioId}`,
      }
      job = await completeScenarioRerunItem(doc, request, output, {
        eventId: `${jobId}-complete-${index}`, resultId: item.definition.resultId,
        authorId, authorDisplayName: authorId === 'alice' ? 'Alice' : 'Bob', timestamp: 20 + index,
      })
    }
    return job
  }
  const baselineJob = await completeJob('baseline-job', baselineVersion, 'alice', {
    'alpha-case': 'handled', 'beta-case': 'uncertain',
  })
  const candidateJob = await completeJob('candidate-job', candidateVersion, 'bob', {
    'alpha-case': 'unhandled', 'beta-case': 'uncertain',
  })
  return { doc, shared, alpha, beta, baselineVersion, candidateVersion, baselineJob, candidateJob }
}

describe('stable scenario baseline comparison export', () => {
  it('builds a deterministic side-by-side matrix with exact reproducibility metadata', async () => {
    const value = await fixture()
    const first = await createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: value.candidateJob,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })
    const second = await createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: value.candidateJob,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      format: SCENARIO_COMPARISON_FORMAT,
      projectId: manifest.id,
      documentId: manifest.documentId,
      summary: {
        scenarioCount: 2, unchangedOutcomeCount: 1, changedOutcomeCount: 1,
        outcomeMatrix: {
          handled: { handled: 0, unhandled: 1, uncertain: 0 },
          unhandled: { handled: 0, unhandled: 0, uncertain: 0 },
          uncertain: { handled: 0, unhandled: 0, uncertain: 1 },
        },
      },
    })
    expect(first.rows.map(({ scenarioId }) => scenarioId)).toEqual(['alpha-case', 'beta-case'])
    expect(first.baseline).toMatchObject({ modelHash: null, sampler: null, seed: null,
      nondeterminismLabel: SCENARIO_COMPARISON_NONDETERMINISM_LABEL })
    expect(first.baseline.policyVersion.policy.blocks[0].text).toBe('Appeals are accepted.')
    expect(first.candidate.policyVersion.note).toBe('Adds a deadline.')
    expect(first.rows[0].baseline.response).toContain('baseline-job response')
    expect(first.rows[0].candidate.response).toContain('candidate-job response')
  })

  it('round-trips an independently verifiable export and rejects tampering or ambient fields', async () => {
    const value = await fixture()
    const artifact = await createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: value.candidateJob,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })
    const exported = await exportScenarioComparison(artifact)
    expect(validatePublicSchema(JSON.parse(exported)), JSON.stringify(validatePublicSchema.errors)).toBe(true)
    expect(await decodeScenarioComparison(exported)).toEqual(artifact)

    const tampered = JSON.parse(exported)
    tampered.rows[0].candidate.response = 'Tampered response'
    await expect(decodeScenarioComparison(JSON.stringify(tampered))).rejects.toThrow('checksum')

    const ambient = JSON.parse(exported)
    ambient.rows[0].command = 'write_project'
    await expect(decodeScenarioComparison(JSON.stringify(ambient))).rejects.toThrow('row is invalid')

    const wrongPolicy = JSON.parse(exported)
    wrongPolicy.baseline.policyVersion.policy.blocks[0].text = 'Tampered policy'
    await expect(decodeScenarioComparison(JSON.stringify(wrongPolicy))).rejects.toThrow('policy snapshot checksum')

    const noncanonicalPolicy = JSON.parse(exported)
    noncanonicalPolicy.baseline.policyVersion.author.displayName = 'Alice '
    await expect(decodeScenarioComparison(JSON.stringify(noncanonicalPolicy))).rejects.toThrow('policy snapshot is invalid')

    const duplicatePolicyId = JSON.parse(exported)
    duplicatePolicyId.baseline.policyVersion.policy.blocks.push({
      ...duplicatePolicyId.baseline.policyVersion.policy.blocks[0], text: 'Duplicate identity',
    })
    await expect(decodeScenarioComparison(JSON.stringify(duplicatePolicyId))).rejects.toThrow('policy snapshot is invalid')

    const noncanonical = JSON.parse(exported)
    noncanonical.rows.reverse()
    await expect(decodeScenarioComparison(JSON.stringify(noncanonical))).rejects.toThrow('canonically ordered')

    const substitutedRoute = JSON.parse(exported)
    substitutedRoute.baseline.requestedModelId = 'substituted-model'
    await expect(decodeScenarioComparison(JSON.stringify(substitutedRoute))).rejects.toThrow('exact source')

    const inconsistentModels = JSON.parse(exported)
    inconsistentModels.candidate.executedModelIds = ['ambient-model', 'fixture-model']
    await expect(decodeScenarioComparison(JSON.stringify(inconsistentModels))).rejects.toThrow('executed-model provenance')

    const inconsistentSummary = JSON.parse(exported)
    inconsistentSummary.summary.changedOutcomeCount = 2
    await expect(decodeScenarioComparison(JSON.stringify(inconsistentSummary))).rejects.toThrow('summary does not match')

    const futureSchema = JSON.parse(exported)
    futureSchema.schemaVersion = 2
    await expect(decodeScenarioComparison(JSON.stringify(futureSchema))).rejects.toThrow('envelope is invalid')

    await expect(decodeScenarioComparison(' '.repeat(SCENARIO_COMPARISON_MAX_FILE_BYTES + 1)))
      .rejects.toThrow('exceeds the size limit')
  })

  it('fails closed for incomplete, self, mismatched-set, and changed-revision comparisons', async () => {
    const value = await fixture()
    await expect(createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: value.baselineJob,
      baselineVersion: value.baselineVersion, candidateVersion: value.baselineVersion,
    })).rejects.toThrow('two different')

    const incomplete = createScenarioRerunJob(value.shared.settings, {
      jobId: 'incomplete-job', project: manifest, policyVersion: value.candidateVersion,
      providerId: 'local', requestedModelId: 'fixture-model',
      items: [{ itemId: 'incomplete-item', scenario: value.alpha,
        runIdBase: 'incomplete-run', resultId: 'incomplete-result' }],
      authorId: 'bob', authorDisplayName: 'Bob', timestamp: 30,
    })
    await expect(createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: incomplete,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })).rejects.toThrow('not complete')

    const missing = structuredClone(value.candidateJob)
    missing.items.pop()
    await expect(createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: missing,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })).rejects.toThrow('same scenario IDs')

    const changed = structuredClone(value.candidateJob)
    changed.items[0].definition.scenarioRevision = `${changed.items[0].definition.scenarioRevision} changed`
    await expect(createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: changed,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })).rejects.toThrow('changed between')

    const oversizedRevision = structuredClone(value.candidateJob)
    oversizedRevision.items[0].definition.scenarioRevision = 'x'.repeat(200_001)
    await expect(createScenarioComparison({
      baselineJob: value.baselineJob, candidateJob: oversizedRevision,
      baselineVersion: value.baselineVersion, candidateVersion: value.candidateVersion,
    })).rejects.toThrow('revision exceeds comparison bounds')
  })

  it('counts only completed exact-revision pairs for content-free inspection', async () => {
    const value = await fixture()
    expect(countComparableScenarioRerunPairs([value.baselineJob, value.candidateJob])).toBe(1)
    const changed = structuredClone(value.candidateJob)
    changed.items[0].definition.scenarioRevision = 'different revision'
    expect(countComparableScenarioRerunPairs([value.baselineJob, changed])).toBe(0)
    const incomplete = structuredClone(value.candidateJob)
    incomplete.status = 'paused'
    expect(countComparableScenarioRerunPairs([value.baselineJob, incomplete])).toBe(0)
  })
})
