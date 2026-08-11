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
  status: null, error: null, manifestName: null, componentName: null,
  currentDocumentRevision: 'revision-2',
  onManifestFile: callback, onComponentFile: callback, onLoad: callback,
  onSelectPackage: callback, onSelectContribution: callback, onRemovePackage: callback,
  onRun: callback, onSelectReview: callback, onDecision: callback,
}

describe('plugin workspace product contract', () => {
  it('shows exact authority, inactive capabilities, shared review, and stale state', () => {
    const html = renderToStaticMarkup(createElement(PluginWorkspaceContent, props))
    expect(html).toContain('Run in no-authority sandbox')
    expect(html).toContain('Active baseline: project.read, project.propose')
    expect(html).toContain('Inactive in this world: network.fetch')
    expect(html).toContain('Review content')
    expect(html).toContain('live draft changed')
    expect(html).toContain('Record accepted')
    expect(html).toContain('does not apply, append, or replace policy text')
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
