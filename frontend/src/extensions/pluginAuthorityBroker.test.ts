import { describe, expect, it } from 'vitest'
import {
  PluginHostError,
  ResearchPluginAuthorityBroker,
  type PluginAuthorityGrant,
  type PluginProjectSnapshot,
} from './pluginAuthorityBroker'
import type { PluginChangeProposal, ResearchPluginManifest } from './pluginManifest'

const manifest: ResearchPluginManifest = {
  schemaVersion: 1,
  id: 'org.example.research-helper',
  name: 'Research helper',
  version: '1.0.0',
  description: 'Exercises the open host authority contract.',
  runtime: { kind: 'wasi-component', component: 'research-helper.wasm', world: 'syzygy:research/plugin@1.0.0' },
  permissions: {
    capabilities: ['project.read', 'project.propose', 'drive.read', 'network.fetch', 'model.invoke'],
    networkDomains: ['doi.org', '*.crossref.org'],
    modelProviders: ['local', 'openai'],
  },
  contributions: [{ kind: 'tool', id: 'research-helper', title: 'Research helper', description: 'A bounded fixture.' }],
}

const grant: PluginAuthorityGrant = {
  capabilities: ['project.read', 'project.propose', 'network.fetch', 'model.invoke'],
  networkDomains: ['doi.org', '*.crossref.org'],
  modelProviders: ['local'],
}

const snapshot: PluginProjectSnapshot = {
  projectId: 'project-001',
  revision: 'revision-001',
  semanticText: '# Policy\nOriginal text.',
  sourceSnapshotIds: ['source-001'],
}

const proposal = (): PluginChangeProposal => ({
  proposalVersion: 1,
  proposalId: 'proposal-001',
  pluginId: manifest.id,
  projectId: snapshot.projectId,
  expectedRevision: snapshot.revision,
  summary: 'Append a review note.',
  content: '> Review this evidence.',
  operation: 'append',
})

function fixture(now = { value: Date.parse('2026-07-15T00:00:00.000Z') }) {
  return { broker: new ResearchPluginAuthorityBroker(() => now.value, () => 'session-001'), now }
}

async function errorCode(action: () => unknown) {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginHostError)
    return (error as PluginHostError).code
  }
  throw new Error('expected PluginHostError')
}

describe('research plugin authority broker', () => {
  it('opens an expiring least-authority session and returns detached snapshots', () => {
    const { broker } = fixture()
    const status = broker.openSession(manifest, grant, snapshot)
    expect(status).toMatchObject({
      sessionId: 'session-001',
      pluginId: manifest.id,
      projectId: snapshot.projectId,
      capabilities: grant.capabilities,
    })
    const first = broker.readProject(status.sessionId)
    first.semanticText = 'mutated plugin copy'
    first.sourceSnapshotIds.push('forged-source')
    expect(broker.readProject(status.sessionId)).toEqual(snapshot)
  })

  it('rejects grants that exceed or contradict the manifest request', async () => {
    const { broker } = fixture()
    await expect(
      errorCode(() => broker.openSession(manifest, { ...grant, capabilities: [...grant.capabilities, 'drive.propose'] }, snapshot)),
    ).resolves.toBe('invalid-request')
    await expect(
      errorCode(() => broker.openSession(manifest, { ...grant, networkDomains: ['undeclared.example'] }, snapshot)),
    ).resolves.toBe('invalid-request')
    await expect(
      errorCode(() => broker.openSession(manifest, { ...grant, modelProviders: ['xai'] }, snapshot)),
    ).resolves.toBe('invalid-request')
  })

  it('returns only a pending proposal and rejects stale or cross-target mutation', async () => {
    const { broker } = fixture()
    const { sessionId } = broker.openSession(manifest, grant, snapshot)
    const receipt = broker.submitProjectProposal(sessionId, proposal())
    expect(receipt.status).toBe('pending-human-review')
    receipt.proposal.content = 'mutated receipt copy'
    expect(broker.readProject(sessionId)).toEqual(snapshot)
    await expect(errorCode(() => broker.submitProjectProposal(sessionId, { ...proposal(), expectedRevision: 'stale' }))).resolves.toBe(
      'stale-revision',
    )
    await expect(errorCode(() => broker.submitProjectProposal(sessionId, { ...proposal(), projectId: 'other' }))).resolves.toBe(
      'target-denied',
    )
  })

  it('authorizes decisions only for granted HTTPS hosts and configured models', async () => {
    const { broker } = fixture()
    const { sessionId } = broker.openSession(manifest, grant, snapshot)
    expect(broker.authorizeNetworkFetch(sessionId, 'https://api.crossref.org/works?q=policy')).toMatchObject({
      method: 'GET',
      maxResponseBytes: 1024 * 1024,
      requiresPublicAddressRecheck: true,
    })
    expect(broker.authorizeModelInvocation(sessionId, 'local')).toEqual({
      provider: 'local',
      requiresProviderDisclosure: false,
      requiresProviderRunRecord: true,
    })
    await expect(errorCode(() => broker.authorizeNetworkFetch(sessionId, 'http://doi.org/unsafe'))).resolves.toBe('target-denied')
    await expect(errorCode(() => broker.authorizeNetworkFetch(sessionId, 'https://crossref.org/'))).resolves.toBe('target-denied')
    await expect(errorCode(() => broker.authorizeNetworkFetch(sessionId, 'https://127.0.0.1/'))).resolves.toBe('target-denied')
    await expect(errorCode(() => broker.authorizeModelInvocation(sessionId, 'openai'))).resolves.toBe('target-denied')
  })

  it('requires selected-workspace identity and explicit drive authority', async () => {
    const { broker } = fixture()
    const driveGrant: PluginAuthorityGrant = {
      capabilities: ['drive.read'],
      networkDomains: [],
      modelProviders: [],
    }
    const { sessionId } = broker.openSession(manifest, driveGrant, snapshot)
    expect(broker.authorizeDriveAccess(sessionId, 'workspace-1', 'workspace-1', 'read')).toEqual({
      workspaceId: 'workspace-1',
      mode: 'read',
      requiresTargetRecheck: true,
    })
    await expect(errorCode(() => broker.authorizeDriveAccess(sessionId, 'workspace-2', 'workspace-1', 'read'))).resolves.toBe(
      'target-denied',
    )
    await expect(errorCode(() => broker.authorizeDriveAccess(sessionId, 'workspace-1', 'workspace-1', 'propose'))).resolves.toBe(
      'permission-denied',
    )
  })

  it('expires and revokes sessions without leaking stored content in errors', async () => {
    const { broker, now } = fixture()
    const { sessionId } = broker.openSession(manifest, grant, snapshot)
    now.value += 15 * 60 * 1000
    const expired = await errorCode(() => broker.readProject(sessionId))
    expect(expired).toBe('session-expired')
    expect(JSON.stringify(expired)).not.toContain(snapshot.semanticText)

    const second = new ResearchPluginAuthorityBroker(() => now.value, () => 'session-002')
    const opened = second.openSession(manifest, grant, snapshot)
    expect(second.revokeSession(opened.sessionId)).toBe(true)
    expect(second.revokeSession(opened.sessionId)).toBe(false)
    await expect(errorCode(() => second.readProject(opened.sessionId))).resolves.toBe('invalid-session')
  })
})
