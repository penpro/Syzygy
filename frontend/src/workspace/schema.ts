import { normalizeWebsocketProjectBinding } from './websocketProjectBinding'

export const PROJECT_SCHEMA_VERSION = 1 as const

export type ProjectTransportBinding =
  | { kind: 'local' }
  | { kind: 'drive'; workspaceId: string }
  | { kind: 'websocket'; endpoint: string; roomId: string }

export interface ResearchProjectManifest {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  id: string
  title: string
  documentId: string
  createdAt: number
  updatedAt: number
  archivedAt?: number
  transport: ProjectTransportBinding
}

export function createProjectManifest(input: {
  id: string
  documentId: string
  title?: string
  timestamp: number
}): ResearchProjectManifest {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: input.id,
    title: input.title?.trim() || 'Untitled research project',
    documentId: input.documentId,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    transport: { kind: 'local' },
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isResearchProjectManifest(value: unknown): value is ResearchProjectManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ResearchProjectManifest>
  const transport = candidate.transport
  let validTransport = transport?.kind === 'local'
    || (transport?.kind === 'drive' && isNonEmptyString((transport as { workspaceId?: unknown }).workspaceId))
  if (transport?.kind === 'websocket') {
    const endpoint = (transport as { endpoint?: unknown }).endpoint
    const roomId = (transport as { roomId?: unknown }).roomId
    if (typeof endpoint === 'string' && typeof roomId === 'string') {
      try {
        const normalized = normalizeWebsocketProjectBinding({ endpoint, roomId })
        validTransport = normalized.endpoint === endpoint && normalized.roomId === roomId
      } catch {
        validTransport = false
      }
    } else {
      validTransport = false
    }
  }

  return (
    candidate.schemaVersion === PROJECT_SCHEMA_VERSION &&
    isNonEmptyString(candidate.id) &&
    typeof candidate.title === 'string' &&
    isNonEmptyString(candidate.documentId) &&
    isFiniteTimestamp(candidate.createdAt) &&
    isFiniteTimestamp(candidate.updatedAt) &&
    (candidate.archivedAt === undefined || isFiniteTimestamp(candidate.archivedAt)) &&
    validTransport
  )
}

/** Fail closed: unknown future schemas are not silently coerced into the current model. */
export function parseProjectManifest(value: unknown): ResearchProjectManifest {
  if (!isResearchProjectManifest(value)) throw new Error('Invalid or unsupported research project manifest')
  return value
}
