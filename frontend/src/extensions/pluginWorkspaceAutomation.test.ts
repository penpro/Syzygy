import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { registerAutomationEditorController } from '../workspace/editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from '../workspace/projectModel'
import { PluginPackageRegistry } from './pluginPackageRegistry'
import { loadZeroAuthorityPluginPackage, ZeroAuthorityPluginExecutor } from './pluginExecution'
import { createPluginReview } from './pluginReviewModel'
import {
  decidePluginReviewForProject,
  inspectPluginWorkspace,
  runLoadedPluginForProject,
} from './pluginWorkspaceAutomation'

const limits = {
  maxComponentBytes: 8 * 1024 * 1024, maxEnvelopeBytes: 1024 * 1024,
  maxLinearMemoryBytes: 32 * 1024 * 1024, maxSources: 200, maxProposals: 32,
  executionFuel: 50_000_000, executionDeadlineMs: 2_000, ambientImportsLinked: false as const,
}

let unregister = () => {}
beforeEach(() => {
  unregister = registerAutomationEditorController({
    projectId: 'project-1',
    read: () => ({ projectId: 'project-1', revision: 'revision-1', text: 'Secret draft', blocks: [], scenarioIds: [] }),
    replace: () => { throw new Error('must not replace') },
    replaceBlocks: () => { throw new Error('must not replace') },
    append: () => { throw new Error('must not append') },
  })
})
afterEach(() => unregister())

async function fixture() {
  const packages = new PluginPackageRegistry()
  const plugin = await loadZeroAuthorityPluginPackage({
    schemaVersion: 1,
    id: 'org.example.fixture', name: 'Fixture', version: '1.0.0', description: 'Fixture',
    runtime: { kind: 'wasi-component', component: 'fixture.component', world: 'syzygy:research/plugin@1.0.0' },
    permissions: { capabilities: ['project.read', 'project.propose'], networkDomains: [], modelProviders: [] },
    contributions: [{ kind: 'evaluator', id: 'review', title: 'Review', description: 'Review' }],
  }, { name: 'fixture.component', bytes: new Uint8Array([1]) })
  packages.register(plugin)
  const executor = new ZeroAuthorityPluginExecutor(async (_bytes, invocation) => ({
    runtimeVersion: 1,
    world: 'syzygy:research/plugin@1.0.0',
    output: { kind: 'proposals', proposals: [{
      proposalVersion: 1, proposalId: 'proposal-1', pluginId: invocation.pluginId,
      projectId: invocation.project!.projectId, expectedRevision: invocation.project!.revision,
      summary: 'Review secret', content: 'Proposed secret content', operation: 'append',
    }] },
    limits,
  }))
  return { packages, plugin, executor }
}

describe('plugin workspace automation', () => {
  it('publishes a runtime proposal into shared review without editing the draft', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const { packages, plugin, executor } = await fixture()
    const publication = await runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'revision-1',
      participantId: 'runner-1', displayName: 'Runner',
    }, { packages, executor, id: (() => { let value = 0; return () => `id-${++value}` })(), clock: () => 10 })
    expect(publication.reviews).toHaveLength(1)
    expect(publication.reviews[0]).toMatchObject({ status: 'pending', proposal: { content: 'Proposed secret content' } })
    expect(inspectPluginWorkspace(doc, packages)).toMatchObject({
      contentOmitted: true, automaticDraftMutation: false,
      inspection: { healthy: true, pendingCount: 1 },
    })
  })

  it('requires exact document and research revisions before running', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const { packages, plugin, executor } = await fixture()
    await expect(runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'stale',
      participantId: 'runner-1', displayName: 'Runner',
    }, { packages, executor })).rejects.toThrow('Document revision conflict')
    await expect(runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'revision-1',
      expectedResearchRevision: 'stale', participantId: 'runner-1', displayName: 'Runner',
    }, { packages, executor })).rejects.toThrow('Research revision conflict')
    expect(inspectPluginWorkspace(doc, packages).inspection.reviewCount).toBe(0)
  })

  it('records an exact shared decision while keeping draft mutation unavailable', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const { packages, plugin, executor } = await fixture()
    const publication = await runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'revision-1',
      participantId: 'runner-1', displayName: 'Runner',
    }, { packages, executor, id: (() => { let value = 0; return () => `id-${++value}` })() })
    const inspection = inspectPluginWorkspace(doc, packages)
    const decided = decidePluginReviewForProject(doc, 'project-1', {
      reviewId: publication.reviews[0].id,
      expectedProposalEventId: publication.reviews[0].proposal.eventId,
      expectedResearchRevision: inspection.researchRevision,
      decision: 'accepted', participantId: 'reviewer-1', displayName: 'Reviewer',
    }, { id: () => 'decision-1', clock: () => 20 })
    expect(decided).toMatchObject({ review: { status: 'accepted' }, automaticDraftMutation: false })
    expect(() => decidePluginReviewForProject(doc, 'project-1', {
      reviewId: publication.reviews[0].id,
      expectedProposalEventId: publication.reviews[0].proposal.eventId,
      expectedResearchRevision: inspection.researchRevision,
      decision: 'rejected', participantId: 'reviewer-1', displayName: 'Reviewer',
    })).toThrow('Research revision conflict')
  })

  it('rejects a cross-project review before writing any shared decision event', () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const shared = getProjectSharedTypes(doc)
    const review = createPluginReview(shared.discussions, {
      reviewId: 'foreign-review', eventId: 'foreign-proposal', pluginVersion: '1.0.0',
      componentSha256: 'a'.repeat(64), contributionId: 'review', runnerId: 'runner-1',
      runnerDisplayName: 'Runner', timestamp: 10,
      proposal: {
        proposalVersion: 1, proposalId: 'foreign-plugin-proposal', pluginId: 'org.example.fixture',
        projectId: 'project-2', expectedRevision: 'revision-1', summary: 'Foreign proposal',
        content: 'Must remain undecided', operation: 'append',
      },
    })
    const expectedResearchRevision = projectStateFingerprint(doc)
    const before = Y.encodeStateAsUpdate(doc)
    expect(() => decidePluginReviewForProject(doc, 'project-1', {
      reviewId: review.id, expectedProposalEventId: review.proposal.eventId,
      expectedResearchRevision, decision: 'accepted', participantId: 'reviewer-1',
      displayName: 'Reviewer',
    }, { id: () => 'must-not-be-written', clock: () => 20 })).toThrow('project identity mismatch')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})
