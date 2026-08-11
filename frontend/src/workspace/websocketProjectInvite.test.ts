import { describe, expect, it } from 'vitest'
import type { ResearchProjectManifest } from './schema'
import {
  createWebsocketProjectInvite,
  MAX_WEBSOCKET_PROJECT_INVITE_LENGTH,
  parseWebsocketProjectInvite,
  WEBSOCKET_PROJECT_INVITE_PREFIX,
} from './websocketProjectInvite'

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

  it('rejects malformed, oversized, archived, non-WebSocket, and extra-field invitations', () => {
    expect(() => parseWebsocketProjectInvite('not-an-invite')).toThrow('invalid or too long')
    expect(() => parseWebsocketProjectInvite(
      WEBSOCKET_PROJECT_INVITE_PREFIX + 'a'.repeat(MAX_WEBSOCKET_PROJECT_INVITE_LENGTH),
    )).toThrow('invalid or too long')
    expect(() => createWebsocketProjectInvite({ ...project, archivedAt: 30 })).toThrow('active WebSocket')
    expect(() => createWebsocketProjectInvite({ ...project, transport: { kind: 'local' } })).toThrow('active WebSocket')
    expect(() => createWebsocketProjectInvite({ ...project, unexpected: true } as ResearchProjectManifest))
      .toThrow('unsupported fields')
  })

  it('returns detached binding state', () => {
    const decoded = parseWebsocketProjectInvite(createWebsocketProjectInvite(project))
    if (decoded.transport.kind !== 'websocket') throw new Error('fixture transport changed')
    decoded.transport.endpoint = 'ws://127.0.0.1:1234'
    expect(project.transport).toMatchObject({ endpoint: 'ws://192.168.1.20:1234' })
  })
})
