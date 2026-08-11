import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createProjectDocument } from './projectModel'
import type { ResearchProjectManifest } from './schema'
import {
  createManagedWebsocketProjectInvite,
  createWebsocketProjectInvite,
  parseWebsocketProjectInvite,
} from './websocketProjectInvite'
import { WebsocketProjectProvider } from './websocketProjectProvider'
import { getWebsocketProjectStatus } from './websocketProjectStatus'

const endpoint = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_ENDPOINT ?? ''
const roomId = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_ROOM ?? ''
const hostMember = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_HOST_MEMBER ?? ''
const hostCapability = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_HOST_CAPABILITY ?? ''
const guestMember = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_GUEST_MEMBER ?? ''
const guestCapability = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_GUEST_CAPABILITY ?? ''
const managed = Boolean(hostMember && hostCapability && guestMember && guestCapability)

const waitFor = async (predicate: () => boolean, label: string, timeoutMilliseconds = 10_000) => {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${label} did not complete within ${timeoutMilliseconds} ms`)
}

describe.skipIf(!endpoint || !roomId)('self-hosted product binding against a real relay', () => {
  it('round-trips an invite, synchronizes two providers, and reopens one client from IndexedDB', async () => {
    const hostManifest: ResearchProjectManifest = {
      schemaVersion: 1,
      id: `product-project-${roomId}`,
      documentId: `product-document-${roomId}`,
      title: 'Headless self-hosted product flow',
      createdAt: 1,
      updatedAt: 1,
      transport: {
        kind: 'websocket', endpoint, roomId,
        ...(managed ? {
          access: {
            schemaVersion: 1 as const,
            memberId: hostMember,
            capability: hostCapability,
            role: 'admin' as const,
          },
        } : {}),
      },
    }
    const invite = managed
      ? createManagedWebsocketProjectInvite(hostManifest, {
          schemaVersion: 1,
          roomId,
          memberId: guestMember,
          capability: guestCapability,
          role: 'editor',
        })
      : createWebsocketProjectInvite(hostManifest)
    const joinedManifest = parseWebsocketProjectInvite(invite)
    expect(joinedManifest.id).toBe(hostManifest.id)
    expect(joinedManifest.transport).toEqual(managed ? {
      kind: 'websocket', endpoint, roomId,
      access: {
        schemaVersion: 1,
        memberId: guestMember,
        capability: guestCapability,
        role: 'editor',
      },
    } : hostManifest.transport)
    if (hostManifest.transport.kind !== 'websocket' || joinedManifest.transport.kind !== 'websocket') {
      throw new Error('Product-flow invitation transport changed')
    }
    const hostBinding = hostManifest.transport
    const joinedBinding = joinedManifest.transport

    const docA = createProjectDocument(hostManifest)
    let docB: Y.Doc | null = createProjectDocument(joinedManifest)
    const storageA = `syzygy-product-flow-a:${roomId}`
    const storageB = `syzygy-product-flow-b:${roomId}`
    const providerA = new WebsocketProjectProvider(docA, hostBinding, hostManifest.id, storageA)
    let providerB: WebsocketProjectProvider | null = new WebsocketProjectProvider(
      docB, joinedBinding, joinedManifest.id, storageB,
    )
    providerA.connect()
    providerB.connect()
    try {
      await Promise.all([providerA.whenReady(), providerB.whenReady()])
      expect(getWebsocketProjectStatus(hostManifest.id)?.state).toBe('connected')

      docA.getMap('product-flow').set('host-edit', 'persisted-and-relayed')
      await waitFor(
        () => docB?.getMap('product-flow').get('host-edit') === 'persisted-and-relayed',
        'host-to-joiner product update',
      )
      await providerB.flush()
      await providerB.destroy()
      providerB = null
      docB.destroy()
      docB = null

      docB = createProjectDocument(joinedManifest)
      providerB = new WebsocketProjectProvider(docB, joinedBinding, joinedManifest.id, storageB)
      providerB.connect()
      await providerB.whenReady()
      expect(docB.getMap('product-flow').get('host-edit')).toBe('persisted-and-relayed')

      docB.getMap('product-flow').set('reopened-edit', 'returned-to-host')
      await waitFor(
        () => docA.getMap('product-flow').get('reopened-edit') === 'returned-to-host',
        'reopened joiner-to-host product update',
      )
    } finally {
      await providerB?.destroy()
      await providerA.destroy()
      docB?.destroy()
      docA.destroy()
    }
    expect(getWebsocketProjectStatus(hostManifest.id)).toBeNull()
  })
})
