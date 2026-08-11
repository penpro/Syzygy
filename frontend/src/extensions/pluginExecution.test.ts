import { describe, expect, it } from 'vitest'
import type { ResearchPluginManifest } from './pluginManifest'
import {
  loadZeroAuthorityPluginPackage,
  PluginExecutionError,
  ZeroAuthorityPluginExecutor,
  type LoadedZeroAuthorityPluginPackage,
  type PluginComponentExecutor,
} from './pluginExecution'

const manifest = (capabilities: ResearchPluginManifest['permissions']['capabilities'] = ['project.read', 'project.propose']): ResearchPluginManifest => ({
  schemaVersion: 1,
  id: 'org.example.fixture',
  name: 'Fixture',
  version: '1.0.0',
  description: 'A bounded test plugin.',
  runtime: { kind: 'wasi-component', component: 'fixture.component', world: 'syzygy:research/plugin@1.0.0' },
  permissions: { capabilities, networkDomains: capabilities.includes('network.fetch') ? ['example.com'] : [], modelProviders: [] },
  contributions: [{ kind: 'evaluator', id: 'review', title: 'Review', description: 'Review the project.' }],
})

const project = {
  projectId: 'project-1',
  revision: 'revision-1',
  documentText: 'Policy text',
  sources: [{ snapshotId: 'source-1', label: 'Source', content: 'Evidence' }],
}

const limits = {
  maxComponentBytes: 8 * 1024 * 1024,
  maxEnvelopeBytes: 1024 * 1024,
  maxLinearMemoryBytes: 32 * 1024 * 1024,
  maxSources: 200,
  maxProposals: 32,
  executionFuel: 50_000_000,
  executionDeadlineMs: 2_000,
  ambientImportsLinked: false as const,
}

async function loaded(value = manifest()): Promise<LoadedZeroAuthorityPluginPackage> {
  return loadZeroAuthorityPluginPackage(value, { name: 'fixture.component', bytes: new Uint8Array([0, 97, 115, 109]) })
}

describe('zero-authority plugin execution composition', () => {
  it('loads only an exact selected component and binds its content digest', async () => {
    const plugin = await loaded()
    expect(plugin.packageId).toMatch(/^org\.example\.fixture@1\.0\.0#[a-f0-9]{16}$/)
    expect(plugin.componentByteLength).toBe(4)
    expect(plugin.componentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plugin.componentBase64).toBe('AGFzbQ==')
  })

  it('rejects traversal, mismatched files, unsupported worlds, and oversized components', async () => {
    await expect(loadZeroAuthorityPluginPackage({
      ...manifest(), runtime: { kind: 'wasi-component', component: '../fixture.component', world: 'syzygy:research/plugin@1.0.0' },
    }, { name: 'fixture.component', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'package-invalid' })
    await expect(loadZeroAuthorityPluginPackage(manifest(), {
      name: 'other.component', bytes: new Uint8Array([1]),
    })).rejects.toBeInstanceOf(PluginExecutionError)
    await expect(loadZeroAuthorityPluginPackage({
      ...manifest(), runtime: { kind: 'wasi-component', component: 'fixture.component', world: 'other:world/plugin@1.0.0' },
    }, { name: 'fixture.component', bytes: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'package-invalid' })
    await expect(loadZeroAuthorityPluginPackage(manifest(), {
      name: 'fixture.component', bytes: new Uint8Array(8 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ code: 'package-invalid' })
  })

  it('passes only explicitly requested project authority and queues valid proposals for review', async () => {
    let invocation: unknown
    const executor: PluginComponentExecutor = async (_component, input) => {
      invocation = input
      return {
        runtimeVersion: 1,
        world: 'syzygy:research/plugin@1.0.0',
        output: { kind: 'proposals', proposals: [{
          proposalVersion: 1,
          proposalId: 'proposal-1',
          pluginId: 'org.example.fixture',
          projectId: 'project-1',
          expectedRevision: 'revision-1',
          summary: 'Append a review note',
          content: 'Review note',
          operation: 'append',
        }] },
        limits,
      }
    }
    const outcome = await new ZeroAuthorityPluginExecutor(executor).execute({
      plugin: await loaded(manifest(['project.read', 'project.propose', 'network.fetch'])),
      contributionId: 'review',
      project,
    })
    expect(invocation).toMatchObject({ project, contributionId: 'review' })
    expect(outcome.status).toBe('pending-human-review')
    if (outcome.status === 'pending-human-review') {
      expect(outcome.receipts).toHaveLength(1)
      expect(outcome.receipts[0].proposal.content).toBe('Review note')
    }
  })

  it('withholds the project snapshot when project.read was not granted', async () => {
    let invocation: unknown
    const executor: PluginComponentExecutor = async (_component, input) => {
      invocation = input
      return { runtimeVersion: 1, world: 'syzygy:research/plugin@1.0.0', output: { kind: 'no-change', reason: 'No input granted' }, limits }
    }
    const outcome = await new ZeroAuthorityPluginExecutor(executor).execute({
      plugin: await loaded(manifest([])), contributionId: 'review', project,
    })
    expect(invocation).toMatchObject({ project: null })
    expect(outcome.status).toBe('no-change')
  })

  it('fails closed on stale identity, missing proposal authority, forged limits, and runtime failure', async () => {
    const proposalExecutor: PluginComponentExecutor = async () => ({
      runtimeVersion: 1,
      world: 'syzygy:research/plugin@1.0.0',
      output: { kind: 'proposals', proposals: [{
        proposalVersion: 1, proposalId: 'proposal-1', pluginId: 'org.example.fixture',
        projectId: 'project-1', expectedRevision: 'stale', summary: 'Stale', content: 'No', operation: 'replace',
      }] },
      limits,
    })
    await expect(new ZeroAuthorityPluginExecutor(proposalExecutor).execute({
      plugin: await loaded(), contributionId: 'review', project,
    })).rejects.toMatchObject({ code: 'output-denied' })

    const validProposal = async () => ({
      runtimeVersion: 1 as const,
      world: 'syzygy:research/plugin@1.0.0' as const,
      output: { kind: 'proposals' as const, proposals: [{
        proposalVersion: 1 as const, proposalId: 'proposal-1', pluginId: 'org.example.fixture',
        projectId: 'project-1', expectedRevision: 'revision-1', summary: 'Review', content: 'No', operation: 'replace' as const,
      }] },
      limits,
    })
    await expect(new ZeroAuthorityPluginExecutor(validProposal).execute({
      plugin: await loaded(manifest(['project.read'])), contributionId: 'review', project,
    })).rejects.toMatchObject({ code: 'output-denied' })

    await expect(new ZeroAuthorityPluginExecutor(async () => ({
      runtimeVersion: 1, world: 'syzygy:research/plugin@1.0.0',
      output: { kind: 'no-change', reason: 'No change' },
      limits: { ...limits, ambientImportsLinked: true as false },
    })).execute({ plugin: await loaded(), contributionId: 'review', project })).rejects.toMatchObject({ code: 'output-denied' })

    await expect(new ZeroAuthorityPluginExecutor(async () => { throw new Error('guest secret') }).execute({
      plugin: await loaded(), contributionId: 'review', project,
    })).rejects.toMatchObject({ code: 'runtime-denied', message: 'Plugin execution was denied' })
  })

  it('recomputes component provenance and rejects a mutated in-memory package', async () => {
    const plugin = await loaded()
    const executor = new ZeroAuthorityPluginExecutor(async () => ({
      runtimeVersion: 1, world: 'syzygy:research/plugin@1.0.0',
      output: { kind: 'no-change', reason: 'should not run' }, limits,
    }))
    await expect(executor.execute({
      plugin: { ...plugin, componentBase64: 'AQ==' }, contributionId: 'review', project,
    })).rejects.toMatchObject({ code: 'package-invalid' })
  })

  it('serializes active project runs and releases the slot after failure', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const executor = new ZeroAuthorityPluginExecutor(async () => {
      await blocked
      throw new Error('fixture')
    })
    const plugin = await loaded()
    const first = executor.execute({ plugin, contributionId: 'review', project })
    await Promise.resolve()
    await expect(executor.execute({ plugin, contributionId: 'review', project })).rejects.toMatchObject({ code: 'run-in-progress' })
    release()
    await expect(first).rejects.toMatchObject({ code: 'runtime-denied' })
    await expect(new ZeroAuthorityPluginExecutor(async () => ({
      runtimeVersion: 1, world: 'syzygy:research/plugin@1.0.0', output: { kind: 'no-change', reason: 'Recovered' }, limits,
    })).execute({ plugin, contributionId: 'review', project })).resolves.toMatchObject({ status: 'no-change' })
  })
})
