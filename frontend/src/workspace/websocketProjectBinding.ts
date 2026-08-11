const MAX_ENDPOINT_LENGTH = 2_048
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export interface WebsocketProjectBinding {
  endpoint: string
  roomId: string
}

export interface NormalizedWebsocketProjectBinding extends WebsocketProjectBinding {
  endpoint: string
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 127
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '[::1]'
    || normalized.endsWith('.local')
    || isPrivateIpv4(normalized)
}

/**
 * Plaintext WebSockets are accepted only on loopback/private LAN hosts. Secrets, query
 * parameters, fragments, and embedded credentials never enter a persisted project binding.
 */
export function normalizeWebsocketProjectBinding(
  value: WebsocketProjectBinding,
): NormalizedWebsocketProjectBinding {
  if (typeof value.endpoint !== 'string' || value.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('WebSocket collaboration endpoint is missing or too long')
  }
  let endpoint: URL
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    throw new Error('WebSocket collaboration endpoint is invalid')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error('WebSocket collaboration endpoint must use ws:// or wss://')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WebSocket collaboration endpoint cannot contain credentials, query parameters, or fragments')
  }
  if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
    throw new Error('WebSocket collaboration endpoint cannot contain a room path')
  }
  if (endpoint.protocol === 'ws:' && !isPrivateHostname(endpoint.hostname)) {
    throw new Error('Plaintext WebSocket collaboration is limited to loopback or private LAN hosts')
  }
  if (!ROOM_ID_PATTERN.test(value.roomId)) {
    throw new Error('WebSocket collaboration room ID must be 32-128 URL-safe characters')
  }
  return {
    endpoint: endpoint.origin,
    roomId: value.roomId,
  }
}

export function createWebsocketRoomId(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
