import net from 'node:net'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import {
  DEFAULT_PORT,
  HEARTBEAT_MS,
  LAN_PROTOCOL,
  MAX_HANDSHAKE_BYTES,
  assertNodeId,
  boundedTimeout,
  createAgentChannel,
  createAgentProof,
  deriveSessionKeys,
  integerOption,
  lineReader,
  loadPairingKey,
  option,
  parseCli,
  requiredOption,
  sanitizedError,
  writeLine,
} from './lan-bridge-protocol.mjs'
import { LocalMcpSession } from './lan-local-mcp.mjs'

const options = parseCli(process.argv.slice(2))
const nodeId = assertNodeId(requiredOption(options, '--node-id'))
const host = requiredOption(options, '--coordinator')
const port = integerOption(options, '--port', DEFAULT_PORT, { max: 65_535 })
const pairingKey = loadPairingKey(path.resolve(requiredOption(options, '--key-file')))
const executable = option(options, '--executable')
const mcpCommand = option(options, '--mcp-command')
const repeatedArgs = options.get('--mcp-arg')
const mcpArgs = repeatedArgs === undefined ? [] : Array.isArray(repeatedArgs) ? repeatedArgs : [repeatedArgs]
if (!executable && !mcpCommand) throw new Error('--executable or --mcp-command is required')
if (executable && mcpCommand) throw new Error('use either --executable or --mcp-command, not both')
const command = executable ? path.resolve(executable) : mcpCommand
const commandArgs = executable ? ['--mcp'] : mcpArgs

const local = new LocalMcpSession(command, commandArgs)
const initialized = await local.initialize(`syzygy-lan-agent-${nodeId}`)
let stopping = false
let socket = null
let heartbeat = null
let reconnectDelayMs = 1_000

function log(message) {
  process.stderr.write(`[syzygy-lan-agent:${nodeId}] ${message}\n`)
}

async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  socket?.destroy()
  await local.close().catch(() => {})
  process.exitCode = exitCode
}

async function connectOnce() {
  return new Promise((resolve, reject) => {
    const candidate = net.createConnection({ host, port })
    socket = candidate
    candidate.setNoDelay(true)
    let phase = 'challenge'
    let channel = null
    let detach = null
    const fail = (error) => {
      detach?.()
      candidate.destroy()
      reject(error)
    }
    const onLine = async (line) => {
      try {
        if (phase === 'challenge') {
          if (Buffer.byteLength(line) > MAX_HANDSHAKE_BYTES) throw new Error('coordinator challenge is too large')
          const challenge = JSON.parse(line)
          if (challenge?.type !== 'challenge' || challenge.protocol !== LAN_PROTOCOL) {
            throw new Error('coordinator protocol challenge is invalid')
          }
          const serverNonce = Buffer.from(challenge.serverNonce ?? '', 'base64url')
          if (serverNonce.length !== 32) throw new Error('coordinator nonce is invalid')
          const clientNonceBuffer = randomBytes(32)
          const proof = createAgentProof(pairingKey, nodeId, serverNonce, clientNonceBuffer)
          const keys = deriveSessionKeys(pairingKey, nodeId, serverNonce, clientNonceBuffer)
          channel = createAgentChannel(nodeId, keys)
          writeLine(candidate, {
            type: 'hello',
            protocol: LAN_PROTOCOL,
            nodeId,
            clientNonce: clientNonceBuffer.toString('base64url'),
            proof: proof.toString('base64url'),
            metadata: {
              hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown',
              platform: process.platform,
              arch: process.arch,
              mcpServer: initialized?.serverInfo ?? null,
            },
          })
          phase = 'ready'
          return
        }

        const message = channel.decode(line)
        if (phase === 'ready') {
          if (message?.type !== 'ready') throw new Error('coordinator did not complete the encrypted handshake')
          phase = 'connected'
          reconnectDelayMs = 1_000
          heartbeat = setInterval(() => {
            if (!candidate.destroyed) writeLine(candidate, channel.encode({ type: 'heartbeat', sentAt: Date.now() }))
          }, HEARTBEAT_MS)
          log(`connected to ${host}:${port}`)
          return
        }

        if (message?.type === 'heartbeat') {
          writeLine(candidate, channel.encode({ type: 'heartbeat', sentAt: Date.now() }))
          return
        }
        if (message?.type !== 'request' || typeof message.requestId !== 'string') {
          throw new Error('coordinator sent an unsupported encrypted message')
        }
        const timeoutMs = boundedTimeout(message.timeoutMs)
        try {
          const result = await local.request(message.method, message.params ?? {}, timeoutMs)
          writeLine(candidate, channel.encode({ type: 'response', requestId: message.requestId, ok: true, result }))
        } catch (error) {
          writeLine(candidate, channel.encode({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            error: sanitizedError(error),
          }))
        }
      } catch (error) {
        fail(error)
      }
    }
    detach = lineReader(candidate, { onLine, onError: fail })
    candidate.once('error', fail)
    candidate.once('close', () => {
      detach?.()
      clearInterval(heartbeat)
      heartbeat = null
      if (!stopping && phase === 'connected') log('connection closed; reconnecting')
      if (phase === 'connected') resolve()
      else reject(new Error('coordinator connection closed'))
    })
  })
}

process.once('SIGINT', () => void stop(130))
process.once('SIGTERM', () => void stop(130))

while (!stopping) {
  try {
    await connectOnce()
  } catch (error) {
    if (stopping) break
    log(`${sanitizedError(error)}; retry in ${reconnectDelayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs))
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15_000)
  }
}
