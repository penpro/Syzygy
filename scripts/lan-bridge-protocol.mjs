import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'

export const LAN_PROTOCOL = 'syzygy-lan-v1'
export const DEFAULT_PORT = 37663
export const HEARTBEAT_MS = 15_000
export const STALE_AFTER_MS = 45_000
export const MAX_REQUEST_MS = 60_000
export const DEFAULT_REQUEST_MS = 20_000
export const MAX_LINE_BYTES = 12 * 1024 * 1024
export const MAX_HANDSHAKE_BYTES = 8 * 1024

const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function parseCli(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options.set(flag, true)
    } else {
      const existing = options.get(flag)
      if (existing === undefined) options.set(flag, value)
      else options.set(flag, Array.isArray(existing) ? [...existing, value] : [existing, value])
      index += 1
    }
  }
  return options
}

export function option(options, name, fallback = undefined) {
  const value = options.get(name)
  if (Array.isArray(value)) return value.at(-1)
  return value === undefined ? fallback : value
}

export function requiredOption(options, name) {
  const value = option(options, name)
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

export function integerOption(options, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = option(options, name, String(fallback))
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function isPrivateListenAddress(address) {
  if (isIP(address) !== 4) return false
  const octets = address.split('.').map(Number)
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
}
export function assertNodeId(nodeId) {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error('node ID must be 1-64 characters using letters, numbers, dot, underscore, or dash')
  }
  return nodeId
}

export function loadPairingKey(path) {
  const raw = readFileSync(path, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    throw new Error('pairing key file must contain one 32-byte base64url key')
  }
  const key = Buffer.from(raw, 'base64url')
  if (key.length !== 32) throw new Error('pairing key must decode to exactly 32 bytes')
  return key
}

export function createPairingKey() {
  return randomBytes(32).toString('base64url')
}

function proofPayload(nodeId, serverNonce, clientNonce) {
  return Buffer.concat([
    Buffer.from(`agent\0${LAN_PROTOCOL}\0${nodeId}\0`, 'utf8'),
    serverNonce,
    Buffer.from('\0', 'utf8'),
    clientNonce,
  ])
}

export function createAgentProof(key, nodeId, serverNonce, clientNonce) {
  return createHmac('sha256', key).update(proofPayload(nodeId, serverNonce, clientNonce)).digest()
}

export function verifyAgentProof(key, nodeId, serverNonce, clientNonce, candidate) {
  const expected = createAgentProof(key, nodeId, serverNonce, clientNonce)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export function deriveSessionKeys(key, nodeId, serverNonce, clientNonce) {
  const bytes = Buffer.from(hkdfSync(
    'sha256',
    key,
    Buffer.concat([serverNonce, clientNonce]),
    Buffer.from(`${LAN_PROTOCOL}\0${nodeId}`, 'utf8'),
    64,
  ))
  return { agentToServer: bytes.subarray(0, 32), serverToAgent: bytes.subarray(32, 64) }
}

function aad(nodeId, direction, sequence) {
  return Buffer.from(`${LAN_PROTOCOL}\0${nodeId}\0${direction}\0${sequence}`, 'utf8')
}

export class SecureChannel {
  constructor({ nodeId, sendKey, receiveKey, sendDirection, receiveDirection }) {
    this.nodeId = nodeId
    this.sendKey = sendKey
    this.receiveKey = receiveKey
    this.sendDirection = sendDirection
    this.receiveDirection = receiveDirection
    this.sendSequence = 0
    this.receiveSequence = 0
  }

  encode(message) {
    this.sendSequence += 1
    const sequence = this.sendSequence
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, nonce)
    cipher.setAAD(aad(this.nodeId, this.sendDirection, sequence))
    const plaintext = Buffer.from(JSON.stringify(message), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const frame = {
      sequence,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    }
    const encoded = JSON.stringify(frame)
    if (Buffer.byteLength(encoded) > MAX_LINE_BYTES) throw new Error('encrypted LAN frame exceeds the size limit')
    return encoded
  }

  decode(line) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('encrypted LAN frame exceeds the size limit')
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      throw new Error('encrypted LAN frame is not valid JSON')
    }
    const expectedSequence = this.receiveSequence + 1
    if (frame?.sequence !== expectedSequence) {
      throw new Error(`encrypted LAN frame sequence mismatch: expected ${expectedSequence}`)
    }
    const nonce = Buffer.from(frame?.nonce ?? '', 'base64url')
    const ciphertext = Buffer.from(frame?.ciphertext ?? '', 'base64url')
    const tag = Buffer.from(frame?.tag ?? '', 'base64url')
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('encrypted LAN frame has invalid cryptographic fields')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, nonce)
      decipher.setAAD(aad(this.nodeId, this.receiveDirection, expectedSequence))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const message = JSON.parse(plaintext.toString('utf8'))
      this.receiveSequence = expectedSequence
      return message
    } catch {
      throw new Error('encrypted LAN frame authentication failed')
    }
  }
}

export function createServerChannel(nodeId, keys) {
  return new SecureChannel({
    nodeId,
    sendKey: keys.serverToAgent,
    receiveKey: keys.agentToServer,
    sendDirection: 'server-to-agent',
    receiveDirection: 'agent-to-server',
  })
}

export function createAgentChannel(nodeId, keys) {
  return new SecureChannel({
    nodeId,
    sendKey: keys.agentToServer,
    receiveKey: keys.serverToAgent,
    sendDirection: 'agent-to-server',
    receiveDirection: 'server-to-agent',
  })
}

export function lineReader(stream, { maxBytes = MAX_LINE_BYTES, onLine, onError }) {
  let buffer = Buffer.alloc(0)
  const data = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > maxBytes && !buffer.includes(0x0a)) {
      onError(new Error('LAN line exceeds the size limit'))
      return
    }
    for (;;) {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) break
      const line = buffer.subarray(0, newline).toString('utf8').trim()
      buffer = buffer.subarray(newline + 1)
      if (line) onLine(line)
    }
  }
  stream.on('data', data)
  return () => stream.off('data', data)
}

export function writeLine(stream, value) {
  stream.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

export function boundedTimeout(value, fallback = DEFAULT_REQUEST_MS) {
  const numeric = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1_000 || numeric > MAX_REQUEST_MS) {
    throw new Error(`timeoutMs must be from 1000 to ${MAX_REQUEST_MS}`)
  }
  return numeric
}

export function sanitizedError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}
