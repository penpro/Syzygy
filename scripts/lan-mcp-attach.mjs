import { createHmac } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import {
  MAX_HANDSHAKE_BYTES,
  integerOption,
  lineReader,
  loadPairingKey,
  parseCli,
  requiredOption,
  sanitizedError,
  writeLine,
} from './lan-bridge-protocol.mjs'

const CONTROL_PROTOCOL = 'syzygy-lan-control-v1'
const options = parseCli(process.argv.slice(2))
const host = requiredOption(options, '--host')
const port = integerOption(options, '--control-port', 37_664, { min: 1, max: 65_535 })
const pairingKey = loadPairingKey(path.resolve(requiredOption(options, '--key-file')))

const socket = net.createConnection({ host, port })
socket.setNoDelay(true)
let authenticated = false
let detachSocketReader = () => {}
let detachMessageReader = () => {}
let detachStdinReader = () => {}
const authenticationDeadline = setTimeout(() => {
  socket.destroy(new Error('LAN developer coordinator authentication timed out'))
}, 5_000)

function proof(nonce) {
  return createHmac('sha256', pairingKey)
    .update(`${CONTROL_PROTOCOL}\0${nonce}`, 'utf8')
    .digest('base64url')
}

function fail(error) {
  process.stderr.write(`[syzygy-lan-attach] ${sanitizedError(error)}\n`)
  process.exitCode = 1
  socket.destroy()
}

socket.once('error', fail)
socket.once('close', () => {
  clearTimeout(authenticationDeadline)
  detachSocketReader()
  detachMessageReader()
  detachStdinReader()
  process.stdin.pause()
  process.stdin.unref?.()
  if (!authenticated && process.exitCode === undefined) process.exitCode = 1
  setImmediate(() => process.exit(process.exitCode ?? 0))
})

detachSocketReader = lineReader(socket, {
  maxBytes: MAX_HANDSHAKE_BYTES,
  onError: fail,
  onLine: (line) => {
    try {
      const message = JSON.parse(line)
      if (!authenticated) {
        if (message?.type === 'control-challenge' && message.protocol === CONTROL_PROTOCOL) {
          if (typeof message.nonce !== 'string' || message.nonce.length < 16) {
            throw new Error('LAN developer coordinator sent an invalid challenge')
          }
          writeLine(socket, { type: 'control-proof', protocol: CONTROL_PROTOCOL, proof: proof(message.nonce) })
          return
        }
        if (message?.type === 'control-ready' && message.protocol === CONTROL_PROTOCOL) {
          authenticated = true
          clearTimeout(authenticationDeadline)
          detachSocketReader()
          detachMessageReader = lineReader(socket, {
            onError: fail,
            onLine: (response) => writeLine(process.stdout, response),
          })
          detachStdinReader = lineReader(process.stdin, {
            onError: fail,
            onLine: (request) => writeLine(socket, request),
          })
          process.stdin.once('end', () => socket.end())
          return
        }
        throw new Error('LAN developer coordinator rejected the control attachment')
      }
      throw new Error('LAN developer coordinator sent an unexpected authentication message')
    } catch (error) {
      fail(error)
    }
  },
})

process.once('SIGINT', () => socket.end())
process.once('SIGTERM', () => socket.end())
