import { describe, expect, it } from 'vitest'
import {
  validatePluginChangeProposal,
  validateResearchPluginManifest,
  type PluginChangeProposal,
  type ResearchPluginManifest,
} from './pluginManifest'

const manifest: ResearchPluginManifest = {
  schemaVersion: 1,
  id: 'org.example.citation-auditor',
  name: 'Citation auditor',
  version: '1.0.0',
  description: 'Checks cited claims and proposes a review note.',
  runtime: { kind: 'wasi-component', component: 'citation-auditor.wasm', world: 'syzygy:research/plugin' },
  permissions: {
    capabilities: ['project.read', 'project.propose', 'network.fetch'],
    networkDomains: ['doi.org', '*.crossref.org'],
    modelProviders: [],
  },
  contributions: [
    { kind: 'evaluator', id: 'citation-coverage', title: 'Citation coverage', description: 'Find unsupported claims.' },
  ],
}

describe('research plugin contracts', () => {
  it('accepts a least-authority WASI manifest', () => {
    expect(validateResearchPluginManifest(manifest)).toEqual([])
  })

  it('requires explicit network and model permissions', () => {
    expect(
      validateResearchPluginManifest({
        ...manifest,
        permissions: { capabilities: ['project.read'], networkDomains: ['example.org'], modelProviders: ['local'] },
      }),
    ).toEqual(['networkDomains require network.fetch', 'modelProviders require model.invoke'])
  })

  it('requires revision-guarded proposals and bounds their content', () => {
    const proposal: PluginChangeProposal = {
      proposalVersion: 1,
      proposalId: 'proposal-1',
      pluginId: manifest.id,
      projectId: 'project-1',
      expectedRevision: 'revision-1',
      summary: 'Add an evidence warning.',
      operation: 'append',
      content: '> Citation coverage needs review.',
    }
    expect(validatePluginChangeProposal(proposal)).toEqual([])
    expect(validatePluginChangeProposal({ ...proposal, expectedRevision: '' })).toContain('expectedRevision is required')
    expect(validatePluginChangeProposal({ ...proposal, ambientMutation: true })).toContain(
      'proposal contains unknown fields: ambientMutation',
    )
    expect(validatePluginChangeProposal({ ...proposal, content: 42 })).toContain('content is required')
  })

  it('keeps the runtime validator strict against unknown manifest fields', () => {
    expect(validateResearchPluginManifest({ ...manifest, ambientAuthority: true })).toContain(
      'manifest contains unknown fields: ambientAuthority',
    )
  })
})
