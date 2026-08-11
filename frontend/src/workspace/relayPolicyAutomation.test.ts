import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationRelayReport,
  RelayAdminPolicyConfig,
  RelayRoomMembershipReport,
} from '../tauri'
import type { ProjectDeviceDirectoryInspection } from './projectDeviceDirectory'
import {
  configureHostedRelayPolicy,
  inspectHostedRelayPolicy,
  type RelayPolicyAutomationDependencies,
} from './relayPolicyAutomation'
import type { ResearchProjectManifest } from './schema'

const roomId = 'r'.repeat(43)
const keyA = `ed25519-sha256:${'a'.repeat(43)}`
const keyB = `ed25519-sha256:${'b'.repeat(43)}`
const project: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-relay-policy-mcp',
  documentId: 'document-relay-policy-mcp',
  title: 'Relay policy MCP',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'websocket', endpoint: 'ws://127.0.0.1:37665', roomId },
}
const relay: CollaborationRelayReport = {
  config: { enabled: true, listen: '127.0.0.1', port: 37665 },
  running: true,
  pid: 123,
  endpoint: 'ws://127.0.0.1:37665',
  storagePath: 'secret-local-path',
  persistence: 'bounded-sync-update-log-v1',
  lastError: null,
}
const room: RelayRoomMembershipReport = {
  schemaVersion: 3,
  registryRevision: 7,
  roomId,
  projectId: project.id,
  protected: true,
  members: [{
    memberId: 'member-secret-id',
    role: 'admin',
    createdAtMs: 1,
    rotatedAtMs: null,
    expiresAtMs: null,
    capabilityGeneration: 1,
    revokedAtMs: null,
    deviceKeyId: keyA,
  }],
}
const directory: ProjectDeviceDirectoryInspection = {
  healthy: true,
  registrationCount: 2,
  verifiedRegistrations: [],
  devices: [
    { keyId: keyA, publicKey: 'p'.repeat(43), fingerprint: 'a'.repeat(43), participantIds: ['alice'], registrationCount: 1, status: 'registered-device' },
    { keyId: keyB, publicKey: 'q'.repeat(43), fingerprint: 'b'.repeat(43), participantIds: ['bob'], registrationCount: 1, status: 'registered-device' },
  ],
  conflictingDevices: 0,
  invalidRecords: 0,
  unavailableRecords: 0,
  excessRecords: 0,
}

function harness(overrides: Partial<RelayPolicyAutomationDependencies> = {}) {
  const configure = vi.fn(async (
    _roomId: string,
    _revision: number,
    config: RelayAdminPolicyConfig | null,
  ): Promise<RelayRoomMembershipReport> => ({
    ...room,
    schemaVersion: config ? 4 : 3,
    registryRevision: 8,
    ...(config ? {
      adminPolicy: {
        schemaVersion: 1,
        requiredApprovals: config.requiredApprovals,
        configuredAtMs: 10,
        signerKeyIds: config.signers.map(({ keyId }) => keyId).sort(),
      },
    } : {}),
  }))
  const dependencies: RelayPolicyAutomationDependencies = {
    relaySettings: async () => relay,
    roomStatus: async () => room,
    configure,
    inspectDirectory: async () => directory,
    ...overrides,
  }
  return { dependencies, configure }
}

describe('relay policy semantic automation', () => {
  it('returns authoritative policy and eligible signer metadata without secrets or public keys', async () => {
    const result = await inspectHostedRelayPolicy(project, new Y.Doc(), harness().dependencies)
    expect(result.room.registryRevision).toBe(7)
    expect(result.room.memberCounts).toEqual(expect.objectContaining({ total: 1, admins: 1, deviceBound: 1 }))
    expect(result.projectDeviceDirectory.eligibleSigners).toEqual([
      { keyId: keyA, participantIds: ['alice'], eligible: true },
      { keyId: keyB, participantIds: ['bob'], eligible: true },
    ])
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('member-secret-id')
    expect(encoded).not.toContain('secret-local-path')
    expect(encoded).not.toContain('publicKey')
    expect(encoded).not.toContain('capability')
    expect(result.secretsReturned).toBe(false)
  })

  it('maps exact selected key IDs internally and applies one exact revision transition', async () => {
    const test = harness()
    const result = await configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: true,
      expectedRegistryRevision: 7,
      requiredApprovals: 2,
      signerKeyIds: [keyB, keyA],
    }, test.dependencies)
    expect(test.configure).toHaveBeenCalledTimes(1)
    expect(test.configure.mock.calls[0][0]).toBe(roomId)
    expect(test.configure.mock.calls[0][1]).toBe(7)
    expect(test.configure.mock.calls[0][2]).toEqual({
      schemaVersion: 1,
      requiredApprovals: 2,
      signers: [
        { schemaVersion: 1, algorithm: 'Ed25519', keyId: keyA, publicKey: 'p'.repeat(43) },
        { schemaVersion: 1, algorithm: 'Ed25519', keyId: keyB, publicKey: 'q'.repeat(43) },
      ],
    })
    expect(result.room).toEqual(expect.objectContaining({ registryRevision: 8 }))
    expect(JSON.stringify(result)).not.toContain('publicKey')
  })

  it('removes policy without accepting hidden signer inputs', async () => {
    const test = harness()
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: false,
      expectedRegistryRevision: 7,
    }, test.dependencies)).resolves.toEqual(expect.objectContaining({ secretsReturned: false }))
    expect(test.configure.mock.calls[0][2]).toBeNull()
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: false,
      expectedRegistryRevision: 7,
      signerKeyIds: [keyA],
    }, test.dependencies)).rejects.toThrow('must not include')
  })

  it('fails before mutation for stale revision, unknown signer, unhealthy directory, or a remote host', async () => {
    const stale = harness()
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: true, expectedRegistryRevision: 6, requiredApprovals: 1, signerKeyIds: [keyA],
    }, stale.dependencies)).rejects.toThrow('inspect the policy')
    expect(stale.configure).not.toHaveBeenCalled()

    const unknown = harness()
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: true, expectedRegistryRevision: 7, requiredApprovals: 1,
      signerKeyIds: [`ed25519-sha256:${'z'.repeat(43)}`],
    }, unknown.dependencies)).rejects.toThrow('exact unconflicted')
    expect(unknown.configure).not.toHaveBeenCalled()

    const unhealthy = harness({ inspectDirectory: async () => ({ ...directory, healthy: false }) })
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: true, expectedRegistryRevision: 7, requiredApprovals: 1, signerKeyIds: [keyA],
    }, unhealthy.dependencies)).rejects.toThrow('healthy directory')

    const remote = harness({ relaySettings: async () => ({ ...relay, endpoint: 'ws://127.0.0.1:40000' }) })
    await expect(inspectHostedRelayPolicy(project, new Y.Doc(), remote.dependencies))
      .rejects.toThrow('not hosted by this running')
  })

  it('rejects a native response that advances revision without proving the requested policy', async () => {
    const mismatch = harness({
      configure: vi.fn(async (
        _roomId: string,
        _revision: number,
        _config: RelayAdminPolicyConfig | null,
      ): Promise<RelayRoomMembershipReport> => ({
        ...room,
        schemaVersion: 4,
        registryRevision: 8,
        adminPolicy: {
          schemaVersion: 1,
          requiredApprovals: 1,
          configuredAtMs: 10,
          signerKeyIds: [keyB],
        },
      })),
    })
    await expect(configureHostedRelayPolicy(project, new Y.Doc(), {
      enabled: true,
      expectedRegistryRevision: 7,
      requiredApprovals: 1,
      signerKeyIds: [keyA],
    }, mismatch.dependencies)).rejects.toThrow('requested policy transition')
  })
})
