import { parseProjectManifest, type ResearchProjectManifest } from './schema'

export const WEBSOCKET_PROJECT_INVITE_PREFIX = 'syzygy-websocket-invite-v1.'
export const MAX_WEBSOCKET_PROJECT_INVITE_LENGTH = 6_000
const MAX_MANIFEST_ID_LENGTH = 200
const MAX_TITLE_LENGTH = 200
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

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

function normalizedInviteManifest(value: unknown): ResearchProjectManifest {
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

export function createWebsocketProjectInvite(project: ResearchProjectManifest): string {
  const manifest = normalizedInviteManifest(project)
  return WEBSOCKET_PROJECT_INVITE_PREFIX + encodeBase64Url(JSON.stringify(manifest))
}

export function parseWebsocketProjectInvite(value: string): ResearchProjectManifest {
  const invite = value.trim()
  if (!invite.startsWith(WEBSOCKET_PROJECT_INVITE_PREFIX) || invite.length > MAX_WEBSOCKET_PROJECT_INVITE_LENGTH) {
    throw new Error('Self-hosted project invitation is invalid or too long')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(invite.slice(WEBSOCKET_PROJECT_INVITE_PREFIX.length)))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Self-hosted project invitation')) throw error
    throw new Error('Self-hosted project invitation is malformed')
  }
  return normalizedInviteManifest(decoded)
}
