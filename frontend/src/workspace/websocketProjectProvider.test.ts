import { describe, expect, it } from 'vitest'
import {
  isRelayDocumentWritePayload,
  normalizeWebsocketProjectBinding,
  WEBSOCKET_PROVIDER_CAPABILITIES,
} from './websocketProjectProvider'

const roomId = 'room_' + 'a'.repeat(40)

describe('self-hosted WebSocket project binding', () => {
  it('declares live awareness plus local durability without claiming relay persistence', () => {
    expect(WEBSOCKET_PROVIDER_CAPABILITIES).toEqual({
      realtime: true,
      awareness: true,
      durableLocal: true,
      remotePersistence: false,
      attachments: false,
    })
  })

  it('normalizes TLS and private-LAN endpoints without persisting a room path', () => {
    expect(normalizeWebsocketProjectBinding({ endpoint: 'wss://collab.example.test/', roomId }))
      .toEqual({ endpoint: 'wss://collab.example.test', roomId })
    expect(normalizeWebsocketProjectBinding({ endpoint: 'ws://192.168.10.24:1234', roomId }))
      .toEqual({ endpoint: 'ws://192.168.10.24:1234', roomId })
    expect(normalizeWebsocketProjectBinding({ endpoint: 'ws://localhost:1234/', roomId }))
      .toEqual({ endpoint: 'ws://localhost:1234', roomId })
  })

  it('keeps a strict member credential separate from the endpoint and room path', () => {
    const access = {
      schemaVersion: 1 as const,
      memberId: 'member_' + 'b'.repeat(24),
      capability: 'c'.repeat(43),
      role: 'viewer' as const,
    }
    expect(normalizeWebsocketProjectBinding({
      endpoint: 'ws://192.168.10.24:1234/', roomId, access,
    })).toEqual({ endpoint: 'ws://192.168.10.24:1234', roomId, access })
    expect(() => normalizeWebsocketProjectBinding({
      endpoint: 'ws://192.168.10.24:1234', roomId, access: { ...access, capability: 'short' },
    })).toThrow('member access')
    expect(() => normalizeWebsocketProjectBinding({
      endpoint: 'ws://192.168.10.24:1234', roomId,
      access: { ...access, unexpected: true } as typeof access,
    })).toThrow('member access')
  })

  it('rejects public plaintext, embedded authority, and weak room identities', () => {
    for (const endpoint of [
      'http://localhost:1234',
      'ws://example.test:1234',
      'wss://user:secret@example.test',
      'wss://example.test?token=secret',
      'wss://example.test/room-already-here',
    ]) {
      expect(() => normalizeWebsocketProjectBinding({ endpoint, roomId })).toThrow()
    }
    expect(() => normalizeWebsocketProjectBinding({ endpoint: 'wss://example.test', roomId: 'short' }))
      .toThrow('32-128')
  })

  it('accepts every RFC1918 range and refuses lookalike addresses', () => {
    for (const endpoint of [
      'ws://10.0.0.1:1234',
      'ws://172.16.0.1:1234',
      'ws://172.31.255.254:1234',
      'ws://192.168.255.254:1234',
      'ws://[::1]:1234',
      'ws://relay.local:1234',
    ]) {
      expect(() => normalizeWebsocketProjectBinding({ endpoint, roomId })).not.toThrow()
    }
    for (const endpoint of [
      'ws://172.15.0.1:1234',
      'ws://172.32.0.1:1234',
      'ws://192.169.0.1:1234',
      'ws://10.example.test:1234',
    ]) {
      expect(() => normalizeWebsocketProjectBinding({ endpoint, roomId })).toThrow('private LAN')
    }
  })

  it('classifies only outbound document sync updates for viewer transport filtering', () => {
    expect(isRelayDocumentWritePayload(new Uint8Array([0, 1, 2, 0, 0]))).toBe(true)
    expect(isRelayDocumentWritePayload(new Uint8Array([0, 2, 1, 0]))).toBe(true)
    expect(isRelayDocumentWritePayload(new Uint8Array([0, 0, 1, 0]))).toBe(false)
    expect(isRelayDocumentWritePayload(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isRelayDocumentWritePayload('not a binary protocol frame')).toBe(false)
  })
})
