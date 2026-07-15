import { describe, expect, it } from 'vitest'
import wit from '../../../docs/wit/syzygy-research-plugin-v1.wit?raw'
import {
  RESEARCH_PLUGIN_WIT_WORLD,
  validatePluginWasiInvocation,
  validatePluginWasiOutput,
  type PluginWasiInvocation,
  type PluginWasiOutput,
} from './pluginWasiContract'

const invocation: PluginWasiInvocation = {
  invocationVersion: 1,
  pluginId: 'org.example.citation-auditor',
  contributionId: 'citation-coverage',
  project: {
    projectId: 'project-1',
    revision: 'revision-1',
    documentText: 'A bounded policy draft.',
    sources: [{ snapshotId: 'source-1', label: 'Source one', content: 'Evidence.' }],
  },
}

const output: PluginWasiOutput = {
  kind: 'proposals',
  proposals: [{
    proposalVersion: 1,
    proposalId: 'proposal-1',
    pluginId: invocation.pluginId,
    projectId: 'project-1',
    expectedRevision: 'revision-1',
    summary: 'Add an evidence warning.',
    content: '> Citation coverage needs review.',
    operation: 'append',
  }],
}

describe('zero-authority WASI plugin contract', () => {
  it('publishes a versioned world with no host imports', () => {
    expect(RESEARCH_PLUGIN_WIT_WORLD).toBe('syzygy:research/plugin@1.0.0')
    expect(wit).toContain('package syzygy:research@1.0.0;')
    expect(wit).toContain('world plugin')
    expect(wit).toContain('export research-plugin;')
    expect(wit).not.toMatch(/^\s*import\s/m)
  })

  it('accepts bounded exact invocation and proposal envelopes', () => {
    expect(validatePluginWasiInvocation(invocation)).toEqual([])
    expect(validatePluginWasiOutput(output)).toEqual([])
    expect(validatePluginWasiInvocation({ ...invocation, project: null })).toEqual([])
    expect(validatePluginWasiOutput({ kind: 'no-change', reason: 'No unsupported claims.' })).toEqual([])
  })

  it('rejects ambient fields, duplicate sources, and oversized snapshots', () => {
    expect(validatePluginWasiInvocation({ ...invocation, network: true })).toContain('invocation contains unknown fields: network')
    const source = invocation.project!.sources[0]
    expect(validatePluginWasiInvocation({ ...invocation, project: { ...invocation.project!, sources: [source, source] } })).toContain(
      'duplicate source snapshot: source-1',
    )
    expect(validatePluginWasiInvocation({ ...invocation, project: { ...invocation.project!, documentText: 'x'.repeat(500_001) } })).toContain(
      'project.documentText must be at most 500,000 characters',
    )
    const cyclic: Record<string, unknown> = { ...invocation }
    cyclic.project = cyclic
    expect(validatePluginWasiInvocation(cyclic)).toContain('invocation exceeds one MiB')
  })

  it('rejects untyped or directly mutating plugin output', () => {
    expect(validatePluginWasiOutput({ kind: 'mutated', content: 'done' })).toEqual(['output kind must be no-change or proposals'])
    expect(validatePluginWasiOutput({ ...output, applied: true })).toContain('output contains unknown fields: applied')
    expect(validatePluginWasiOutput({ kind: 'proposals', proposals: [] })).toContain('output proposals must contain between 1 and 32 items')
    expect(validatePluginWasiOutput({ kind: 'proposals', proposals: [{ ...output.proposals[0], expectedRevision: '' }] })).toContain(
      'proposal: expectedRevision is required',
    )
  })
})
