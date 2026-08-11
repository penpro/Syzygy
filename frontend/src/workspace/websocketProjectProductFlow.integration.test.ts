import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { RelayAccessIdentityClaim, RelayAccessIdentityProof } from '../tauri'
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
const capabilityGeneration = Number(import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_CAPABILITY_GENERATION ?? 0)
const expiresAtMs = Number(import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_EXPIRES_AT_MS ?? 0)
const hostDeviceKeyId = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_HOST_DEVICE_KEY_ID ?? ''
const hostPrivateKey = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_HOST_PRIVATE_KEY ?? ''
const guestDeviceKeyId = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_GUEST_DEVICE_KEY_ID ?? ''
const guestPrivateKey = import.meta.env.VITE_SYZYGY_WEBSOCKET_TEST_GUEST_PRIVATE_KEY ?? ''
const managedV3 = managed && Number.isSafeInteger(capabilityGeneration) && capabilityGeneration > 0 &&
  Number.isSafeInteger(expiresAtMs) && expiresAtMs > Date.now()
const managedV4 = managedV3 && Boolean(
  hostDeviceKeyId && hostPrivateKey && guestDeviceKeyId && guestPrivateKey,
)

function relaySigner(keyId: string, privateKeyDer: string) {
  const standard = privateKeyDer.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const key = crypto.subtle.importKey('pkcs8', bytes as BufferSource, { name: 'Ed25519' }, false, ['sign'])
  return async (claim: RelayAccessIdentityClaim): Promise<RelayAccessIdentityProof> => {
    const signatureBytes = new Uint8Array(await crypto.subtle.sign(
      { name: 'Ed25519' },
      await key,
      new TextEncoder().encode([
      'syzygy-relay-member-access-v1',
      claim.roomId,
      claim.memberId,
      claim.capabilityGeneration,
      claim.issuedAtMs,
      claim.nonce,
      claim.capability,
      ].join('\n')),
    ))
    let signature = ''
    for (const byte of signatureBytes) signature += String.fromCharCode(byte)
    return {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId,
      claim,
      signature: btoa(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    }
  }
}

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
          access: managedV4 ? {
            schemaVersion: 3 as const,
            memberId: hostMember,
            capability: hostCapability,
            role: 'admin' as const,
            capabilityGeneration,
            expiresAtMs,
            deviceKeyId: hostDeviceKeyId,
          } : managedV3 ? {
            schemaVersion: 2 as const,
            memberId: hostMember,
            capability: hostCapability,
            role: 'admin' as const,
            capabilityGeneration,
            expiresAtMs,
          } : {
            schemaVersion: 1 as const,
            memberId: hostMember,
            capability: hostCapability,
            role: 'admin' as const,
          },
        } : {}),
      },
    }
    const invite = managed
      ? createManagedWebsocketProjectInvite(hostManifest, managedV4 ? {
          schemaVersion: 3,
          roomId,
          memberId: guestMember,
          capability: guestCapability,
          role: 'editor',
          capabilityGeneration,
          expiresAtMs,
          deviceKeyId: guestDeviceKeyId,
        } : managedV3 ? {
          schemaVersion: 2,
          roomId,
          memberId: guestMember,
          capability: guestCapability,
          role: 'editor',
          capabilityGeneration,
          expiresAtMs,
        } : {
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
      access: managedV4 ? {
        schemaVersion: 3,
        memberId: guestMember,
        capability: guestCapability,
        role: 'editor',
        capabilityGeneration,
        expiresAtMs,
        deviceKeyId: guestDeviceKeyId,
      } : managedV3 ? {
        schemaVersion: 2,
        memberId: guestMember,
        capability: guestCapability,
        role: 'editor',
        capabilityGeneration,
        expiresAtMs,
      } : {
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
    const providerA = new WebsocketProjectProvider(
      docA,
      hostBinding,
      hostManifest.id,
      storageA,
      managedV4 ? relaySigner(hostDeviceKeyId, hostPrivateKey) : undefined,
    )
    let providerB: WebsocketProjectProvider | null = new WebsocketProjectProvider(
      docB,
      joinedBinding,
      joinedManifest.id,
      storageB,
      managedV4 ? relaySigner(guestDeviceKeyId, guestPrivateKey) : undefined,
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
      providerB = new WebsocketProjectProvider(
        docB,
        joinedBinding,
        joinedManifest.id,
        storageB,
        managedV4 ? relaySigner(guestDeviceKeyId, guestPrivateKey) : undefined,
      )
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
