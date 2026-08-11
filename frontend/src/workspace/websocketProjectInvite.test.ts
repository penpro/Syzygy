import { describe, expect, it } from 'vitest'
import type { ResearchProjectManifest } from './schema'
import {
  createManagedWebsocketProjectInvite,
  createWebsocketProjectInvite,
  EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX,
  MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX,
  MAX_WEBSOCKET_PROJECT_INVITE_LENGTH,
  parseWebsocketProjectInvite,
  WEBSOCKET_PROJECT_INVITE_PREFIX,
} from './websocketProjectInvite'

const credential = {
  schemaVersion: 1 as const,
  roomId: 'room_' + 'a'.repeat(40),
  memberId: 'member_' + 'b'.repeat(24),
  capability: 'c'.repeat(43),
  role: 'viewer' as const,
}

const expiringCredential = {
  schemaVersion: 2 as const,
  roomId: credential.roomId,
  memberId: 'member_' + 'd'.repeat(24),
  capability: 'e'.repeat(43),
  role: 'editor' as const,
  capabilityGeneration: 3,
  expiresAtMs: 2_000_000_000_000,
}

const project: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'self-hosted-project',
  documentId: 'self-hosted-document',
  title: 'Shared policy — café',
  createdAt: 10,
  updatedAt: 20,
  transport: {
    kind: 'websocket',
    endpoint: 'ws://192.168.1.20:1234',
    roomId: 'room_' + 'a'.repeat(40),
  },
}

describe('self-hosted project invitations', () => {
  it('round-trips exact project identity, Unicode title, endpoint, and bearer room', () => {
    const invite = createWebsocketProjectInvite(project)
    expect(invite.startsWith(WEBSOCKET_PROJECT_INVITE_PREFIX)).toBe(true)
    expect(parseWebsocketProjectInvite(invite)).toEqual(project)
  })

  it('round-trips a separate managed member credential without exposing the host credential', () => {
    const invite = createManagedWebsocketProjectInvite(project, credential)
    expect(invite.startsWith(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)).toBe(true)
    expect(parseWebsocketProjectInvite(invite)).toEqual({
      ...project,
      transport: {
        ...project.transport,
        access: {
          schemaVersion: 1,
          memberId: credential.memberId,
          capability: credential.capability,
          role: 'viewer',
        },
      },
    })
    const host = {
      ...project,
      transport: {
        ...project.transport,
        access: { ...credential, roomId: undefined },
      },
    } as unknown as ResearchProjectManifest
    expect(() => createWebsocketProjectInvite(host)).toThrow('separate managed relay member')
    expect(() => createManagedWebsocketProjectInvite(project, { ...credential, roomId: 'x'.repeat(32) }))
      .toThrow('different room')
  })

  it('round-trips a v3 expiring rotated credential while retaining v2 invite compatibility', () => {
    const invite = createManagedWebsocketProjectInvite(project, expiringCredential)
    expect(invite.startsWith(EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)).toBe(true)
    expect(parseWebsocketProjectInvite(invite)).toEqual({
      ...project,
      transport: {
        ...project.transport,
        access: {
          schemaVersion: 2,
          memberId: expiringCredential.memberId,
          capability: expiringCredential.capability,
          role: 'editor',
          capabilityGeneration: 3,
          expiresAtMs: expiringCredential.expiresAtMs,
        },
      },
    })
    expect(parseWebsocketProjectInvite(createManagedWebsocketProjectInvite(project, credential))
      .transport).toMatchObject({ access: { schemaVersion: 1 } })
    expect(() => createManagedWebsocketProjectInvite(project, {
      ...expiringCredential,
      capabilityGeneration: 0,
    })).toThrow('malformed')
    expect(() => createManagedWebsocketProjectInvite(project, {
      ...expiringCredential,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    })).toThrow('malformed')
  })

  it('rejects malformed, oversized, archived, non-WebSocket, and extra-field invitations', () => {
    expect(() => parseWebsocketProjectInvite('not-an-invite')).toThrow('invalid or too long')
    expect(() => parseWebsocketProjectInvite(
      WEBSOCKET_PROJECT_INVITE_PREFIX + 'a'.repeat(MAX_WEBSOCKET_PROJECT_INVITE_LENGTH),
    )).toThrow('invalid or too long')
    expect(() => createWebsocketProjectInvite({ ...project, archivedAt: 30 })).toThrow('active WebSocket')
    expect(() => createWebsocketProjectInvite({ ...project, transport: { kind: 'local' } })).toThrow('active WebSocket')
    expect(() => createWebsocketProjectInvite({ ...project, unexpected: true } as ResearchProjectManifest))
      .toThrow('unsupported fields')
    expect(() => createManagedWebsocketProjectInvite(project, {
      ...credential,
      unexpected: true,
    } as typeof credential)).toThrow('malformed')
    expect(() => parseWebsocketProjectInvite(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX + 'e30'))
      .toThrow('unsupported fields')
  })

  it('returns detached binding state', () => {
    const decoded = parseWebsocketProjectInvite(createWebsocketProjectInvite(project))
    if (decoded.transport.kind !== 'websocket') throw new Error('fixture transport changed')
    decoded.transport.endpoint = 'ws://127.0.0.1:1234'
    expect(project.transport).toMatchObject({ endpoint: 'ws://192.168.1.20:1234' })
  })
})
