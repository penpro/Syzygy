import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(root, 'frontend')
const manifest = join(frontend, 'src-tauri', 'Cargo.toml')
const rust = spawnSync('cargo', ['run', '--quiet', '--manifest-path', manifest, '--bin', 'provider-runtime-harness'], {
  cwd: frontend,
  encoding: 'utf8',
  shell: false,
})
if (rust.error) throw rust.error
if (rust.status !== 0) throw new Error(`provider runtime harness failed: ${rust.stderr}`)
const record = rust.stdout.trim()
if (!record) throw new Error('provider runtime harness returned no record')
JSON.parse(record)

const vitest = spawnSync(
  process.execPath,
  [
    join(frontend, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'src/extensions/providerRuntimeInterop.test.ts',
    '--reporter=verbose',
  ],
  {
    cwd: frontend,
    env: { ...process.env, SYZYGY_PROVIDER_RUN_RECORD: record },
    encoding: 'utf8',
    shell: false,
  },
)
if (vitest.error) throw vitest.error
process.stdout.write(vitest.stdout)
process.stderr.write(vitest.stderr)
if (vitest.status !== 0) process.exit(vitest.status ?? 1)
process.stdout.write(`${JSON.stringify({ passed: true, rustRecordBytes: Buffer.byteLength(record), externalNetworkUsed: false }, null, 2)}\n`)
