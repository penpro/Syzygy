import { describe, expect, it, vi } from 'vitest'
import type {
  ProjectRelayAdminApprovalProof,
  RelayAccessIdentityClaim,
  RelayAdminIdentityClaim,
  RelayDeviceBinding,
} from '../tauri'
import {
  canonicalRelayRemoteAdminAction,
  relayRemoteAdminActionSha256,
  runRelayRemoteAdminAction,
  type RelayRemoteAdminDependencies,
} from './relayRemoteAdmin'
import type { WebsocketProjectBinding } from './websocketProjectBinding'

const roomId = 'r'.repeat(43)
const memberId = 'm'.repeat(22)
const keyId = `ed25519-sha256:${'k'.repeat(43)}`
const capability = 'c'.repeat(43)
const signature = 's'.repeat(86)
const nonce = 'n'.repeat(43)

const binding: WebsocketProjectBinding = {
  endpoint: 'ws://127.0.0.1:7777',
  roomId,
  access: {
    schemaVersion: 3,
    memberId,
    role: 'admin',
    capability,
    capabilityGeneration: 2,
    expiresAtMs: null,
    deviceKeyId: keyId,
  },
}

const room = {
  schemaVersion: 3,
  registryRevision: 7,
  roomId,
  projectId: 'project-remote-admin',
  protected: true,
  members: [{
    memberId,
    role: 'admin',
    createdAtMs: 1,
    rotatedAtMs: null,
    expiresAtMs: null,
    capabilityGeneration: 2,
    revokedAtMs: null,
    deviceKeyId: keyId,
  }],
} as const

class FakeSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent = ''
  closed = false
  constructor(private readonly response: unknown) {}
  send(value: string) {
    this.sent = value
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(this.response) } as MessageEvent))
  }
  close() { this.closed = true }
  open() { this.onopen?.({} as Event) }
}

function dependencies(response: unknown) {
  let socket: FakeSocket | null = null
  let url = ''
  const signAccess = vi.fn(async (claim: RelayAccessIdentityClaim) => ({
    schemaVersion: 1 as const,
    algorithm: 'Ed25519' as const,
    keyId,
    claim,
    signature,
  }))
  const signAdmin = vi.fn(async (claim: RelayAdminIdentityClaim) => ({
    schemaVersion: 1 as const,
    algorithm: 'Ed25519' as const,
    keyId,
    claim,
    signature,
  }))
  const deps: RelayRemoteAdminDependencies = {
    signAccess,
    signAdmin,
    createSocket: (value) => {
      url = value
      socket = new FakeSocket(response)
      queueMicrotask(() => socket?.open())
      return socket as unknown as WebSocket
    },
    now: () => 1_750_000_000_000,
    nonce: () => nonce,
  }
  return { deps, signAccess, signAdmin, socket: () => socket, url: () => url }
}

describe('remote relay administration', () => {
  it('binds status to the same fresh device proof and accepts a strict room response', async () => {
    const harness = dependencies({ schemaVersion: 1, ok: true, error: null, room, credential: null })
    const result = await runRelayRemoteAdminAction('project-remote-admin', binding, { kind: 'status' }, 0, harness.deps)

    expect(result).toEqual({ room, credential: null })
    expect(harness.url()).toContain(`/__syzygy_relay_admin_v1/${roomId}?`)
    expect(harness.url()).toContain(`member=${memberId}`)
    const accessClaim = harness.signAccess.mock.calls[0][0]
    const adminClaim = harness.signAdmin.mock.calls[0][0]
    expect(adminClaim).toMatchObject({
      projectId: 'project-remote-admin',
      roomId,
      administratorMemberId: memberId,
      expectedRevision: 0,
      issuedAtMs: accessClaim.issuedAtMs,
      nonce: accessClaim.nonce,
    })
    expect(adminClaim.actionSha256).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(harness.socket()!.sent)).toEqual({
      schemaVersion: 1,
      claim: adminClaim,
      action: { kind: 'status' },
      signature,
      approvals: [],
    })
    expect(harness.socket()!.closed).toBe(true)
  })

  it('preserves the cross-runtime semantic action encoding', () => {
    const device: RelayDeviceBinding = {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId,
      publicKey: 'p'.repeat(43),
    }
    expect(canonicalRelayRemoteAdminAction({
      kind: 'issue', role: 'editor', expiresInSeconds: 3600, device,
    })).toBe(`issue\neditor\n3600\n1\nEd25519\n${keyId}\n${'p'.repeat(43)}`)
    expect(canonicalRelayRemoteAdminAction({
      kind: 'rotate', memberId, expiresInSeconds: null, device: null,
    })).toBe(`rotate\n${memberId}\nnone\nnone`)
    expect(canonicalRelayRemoteAdminAction({ kind: 'revoke', memberId }))
      .toBe(`revoke\n${memberId}`)
  })

  it('surfaces exact-revision rejection and rejects non-admin or malformed responses', async () => {
    const rejected = dependencies({
      schemaVersion: 1,
      ok: false,
      error: 'Relay membership changed; refresh and try again',
      room: null,
      credential: null,
    })
    await expect(runRelayRemoteAdminAction(
      'project-remote-admin',
      binding,
      { kind: 'revoke', memberId: 'x'.repeat(22) },
      6,
      rejected.deps,
    )).rejects.toThrow('refresh and try again')

    await expect(runRelayRemoteAdminAction(
      'project-remote-admin',
      { ...binding, access: { ...binding.access!, role: 'editor' } },
      { kind: 'status' },
      0,
      dependencies({}).deps,
    )).rejects.toThrow('administrator access')

    await expect(runRelayRemoteAdminAction(
      'project-remote-admin',
      binding,
      { kind: 'status' },
      0,
      dependencies({ schemaVersion: 1, ok: true, error: null, room: { ...room, extra: true }, credential: null }).deps,
    )).rejects.toThrow('malformed room report')
  })

  it('accepts only an exact credential schema at the same registry revision', async () => {
    const action = {
      kind: 'issue' as const,
      role: 'viewer' as const,
      expiresInSeconds: null,
      device: { schemaVersion: 1 as const, algorithm: 'Ed25519' as const, keyId, publicKey: 'p'.repeat(43) },
    }
    const credential = {
      schemaVersion: 3,
      roomId,
      memberId: 'v'.repeat(22),
      role: 'viewer',
      capability: 'z'.repeat(43),
      capabilityGeneration: 1,
      expiresAtMs: null,
      registryRevision: 7,
      deviceKeyId: keyId,
    } as const
    const accepted = dependencies({
      schemaVersion: 1, ok: true, error: null, room, credential,
    })
    await expect(runRelayRemoteAdminAction('project-remote-admin', binding, action, 6, accepted.deps))
      .resolves.toEqual({ room, credential })

    const stringSchema = dependencies({
      schemaVersion: 1,
      ok: true,
      error: null,
      room,
      credential: { ...credential, schemaVersion: '3' },
    })
    await expect(runRelayRemoteAdminAction('project-remote-admin', binding, action, 6, stringSchema.deps))
      .rejects.toThrow('malformed credential')

    const mismatchedRevision = dependencies({
      schemaVersion: 1,
      ok: true,
      error: null,
      room,
      credential: { ...credential, registryRevision: 6 },
    })
    await expect(runRelayRemoteAdminAction('project-remote-admin', binding, action, 6, mismatchedRevision.deps))
      .rejects.toThrow('does not match its room report')
  })

  it('sends an exact shared approval bundle and accepts the policy-aware room schema', async () => {
    const action = { kind: 'revoke' as const, memberId: 'x'.repeat(22) }
    const actionSha256 = await relayRemoteAdminActionSha256(action)
    const approvalKeyId = `ed25519-sha256:${'a'.repeat(43)}`
    const approval: ProjectRelayAdminApprovalProof = {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: approvalKeyId,
      publicKey: 'p'.repeat(43),
      claim: {
        schemaVersion: 1,
        projectId: 'project-remote-admin',
        roomId,
        expectedRevision: 6,
        actionSha256,
        approvedAtMs: 1_750_000_000_000,
        expiresAtMs: 1_750_003_600_000,
        approvalNonce: 'a'.repeat(43),
      },
      signature,
    }
    const policyRoom = {
      ...room,
      schemaVersion: 4 as const,
      adminPolicy: {
        schemaVersion: 1 as const,
        requiredApprovals: 1,
        configuredAtMs: 1_749_999_000_000,
        signerKeyIds: [approvalKeyId],
      },
    }
    const harness = dependencies({
      schemaVersion: 1, ok: true, error: null, room: policyRoom, credential: null,
    })
    await expect(runRelayRemoteAdminAction(
      'project-remote-admin', binding, action, 6, harness.deps, [approval],
    )).resolves.toEqual({ room: policyRoom, credential: null })
    expect(JSON.parse(harness.socket()!.sent).approvals).toEqual([approval])

    await expect(runRelayRemoteAdminAction(
      'project-remote-admin', binding, action, 6, harness.deps, [approval, approval],
    )).rejects.toThrow('approval bundle')
  })

  it('rejects a successful response for another project, revision transition, or action', async () => {
    const action = { kind: 'revoke' as const, memberId: 'x'.repeat(22) }
    await expect(runRelayRemoteAdminAction(
      'project-remote-admin', binding, action, 6,
      dependencies({ schemaVersion: 1, ok: true, error: null, room: { ...room, projectId: 'other-project' }, credential: null }).deps,
    )).rejects.toThrow('different project')
    await expect(runRelayRemoteAdminAction(
      'project-remote-admin', binding, action, 5,
      dependencies({ schemaVersion: 1, ok: true, error: null, room, credential: null }).deps,
    )).rejects.toThrow('expected revision transition')
    await expect(runRelayRemoteAdminAction(
      'project-remote-admin', binding, { kind: 'status' }, 0,
      dependencies({
        schemaVersion: 1,
        ok: true,
        error: null,
        room,
        credential: {
          schemaVersion: 3,
          roomId,
          memberId: 'v'.repeat(22),
          role: 'viewer',
          capability: 'z'.repeat(43),
          capabilityGeneration: 1,
          expiresAtMs: null,
          registryRevision: 7,
          deviceKeyId: keyId,
        },
      }).deps,
    )).rejects.toThrow('status unexpectedly returned a credential')
  })
})
