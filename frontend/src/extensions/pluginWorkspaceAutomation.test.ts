import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  registerAutomationEditorController,
  type AutomationEditorController,
} from '../workspace/editorAutomationRegistry'
import { getProjectSharedTypes, projectStateFingerprint } from '../workspace/projectModel'
import { PluginPackageRegistry } from './pluginPackageRegistry'
import { pluginInstallationCatalog } from './pluginInstallationStore'
import { loadZeroAuthorityPluginPackage, ZeroAuthorityPluginExecutor } from './pluginExecution'
import { createPluginReview } from './pluginReviewModel'
import {
  decidePluginReviewForProject,
  applyPluginReviewForProject,
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
  pluginInstallationCatalog.replace([])
  unregister = registerAutomationEditorController({
    projectId: 'project-1',
    read: () => ({ projectId: 'project-1', revision: 'revision-1', text: 'Secret draft', blocks: [], scenarioIds: [] }),
    replace: () => { throw new Error('must not replace') },
    replaceBlocks: () => { throw new Error('must not replace') },
    append: () => { throw new Error('must not append') },
  })
})
afterEach(() => { unregister(); pluginInstallationCatalog.replace([]) })

async function fixture(proposalCount = 1) {
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
    output: { kind: 'proposals', proposals: Array.from({ length: proposalCount }, (_, index) => ({
      proposalVersion: 1 as const, proposalId: `proposal-${index + 1}`, pluginId: invocation.pluginId,
      projectId: invocation.project!.projectId, expectedRevision: invocation.project!.revision,
      summary: `Review secret ${index + 1}`, content: `Proposed secret content ${index + 1}`,
      operation: 'append' as const,
    })) },
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
    }, {
      packages, executor, id: (() => { let value = 0; return () => `id-${++value}` })(), clock: () => 10,
      attest: async (_doc, _projectId, event) => ({
        status: 'signed-device', keyId: 'ed25519-sha256:test', eventKind: 'plugin-review',
        eventId: `${event.reviewId.length}:${event.reviewId}${event.eventId}`,
        eventSha256: 'hash', attestationCount: 1,
        authority: 'installation-device-not-human-identity',
      }),
    })
    expect(publication.reviews).toHaveLength(1)
    expect(publication.reviews[0]).toMatchObject({ status: 'pending', proposal: { content: 'Proposed secret content 1' } })
    expect(publication.attributions).toEqual([
      expect.objectContaining({ status: 'signed-device', eventKind: 'plugin-review' }),
    ])
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

  it('exposes content-minimized installed-version metadata without component or signature bodies', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    pluginInstallationCatalog.replace([{
      packageId: 'org.example.fixture@1.0.0#aaaaaaaaaaaaaaaa', pluginId: 'org.example.fixture',
      name: 'Fixture', version: '1.0.0', description: 'Fixture', componentName: 'fixture.component',
      componentByteLength: 64, componentSha256: 'a'.repeat(64), publisherName: 'Publisher',
      publisherKeyId: `ed25519-sha256:${'k'.repeat(43)}`, installedAt: 1, enabled: true,
      activationAction: 'disable',
    }])
    const inspection = inspectPluginWorkspace(doc, new PluginPackageRegistry())
    expect(inspection.installedPackages).toEqual([
      expect.objectContaining({ pluginId: 'org.example.fixture', enabled: true }),
    ])
    expect(JSON.stringify(inspection.installedPackages)).not.toContain('componentBase64')
    expect(JSON.stringify(inspection.installedPackages)).not.toContain('signature')
  })

  it('serializes proposal attribution so concurrent publication cannot bypass history bounds', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const { packages, plugin, executor } = await fixture(3)
    let active = 0
    let maximumActive = 0
    const publication = await runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'revision-1',
      participantId: 'runner-1', displayName: 'Runner',
    }, {
      packages, executor, id: (() => { let value = 0; return () => `serial-${++value}` })(),
      attest: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active -= 1
        return {
          status: 'unsigned', reason: 'signing-or-registration-unavailable',
          authority: 'installation-device-not-human-identity',
        }
      },
    })
    expect(publication.reviews).toHaveLength(3)
    expect(publication.attributions).toHaveLength(3)
    expect(maximumActive).toBe(1)
  })

  it('records an exact shared decision while keeping draft mutation unavailable', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const { packages, plugin, executor } = await fixture()
    const publication = await runLoadedPluginForProject(doc, 'project-1', {
      packageId: plugin.packageId, contributionId: 'review', expectedDocumentRevision: 'revision-1',
      participantId: 'runner-1', displayName: 'Runner',
    }, {
      packages, executor, id: (() => { let value = 0; return () => `id-${++value}` })(),
      attest: async () => ({
        status: 'unsigned', reason: 'signing-or-registration-unavailable',
        authority: 'installation-device-not-human-identity',
      }),
    })
    const inspection = inspectPluginWorkspace(doc, packages)
    const decided = await decidePluginReviewForProject(doc, 'project-1', {
      reviewId: publication.reviews[0].id,
      expectedProposalEventId: publication.reviews[0].proposal.eventId,
      expectedResearchRevision: inspection.researchRevision,
      decision: 'accepted', participantId: 'reviewer-1', displayName: 'Reviewer',
    }, {
      id: () => 'decision-1', clock: () => 20,
      attest: async () => ({
        status: 'unsigned', reason: 'signing-or-registration-unavailable',
        authority: 'installation-device-not-human-identity',
      }),
    })
    expect(decided).toMatchObject({
      review: { status: 'accepted' }, automaticDraftMutation: false,
      attribution: { status: 'unsigned' },
    })
    expect(inspectPluginWorkspace(doc, packages).reviews[0]).toMatchObject({
      status: 'accepted', acceptedDecisionEventId: 'decision-1', decisionCount: 1,
    })
    await expect(decidePluginReviewForProject(doc, 'project-1', {
      reviewId: publication.reviews[0].id,
      expectedProposalEventId: publication.reviews[0].proposal.eventId,
      expectedResearchRevision: inspection.researchRevision,
      decision: 'rejected', participantId: 'reviewer-1', displayName: 'Reviewer',
    })).rejects.toThrow('Research revision conflict')
  })

  it('applies only the exact accepted review under document and research revision guards', async () => {
    const doc = new Y.Doc({ guid: 'project-1' })
    const shared = getProjectSharedTypes(doc)
    const proposal = createPluginReview(shared.discussions, {
      reviewId: 'apply-review', eventId: 'apply-proposal', pluginVersion: '1.0.0',
      componentSha256: 'a'.repeat(64), contributionId: 'review', runnerId: 'runner-1',
      runnerDisplayName: 'Runner', timestamp: 10,
      proposal: {
        proposalVersion: 1, proposalId: 'apply-plugin-proposal', pluginId: 'org.example.fixture',
        projectId: 'project-1', expectedRevision: 'revision-1', summary: 'Apply proposal',
        content: 'Linked plugin policy.', operation: 'append',
      },
    })
    const accepted = await decidePluginReviewForProject(doc, 'project-1', {
      reviewId: proposal.id, expectedProposalEventId: proposal.proposal.eventId,
      expectedResearchRevision: projectStateFingerprint(doc), decision: 'accepted',
      participantId: 'reviewer-1', displayName: 'Reviewer',
    }, {
      id: () => 'apply-decision', clock: () => 20,
      attest: async () => ({
        status: 'unsigned', reason: 'signing-or-registration-unavailable',
        authority: 'installation-device-not-human-identity',
      }),
    })
    let writes = 0
    const controller: AutomationEditorController = {
      projectId: 'project-1',
      read: () => ({
        projectId: 'project-1', revision: 'revision-1', text: 'Existing',
        blocks: [{ kind: 'paragraph' as const, text: 'Existing' }], scenarioIds: [],
      }),
      replace: () => { throw new Error('unexpected replace') },
      append: () => { throw new Error('unexpected append') },
      replaceBlocks: (_expected, blocks) => {
        writes += 1
        return { projectId: 'project-1', revision: 'revision-2', text: '', blocks, scenarioIds: [] }
      },
    }
    const expectedResearchRevision = projectStateFingerprint(doc)
    expect(() => applyPluginReviewForProject(doc, 'project-1', {
      reviewId: proposal.id,
      expectedProposalEventId: proposal.proposal.eventId,
      expectedDecisionEventId: accepted.review.decisions[0].eventId,
      expectedDocumentRevision: 'revision-1',
      expectedResearchRevision,
      confirmFullReplacement: true,
    }, { controller })).toThrow('confirmation does not match')
    expect(writes).toBe(0)
    const applied = applyPluginReviewForProject(doc, 'project-1', {
      reviewId: proposal.id,
      expectedProposalEventId: proposal.proposal.eventId,
      expectedDecisionEventId: accepted.review.decisions[0].eventId,
      expectedDocumentRevision: 'revision-1',
      expectedResearchRevision,
      confirmFullReplacement: false,
    }, { controller })
    expect(applied).toMatchObject({
      reviewId: proposal.id, decisionEventId: 'apply-decision', operation: 'append',
      linkedPolicyId: proposal.id, documentRevision: 'revision-2', documentBlockCount: 2,
      contentOmitted: true, explicitDraftMutation: true, automaticDraftMutation: false,
    })
    expect(JSON.stringify(applied)).not.toContain('Linked plugin policy')
    expect(writes).toBe(1)
    expect(() => applyPluginReviewForProject(doc, 'project-1', {
      reviewId: proposal.id,
      expectedProposalEventId: proposal.proposal.eventId,
      expectedDecisionEventId: 'apply-decision',
      expectedDocumentRevision: 'revision-1',
      expectedResearchRevision: 'stale-research-revision',
      confirmFullReplacement: false,
    }, { controller })).toThrow('Research revision conflict')
    expect(writes).toBe(1)
  })

  it('rejects a cross-project review before writing any shared decision event', async () => {
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
    await expect(decidePluginReviewForProject(doc, 'project-1', {
      reviewId: review.id, expectedProposalEventId: review.proposal.eventId,
      expectedResearchRevision, decision: 'accepted', participantId: 'reviewer-1',
      displayName: 'Reviewer',
    }, { id: () => 'must-not-be-written', clock: () => 20 })).rejects.toThrow('project identity mismatch')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})
