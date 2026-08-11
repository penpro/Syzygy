import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { RelayAccessIdentityClaim, RelayAccessIdentityProof } from '../tauri'

const mocks = vi.hoisted(() => ({ instances: [] as unknown[] }))

vi.mock('y-websocket', () => {
  class MockWebsocketProvider {
    readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    shouldConnect = false
    connectCount = 0
    destroyed = false

    constructor(
      public readonly endpoint: string,
      public readonly roomId: string,
      _doc: unknown,
      public readonly options: { params: Record<string, string> },
    ) {
      mocks.instances.push(this)
    }

    on(type: string, listener: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(type) ?? new Set()
      listeners.add(listener)
      this.handlers.set(type, listeners)
    }

    off(type: string, listener: (...args: unknown[]) => void) {
      this.handlers.get(type)?.delete(listener)
    }

    emit(type: string, ...args: unknown[]) {
      this.handlers.get(type)?.forEach((listener) => listener(...args))
    }

    connect() {
      this.shouldConnect = true
      this.connectCount += 1
    }

    disconnect() {
      this.shouldConnect = false
    }

    destroy() {
      this.shouldConnect = false
      this.destroyed = true
    }
  }
  return { WebsocketProvider: MockWebsocketProvider }
})

vi.mock('./localProvider', () => ({
  LocalProjectProvider: class {
    connect() {}
    disconnect() {}
    async whenReady() {}
    async flush() {}
    async destroy() {}
  },
}))

import { WebsocketProjectProvider } from './websocketProjectProvider'

interface MockRemote {
  options: { params: Record<string, string> }
  connectCount: number
  shouldConnect: boolean
  destroyed: boolean
  emit(type: string, ...args: unknown[]): void
}

const roomId = `room_${'a'.repeat(40)}`
const access = {
  schemaVersion: 3 as const,
  memberId: `member_${'b'.repeat(24)}`,
  capability: 'c'.repeat(43),
  role: 'editor' as const,
  capabilityGeneration: 4,
  expiresAtMs: null,
  deviceKeyId: `ed25519-sha256:${'d'.repeat(43)}`,
}

function proof(claim: RelayAccessIdentityClaim): RelayAccessIdentityProof {
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: access.deviceKeyId,
    claim,
    signature: 's'.repeat(86),
  }
}

afterEach(() => {
  mocks.instances.length = 0
})

describe('device-bound WebSocket provider authorization', () => {
  it('signs a fresh bounded claim for each physical reconnect instead of replaying a query', async () => {
    const claims: RelayAccessIdentityClaim[] = []
    const provider = new WebsocketProjectProvider(
      new Y.Doc({ guid: 'signed-provider-doc' }),
      { endpoint: 'ws://192.168.1.20:1234', roomId, access },
      'signed-provider-project',
      'signed-provider-storage',
      async (claim) => {
        claims.push(claim)
        return proof(claim)
      },
    )
    provider.connect()
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))
    const first = mocks.instances[0] as MockRemote
    expect(first.connectCount).toBe(1)
    expect(first.options.params).toEqual({
      member: access.memberId,
      capability: access.capability,
      generation: '4',
      issued: String(claims[0].issuedAtMs),
      nonce: claims[0].nonce,
      signature: 's'.repeat(86),
    })
    expect(first.options.params).not.toHaveProperty('deviceKeyId')

    first.emit('connection-close', null, first)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2))
    const second = mocks.instances[1] as MockRemote
    expect(first.destroyed).toBe(true)
    expect(first.shouldConnect).toBe(false)
    expect(second.connectCount).toBe(1)
    expect(claims).toHaveLength(2)
    expect(claims[1].nonce).not.toBe(claims[0].nonce)
    expect(second.options.params.nonce).toBe(claims[1].nonce)
    await provider.destroy()
  })

  it('fails visibly before opening a socket when the local installation key does not match', async () => {
    const statuses: unknown[] = []
    const provider = new WebsocketProjectProvider(
      new Y.Doc({ guid: 'wrong-device-doc' }),
      { endpoint: 'ws://192.168.1.20:1234', roomId, access },
      'wrong-device-project',
      'wrong-device-storage',
      async (claim) => ({ ...proof(claim), keyId: `ed25519-sha256:${'x'.repeat(43)}` }),
    )
    provider.on('status', (status) => statuses.push(status))
    provider.connect()
    await vi.waitFor(() => expect(statuses).toContainEqual({
      status: 'error',
      error: 'This installation does not match the device key enrolled for this relay member',
    }))
    expect(mocks.instances).toHaveLength(0)
    await provider.destroy()
  })
})
