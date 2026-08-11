import { parseProjectManifest, type ResearchProjectManifest } from './schema'
import {
  normalizeWebsocketProjectBinding,
  type ManagedRelayAccess,
  type ManagedRelayAccessV1,
  type ManagedRelayAccessV2,
  type ManagedRelayAccessV3,
} from './websocketProjectBinding'

export const WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v1.'
export const MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v2.'
export const EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v3.'
export const DEVICE_BOUND_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v4.'
export const MAX_WEBSOCKET_PROJECT_INVITE_LENGTH = 6_000
const MAX_MANIFEST_ID_LENGTH = 200
const MAX_TITLE_LENGTH = 200
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export type ManagedRelayInviteCredential = ManagedRelayAccess & { roomId: string }

interface ManagedRelayInviteEnvelopeV2 {
  schemaVersion: 2
  project: ResearchProjectManifest
  access: ManagedRelayAccessV1
}

interface ManagedRelayInviteEnvelopeV3 {
  schemaVersion: 3
  project: ResearchProjectManifest
  access: ManagedRelayAccessV2
}

interface ManagedRelayInviteEnvelopeV4 {
  schemaVersion: 4
  project: ResearchProjectManifest
  access: ManagedRelayAccessV3
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function encodeBase64Url(value: string): string {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Self-hosted project invitation is malformed')
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - standard.length % 4) % 4)
  let binary: string
  try {
    binary = atob(standard + padding)
  } catch {
    throw new Error('Self-hosted project invitation is malformed')
  }
  return decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

function normalizedBaseManifest(value: unknown): ResearchProjectManifest {
  const manifest = parseProjectManifest(value)
  if (manifest.archivedAt !== undefined || manifest.transport.kind !== 'websocket') {
    throw new Error('Self-hosted project invitation must describe an active WebSocket project')
  }
  if (!exactKeys(manifest, ['schemaVersion', 'id', 'title', 'documentId', 'createdAt', 'updatedAt', 'transport'])) {
    throw new Error('Self-hosted project invitation contains unsupported fields')
  }
  if (!exactKeys(manifest.transport, ['kind', 'endpoint', 'roomId'])) {
    throw new Error('Self-hosted project invitation transport is malformed')
  }
  if (manifest.id.length > MAX_MANIFEST_ID_LENGTH || manifest.documentId.length > MAX_MANIFEST_ID_LENGTH) {
    throw new Error('Self-hosted project invitation identity exceeds the size limit')
  }
  if (manifest.title.length > MAX_TITLE_LENGTH) {
    throw new Error('Self-hosted project invitation title exceeds the size limit')
  }
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    title: manifest.title,
    documentId: manifest.documentId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    transport: { ...manifest.transport },
  }
}

function withoutAccess(project: ResearchProjectManifest): ResearchProjectManifest {
  if (project.transport.kind !== 'websocket') return project
  return {
    ...project,
    transport: {
      kind: 'websocket',
      endpoint: project.transport.endpoint,
      roomId: project.transport.roomId,
    },
  }
}

function parseEncoded(prefix: string, invite: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(invite.slice(prefix.length)))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Self-hosted project invitation')) throw error
    throw new Error('Self-hosted project invitation is malformed')
  }
}

export function createWebsocketProjectInvite(project: ResearchProjectManifest): string {
  if (project.transport.kind === 'websocket' && project.transport.access) {
    throw new Error('Issue a separate managed relay member invitation; do not share the current member credential')
  }
  const manifest = normalizedBaseManifest(project)
  return WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(manifest))
}

export function createManagedWebsocketProjectInvite(
  project: ResearchProjectManifest,
  credential: ManagedRelayInviteCredential,
): string {
  if (!credential || typeof credential !== 'object') {
    throw new Error('Managed relay member credential is malformed')
  }
  const expectedCredentialKeys = credential.schemaVersion === 1
    ? ['schemaVersion', 'roomId', 'memberId', 'capability', 'role']
    : credential.schemaVersion === 2
      ? ['schemaVersion', 'roomId', 'memberId', 'capability', 'role', 'capabilityGeneration', 'expiresAtMs']
      : ['schemaVersion', 'roomId', 'memberId', 'capability', 'role', 'capabilityGeneration', 'expiresAtMs', 'deviceKeyId']
  if (![1, 2, 3].includes(credential.schemaVersion) || !exactKeys(credential, expectedCredentialKeys)) {
    throw new Error('Managed relay member credential is malformed')
  }
  const manifest = normalizedBaseManifest(withoutAccess(project))
  if (manifest.transport.kind !== 'websocket') {
    throw new Error('Managed relay invitation transport is malformed')
  }
  const transport = manifest.transport
  if (credential.roomId !== transport.roomId) {
    throw new Error('Managed relay member credential belongs to a different room')
  }
  const access: ManagedRelayAccess = credential.schemaVersion === 1 ? {
    schemaVersion: 1,
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
  } : credential.schemaVersion === 2 ? {
    schemaVersion: 2,
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
    capabilityGeneration: credential.capabilityGeneration,
    expiresAtMs: credential.expiresAtMs,
  } : {
    schemaVersion: 3,
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
    capabilityGeneration: credential.capabilityGeneration,
    expiresAtMs: credential.expiresAtMs,
    deviceKeyId: credential.deviceKeyId,
  }
  const binding = normalizeWebsocketProjectBinding({
    endpoint: transport.endpoint,
    roomId: transport.roomId,
    access,
  })
  if (!binding.access) throw new Error('Managed relay member credential is missing')
  if (binding.access.schemaVersion === 1) {
    const envelope: ManagedRelayInviteEnvelopeV2 = {
      schemaVersion: 2,
      project: manifest,
      access: binding.access,
    }
    return MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(envelope))
  }
  if (binding.access.schemaVersion === 2) {
    const envelope: ManagedRelayInviteEnvelopeV3 = {
      schemaVersion: 3,
      project: manifest,
      access: binding.access,
    }
    return EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(envelope))
  }
  const envelope: ManagedRelayInviteEnvelopeV4 = {
    schemaVersion: 4,
    project: manifest,
    access: binding.access,
  }
  return DEVICE_BOUND_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(envelope))
}

function parseManagedInvite(value: unknown, expectedVersion: 2 | 3 | 4): ResearchProjectManifest {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['schemaVersion', 'project', 'access'])) {
    throw new Error('Managed relay invitation contains unsupported fields')
  }
  const envelope = value as Partial<
    ManagedRelayInviteEnvelopeV2 | ManagedRelayInviteEnvelopeV3 | ManagedRelayInviteEnvelopeV4
  >
  if (envelope.schemaVersion !== expectedVersion || !envelope.access || !envelope.project ||
    envelope.access.schemaVersion !== expectedVersion - 1) {
    throw new Error('Managed relay invitation is malformed')
  }
  const project = normalizedBaseManifest(envelope.project)
  if (project.transport.kind !== 'websocket') {
    throw new Error('Managed relay invitation transport is malformed')
  }
  const binding = normalizeWebsocketProjectBinding({ ...project.transport, access: envelope.access })
  if (!binding.access) throw new Error('Managed relay invitation is missing member access')
  return {
    ...project,
    transport: { kind: 'websocket', ...binding },
  }
}

export function parseWebsocketProjectInvite(value: string): ResearchProjectManifest {
  const invite = value.trim()
  if (invite.length > MAX_WEBSOCKET_PROJECT_INVITE_LENGTH) {
    throw new Error('Self-hosted project invitation is invalid or too long')
  }
  if (invite.startsWith(DEVICE_BOUND_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return parseManagedInvite(parseEncoded(DEVICE_BOUND_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX, invite), 4)
  }
  if (invite.startsWith(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return parseManagedInvite(parseEncoded(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX, invite), 2)
  }
  if (invite.startsWith(EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return parseManagedInvite(parseEncoded(EXPIRING_MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX, invite), 3)
  }
  if (invite.startsWith(WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return normalizedBaseManifest(parseEncoded(WEBSOCKET_PROJECT_INVITE_PREFIX, invite))
  }
  throw new Error('Self-hosted project invitation is invalid or too long')
}
