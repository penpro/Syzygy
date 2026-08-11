import { parseProjectManifest, type ResearchProjectManifest } from './schema'
import {
  normalizeWebsocketProjectBinding,
  type ManagedRelayAccess,
} from './websocketProjectBinding'

export const WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v1.'
export const MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v2.'
export const MAX_WEBSOCKET_PROJECT_INVITE_LENGTH = 6_000
const MAX_MANIFEST_ID_LENGTH = 200
const MAX_TITLE_LENGTH = 200
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export interface ManagedRelayInviteCredential extends ManagedRelayAccess {
  roomId: string
}

interface ManagedRelayInviteEnvelope {
  schemaVersion: 2
  project: ResearchProjectManifest
  access: ManagedRelayAccess
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
  if (!credential || typeof credential !== 'object' || !exactKeys(credential, [
    'schemaVersion', 'roomId', 'memberId', 'capability', 'role',
  ])) {
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
  const access: ManagedRelayAccess = {
    schemaVersion: credential.schemaVersion,
    memberId: credential.memberId,
    capability: credential.capability,
    role: credential.role,
  }
  const binding = normalizeWebsocketProjectBinding({
    endpoint: transport.endpoint,
    roomId: transport.roomId,
    access,
  })
  if (!binding.access) throw new Error('Managed relay member credential is missing')
  const envelope: ManagedRelayInviteEnvelope = {
    schemaVersion: 2,
    project: manifest,
    access: binding.access,
  }
  return MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(envelope))
}

function parseManagedInvite(value: unknown): ResearchProjectManifest {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['schemaVersion', 'project', 'access'])) {
    throw new Error('Managed relay invitation contains unsupported fields')
  }
  const envelope = value as Partial<ManagedRelayInviteEnvelope>
  if (envelope.schemaVersion !== 2 || !envelope.access || !envelope.project) {
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
  if (invite.startsWith(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return parseManagedInvite(parseEncoded(MANAGED_WEBSOCKET_PROJECT_INVITE_PREFIX, invite))
  }
  if (invite.startsWith(WEBSOCKET_PROJECT_INVITE_PREFIX)) {
    return normalizedBaseManifest(parseEncoded(WEBSOCKET_PROJECT_INVITE_PREFIX, invite))
  }
  throw new Error('Self-hosted project invitation is invalid or too long')
}
