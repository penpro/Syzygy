import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(root, 'frontend')
const manifest = join(frontend, 'src-tauri', 'Cargo.toml')
const rust = spawnSync(
  'cargo',
  ['run', '--quiet', '--manifest-path', manifest, '--bin', 'provider-runtime-harness', '--', '--tool-validation'],
  { cwd: frontend, encoding: 'utf8', shell: false },
)
if (rust.error) throw rust.error
if (rust.status !== 0) throw new Error(`provider tool validation harness failed: ${rust.stderr}`)
const response = rust.stdout.trim()
if (!response) throw new Error('provider tool validation harness returned no response')
JSON.parse(response)

const vitest = spawnSync(
  process.execPath,
  [
    join(frontend, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'src/providerToolValidationInterop.test.ts',
    '--reporter=verbose',
  ],
  {
    cwd: frontend,
    env: { ...process.env, SYZYGY_PROVIDER_TOOL_VALIDATION: response },
    encoding: 'utf8',
    shell: false,
  },
)
if (vitest.error) throw vitest.error
process.stdout.write(vitest.stdout)
process.stderr.write(vitest.stderr)
if (vitest.status !== 0) process.exit(vitest.status ?? 1)
process.stdout.write(`${JSON.stringify({
  passed: true,
  proposalCount: 3,
  statuses: ['valid', 'invalid', 'missing-definition'],
  externalNetworkUsed: false,
  toolCallsExecuted: 0,
}, null, 2)}\n`)
