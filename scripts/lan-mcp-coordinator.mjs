import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import {
  DEFAULT_PORT,
  HEARTBEAT_MS,
  LAN_PROTOCOL,
  MAX_HANDSHAKE_BYTES,
  MAX_LINE_BYTES,
  STALE_AFTER_MS,
  assertNodeId,
  boundedTimeout,
  createServerChannel,
  deriveSessionKeys,
  integerOption,
  isPrivateListenAddress,
  lineReader,
  loadPairingKey,
  option,
  parseCli,
  requiredOption,
  sanitizedError,
  verifyAgentProof,
  writeLine,
} from './lan-bridge-protocol.mjs'

const options = parseCli(process.argv.slice(2))
const listen = option(options, '--listen', '127.0.0.1')
const port = integerOption(options, '--port', DEFAULT_PORT, { min: 1, max: 65_535 })
const controlPort = integerOption(options, '--control-port', port + 1, { min: 1, max: 65_535 })
if (!isPrivateListenAddress(listen)) throw new Error('--listen must be one explicit loopback or RFC1918 IPv4 address')
if (controlPort === port) throw new Error('--control-port must differ from the agent port')
const pairingKey = loadPairingKey(path.resolve(requiredOption(options, '--key-file')))
const CONTROL_PROTOCOL = 'syzygy-lan-control-v1'
const nodes = new Map()
const controlConnections = new Set()

function log(message) {
  process.stderr.write(`[syzygy-lan-coordinator] ${message}\n`)
}

class NodeConnection {
  constructor({ nodeId, socket, channel, metadata }) {
    this.nodeId = nodeId
    this.socket = socket
    this.channel = channel
    this.metadata = metadata
    this.connectedAt = Date.now()
    this.lastSeenAt = this.connectedAt
    this.pending = new Map()
  }

  send(message) {
    if (this.socket.destroyed) throw new Error(`LAN node ${this.nodeId} is disconnected`)
    writeLine(this.socket, this.channel.encode(message))
  }

  request(method, params = {}, timeoutMs) {
    const bounded = boundedTimeout(timeoutMs)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`LAN node ${this.nodeId} timed out after ${bounded}ms`))
      }, bounded)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.send({ type: 'request', requestId, method, params, timeoutMs: bounded })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  receive(message) {
    this.lastSeenAt = Date.now()
    if (message?.type === 'heartbeat') return
    if (message?.type !== 'response' || typeof message.requestId !== 'string') {
      throw new Error(`LAN node ${this.nodeId} sent an unsupported encrypted message`)
    }
    const waiter = this.pending.get(message.requestId)
    if (!waiter) throw new Error(`LAN node ${this.nodeId} returned an unknown request ID`)
    this.pending.delete(message.requestId)
    clearTimeout(waiter.timer)
    if (message.ok === true) waiter.resolve(message.result)
    else waiter.reject(new Error(message.error ?? `LAN node ${this.nodeId} request failed`))
  }

  close(reason) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    this.pending.clear()
    this.socket.destroy()
  }

  summary() {
    return {
      nodeId: this.nodeId,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      metadata: this.metadata,
    }
  }
}

function acceptAgent(socket) {
  socket.setNoDelay(true)
  const serverNonce = randomBytes(32)
  let phase = 'hello'
  let connection = null
  let detach = null
  const fail = (error) => {
    log(`rejected ${socket.remoteAddress ?? 'unknown'}: ${sanitizedError(error)}`)
    detach?.()
    socket.destroy()
  }
  writeLine(socket, {
    type: 'challenge',
    protocol: LAN_PROTOCOL,
    serverNonce: serverNonce.toString('base64url'),
    heartbeatMs: HEARTBEAT_MS,
  })
  detach = lineReader(socket, {
    onError: fail,
    onLine(line) {
      try {
        if (phase === 'hello') {
          if (Buffer.byteLength(line) > MAX_HANDSHAKE_BYTES) throw new Error('agent hello is too large')
          const hello = JSON.parse(line)
          if (hello?.type !== 'hello' || hello.protocol !== LAN_PROTOCOL) throw new Error('agent hello is invalid')
          const nodeId = assertNodeId(hello.nodeId ?? '')
          const clientNonce = Buffer.from(hello.clientNonce ?? '', 'base64url')
          const proof = Buffer.from(hello.proof ?? '', 'base64url')
          if (clientNonce.length !== 32) throw new Error('agent nonce is invalid')
          if (!verifyAgentProof(pairingKey, nodeId, serverNonce, clientNonce, proof)) {
            throw new Error('agent pairing proof is invalid')
          }
          const keys = deriveSessionKeys(pairingKey, nodeId, serverNonce, clientNonce)
          const channel = createServerChannel(nodeId, keys)
          const prior = nodes.get(nodeId)
          if (prior) prior.close(`LAN node ${nodeId} reconnected`)
          connection = new NodeConnection({
            nodeId,
            socket,
            channel,
            metadata: hello.metadata && typeof hello.metadata === 'object' ? hello.metadata : {},
          })
          nodes.set(nodeId, connection)
          phase = 'connected'
          connection.send({ type: 'ready', connectedAt: connection.connectedAt })
          log(`node ${nodeId} connected from ${socket.remoteAddress ?? 'unknown'}`)
          return
        }
        connection.receive(connection.channel.decode(line))
      } catch (error) {
        fail(error)
      }
    },
  })
  socket.once('close', () => {
    detach?.()
    if (connection && nodes.get(connection.nodeId) === connection) {
      nodes.delete(connection.nodeId)
      connection.close(`LAN node ${connection.nodeId} disconnected`)
      log(`node ${connection.nodeId} disconnected`)
    }
  })
  socket.once('error', (error) => {
    if (!socket.destroyed) fail(error)
  })
}

const server = net.createServer(acceptAgent)
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host: listen, port }, resolve)
})
const address = server.address()
log(`listening on ${typeof address === 'object' ? `${address.address}:${address.port}` : address}`)

const heartbeat = setInterval(() => {
  const now = Date.now()
  for (const connection of nodes.values()) {
    if (now - connection.lastSeenAt > STALE_AFTER_MS) {
      log(`evicting stale node ${connection.nodeId}`)
      nodes.delete(connection.nodeId)
      connection.close(`LAN node ${connection.nodeId} missed heartbeat deadline`)
      continue
    }
    try {
      connection.send({ type: 'heartbeat', sentAt: now })
    } catch (error) {
      log(sanitizedError(error))
    }
  }
}, HEARTBEAT_MS)

function nodeById(nodeId) {
  const connection = nodes.get(assertNodeId(nodeId ?? ''))
  if (!connection) throw new Error(`LAN node ${nodeId} is not connected`)
  return connection
}

function toolResult(structuredContent, text, isError = false) {
  return { content: [{ type: 'text', text }], structuredContent, isError }
}

function toolDefinitions() {
  return [
    {
      name: 'lan_nodes',
      description: 'List authenticated Syzygy installations currently connected to this LAN coordinator.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'lan_node_tools',
      description: 'List the native Syzygy MCP tools available on one connected LAN node.',
      inputSchema: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } },
        required: ['nodeId'],
        additionalProperties: false,
      },
    },
    {
      name: 'lan_call',
      description: 'Call one native Syzygy MCP tool on one authenticated LAN node. The native tool keeps its own revision and mutation guards.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'object' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
        },
        required: ['nodeId', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'lan_probe',
      description: 'Run a bounded read-only status and tool-discovery probe across every connected Syzygy node.',
      inputSchema: {
        type: 'object',
        properties: { timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } },
        additionalProperties: false,
      },
    },
  ]
}

async function callTool(name, args) {
  try {
    if (name === 'lan_nodes') {
      const connected = [...nodes.values()].map((node) => node.summary()).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      return toolResult({ protocol: LAN_PROTOCOL, nodes: connected }, `${connected.length} authenticated LAN node(s) connected.`)
    }
    if (name === 'lan_node_tools') {
      const node = nodeById(args.nodeId)
      const result = await node.request('tools/list', {}, args.timeoutMs)
      return toolResult({ nodeId: node.nodeId, tools: result.tools ?? [] }, `${result.tools?.length ?? 0} tools available on ${node.nodeId}.`)
    }
    if (name === 'lan_call') {
      if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('name is required')
      const node = nodeById(args.nodeId)
      const remote = await node.request('tools/call', { name: args.name, arguments: args.arguments ?? {} }, args.timeoutMs)
      return toolResult(
        { nodeId: node.nodeId, tool: args.name, remote },
        `Remote tool ${args.name} ${remote?.isError ? 'reported an error' : 'completed'} on ${node.nodeId}.`,
        remote?.isError === true,
      )
    }
    if (name === 'lan_probe') {
      const timeoutMs = boundedTimeout(args.timeoutMs)
      const probes = await Promise.all([...nodes.values()].map(async (node) => {
        try {
          const [toolList, status] = await Promise.all([
            node.request('tools/list', {}, timeoutMs),
            node.request('tools/call', { name: 'syzygy_status', arguments: {} }, timeoutMs),
          ])
          return { nodeId: node.nodeId, ok: status?.isError !== true, toolCount: toolList.tools?.length ?? 0, status }
        } catch (error) {
          return { nodeId: node.nodeId, ok: false, error: sanitizedError(error) }
        }
      }))
      return toolResult({ protocol: LAN_PROTOCOL, probes }, `Probed ${probes.length} LAN node(s).`, probes.some((probe) => !probe.ok))
    }
    throw new Error(`Unknown LAN tool: ${name}`)
  } catch (error) {
    const message = sanitizedError(error)
    return toolResult({ error: message }, message, true)
  }
}

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function dispatch(message) {
  const id = message?.id
  if (id === undefined) return null
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return jsonrpcError(id ?? null, -32600, 'Invalid JSON-RPC request')
  if (message.method === 'initialize') {
    return jsonrpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'syzygy-lan', title: 'Syzygy LAN Coordinator', version: '1' },
      instructions: 'Discover authenticated installations with lan_nodes. Probe read-only state with lan_probe. Use lan_node_tools before lan_call. Native Syzygy revision guards remain mandatory. This bridge controls nodes; it does not itself synchronize project state.',
    })
  }
  if (message.method === 'ping') return jsonrpcResult(id, {})
  if (message.method === 'tools/list') return jsonrpcResult(id, { tools: toolDefinitions() })
  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (typeof name !== 'string') return jsonrpcError(id, -32602, 'tools/call requires a tool name')
    return jsonrpcResult(id, await callTool(name, message.params?.arguments ?? {}))
  }
  return jsonrpcError(id, -32601, `Method not found: ${message.method}`)
}

function controlProof(nonce) {
  return createHmac('sha256', pairingKey)
    .update(`${CONTROL_PROTOCOL}\0${nonce}`, 'utf8')
    .digest()
}

function acceptControl(socket) {
  controlConnections.add(socket)
  socket.setNoDelay(true)
  const nonce = randomBytes(24).toString('base64url')
  let authenticated = false
  let detach = () => {}
  const fail = (error) => {
    log(`control attachment rejected: ${sanitizedError(error)}`)
    detach()
    socket.destroy()
  }
  const authenticate = (line) => {
    try {
      const message = JSON.parse(line)
      if (message?.type !== 'control-proof' || message.protocol !== CONTROL_PROTOCOL || typeof message.proof !== 'string') {
        throw new Error('invalid control proof')
      }
      const received = Buffer.from(message.proof, 'base64url')
      const expected = controlProof(nonce)
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new Error('control proof mismatch')
      }
      authenticated = true
      detach()
      writeLine(socket, { type: 'control-ready', protocol: CONTROL_PROTOCOL })
      detach = lineReader(socket, {
        maxBytes: MAX_LINE_BYTES,
        onError: fail,
        onLine: (request) => {
          void (async () => {
            let response
            try {
              response = await dispatch(JSON.parse(request))
            } catch (error) {
              response = jsonrpcError(null, -32700, sanitizedError(error))
            }
            if (response && !socket.destroyed) writeLine(socket, response)
          })()
        },
      })
    } catch (error) {
      fail(error)
    }
  }
  detach = lineReader(socket, { maxBytes: MAX_HANDSHAKE_BYTES, onLine: authenticate, onError: fail })
  socket.once('error', (error) => {
    if (authenticated) log(`control attachment closed: ${sanitizedError(error)}`)
    detach()
  })
  socket.once('close', () => {
    detach()
    controlConnections.delete(socket)
  })
  writeLine(socket, { type: 'control-challenge', protocol: CONTROL_PROTOCOL, nonce })
}

const controlServer = net.createServer(acceptControl)
await new Promise((resolve, reject) => {
  controlServer.once('error', reject)
  controlServer.listen({ host: '127.0.0.1', port: controlPort }, resolve)
})
log(`control attachment listening on 127.0.0.1:${controlPort}`)

process.stdin.setEncoding('utf8')
let stdinBuffer = ''
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  for (;;) {
    const newline = stdinBuffer.indexOf('\n')
    if (newline < 0) break
    const line = stdinBuffer.slice(0, newline).trim()
    stdinBuffer = stdinBuffer.slice(newline + 1)
    if (!line) continue
    void (async () => {
      let response
      try {
        response = await dispatch(JSON.parse(line))
      } catch (error) {
        response = jsonrpcError(null, -32700, sanitizedError(error))
      }
      if (response) writeLine(process.stdout, response)
    })()
  }
})

let shutdownPromise = null
async function shutdown() {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    clearInterval(heartbeat)
    for (const connection of nodes.values()) connection.close('LAN coordinator stopped')
    nodes.clear()
    for (const socket of controlConnections) socket.destroy()
    controlConnections.clear()
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => controlServer.close(resolve)),
    ])
  })()
  return shutdownPromise
}

process.stdin.once('end', () => void shutdown())
process.once('SIGINT', () => void shutdown().finally(() => { process.exitCode = 130 }))
process.once('SIGTERM', () => void shutdown().finally(() => { process.exitCode = 130 }))
