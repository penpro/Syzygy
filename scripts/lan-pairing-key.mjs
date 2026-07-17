import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createPairingKey, parseCli, requiredOption } from './lan-bridge-protocol.mjs'

const options = parseCli(process.argv.slice(2))
const output = path.resolve(requiredOption(options, '--out'))
writeFileSync(output, `${createPairingKey()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
process.stdout.write(`${output}\n`)
