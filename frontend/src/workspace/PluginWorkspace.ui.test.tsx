import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PluginWorkspaceContent, type PluginWorkspaceContentProps } from './PluginWorkspace'

const callback = vi.fn()
const props: PluginWorkspaceContentProps = {
  packages: [{
    packageId: 'org.example.fixture@1.0.0#aaaaaaaaaaaaaaaa',
    pluginId: 'org.example.fixture', name: 'Fixture', version: '1.0.0', description: 'Checks citations.',
    componentName: 'fixture.component', componentByteLength: 64, componentSha256: 'a'.repeat(64),
    requestedCapabilities: ['project.read', 'project.propose', 'network.fetch'],
    contributions: [{ kind: 'evaluator', id: 'review', title: 'Review', description: 'Review' }],
  }],
  installedPackages: [{
    packageId: 'org.example.fixture@1.0.0#aaaaaaaaaaaaaaaa', pluginId: 'org.example.fixture',
    name: 'Fixture', version: '1.0.0', description: 'Checks citations.', componentName: 'fixture.component',
    componentByteLength: 64, componentSha256: 'a'.repeat(64), publisherName: 'Example publisher',
    publisherKeyId: `ed25519-sha256:${'k'.repeat(43)}`, installedAt: 1, enabled: true,
    activationAction: 'disable',
  }],
  reviews: [{
    id: 'review-1', status: 'pending', decisions: [],
    proposal: {
      schemaVersion: 1, kind: 'proposal', eventId: 'event-1', reviewId: 'review-1',
      pluginProposalId: 'proposal-1', pluginId: 'org.example.fixture', pluginVersion: '1.0.0',
      componentSha256: 'a'.repeat(64), contributionId: 'review', projectId: 'project-1',
      expectedRevision: 'revision-1', summary: 'Add a citation note', content: 'Review content', operation: 'append',
      runnerId: 'runner-1', runnerDisplayName: 'Runner', timestamp: 1,
    },
  }],
  healthy: true,
  selectedPackageId: 'org.example.fixture@1.0.0#aaaaaaaaaaaaaaaa',
  selectedContributionId: 'review', selectedReviewId: 'review-1', busy: false,
  status: null, error: null, manifestName: null, componentName: null, signatureName: null,
  currentDocumentRevision: 'revision-2',
  onManifestFile: callback, onComponentFile: callback, onSignatureFile: callback,
  onLoad: callback, onInstall: callback,
  onSelectPackage: callback, onSelectContribution: callback, onRemovePackage: callback,
  onActivateInstalled: callback, onDisableInstalled: callback, onRollbackInstalled: callback,
  onRemoveInstalled: callback,
  onRun: callback, onSelectReview: callback, onDecision: callback,
}

describe('plugin workspace product contract', () => {
  it('shows exact authority, inactive capabilities, shared review, and stale state', () => {
    const html = renderToStaticMarkup(createElement(PluginWorkspaceContent, props))
    expect(html).toContain('Run in no-authority sandbox')
    expect(html).toContain('Verify signature and install locally')
    expect(html).toContain('publisher&#x27;s legal or human identity')
    expect(html).toContain('Enabled · verified this session')
    expect(html).toContain('Active baseline: project.read, project.propose')
    expect(html).toContain('Inactive in this world: network.fetch')
    expect(html).toContain('Review content')
    expect(html).toContain('live draft changed')
    expect(html).toContain('Record accepted')
    expect(html).toContain('does not apply, append, or replace policy text')
  })

  it('exposes explicit signed rollback and disabled-version removal without Apply authority', () => {
    const html = renderToStaticMarkup(createElement(PluginWorkspaceContent, {
      ...props,
      installedPackages: [{
        ...props.installedPackages[0],
        packageId: 'org.example.fixture@0.9.0#bbbbbbbbbbbbbbbb',
        version: '0.9.0',
        componentSha256: 'b'.repeat(64),
        enabled: false,
        activationAction: 'rollback',
      }],
    }))
    expect(html).toContain('Roll back to this signed version')
    expect(html).toContain('Remove stored version')
    expect(html).not.toContain('Apply to draft')
  })

  it('does not expose decision controls after a review is decided', () => {
    const html = renderToStaticMarkup(createElement(PluginWorkspaceContent, {
      ...props, reviews: [{ ...props.reviews[0], status: 'accepted', decisions: [{
        schemaVersion: 1, kind: 'decision', eventId: 'decision-1', reviewId: 'review-1',
        proposalEventId: 'event-1', decision: 'accepted', reviewerId: 'reviewer-1',
        reviewerDisplayName: 'Reviewer', timestamp: 2,
      }] }],
    }))
    expect(html).not.toContain('Record accepted')
    expect(html).toContain('accepted')
  })
})
