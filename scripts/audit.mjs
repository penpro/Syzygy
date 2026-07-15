import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(`${name}: ${detail}`)
}
const text = (path) => readFileSync(join(root, path), 'utf8')

function filesBelow(path, extensions) {
  const base = join(root, path)
  const out = []
  for (const name of readdirSync(base)) {
    const full = join(base, name)
    if (statSync(full).isDirectory()) out.push(...filesBelow(relative(root, full), extensions))
    else if (extensions.includes(extname(name))) out.push(full)
  }
  return out
}

const lock = JSON.parse(text('frontend/package-lock.json'))
const packageNames = Object.keys(lock.packages ?? {}).map((key) => key.replace(/^node_modules\//, ''))
const forbiddenPackages = packageNames.filter((name) => /(^|\/)(@?tiptap|firebase|policy-?pad)(\/|$)/i.test(name))
record('forbidden dependencies', forbiddenPackages.length === 0, forbiddenPackages.join(', ') || 'none')

const sourceFiles = [
  ...filesBelow('frontend/src', ['.ts', '.tsx']),
  ...filesBelow('frontend/src-tauri/src', ['.rs']),
]
const forbiddenImports = sourceFiles
  .filter((path) => /(?:from\s+['"](?:@tiptap|firebase)|use\s+(?:tiptap|firebase)|extern\s+crate\s+(?:tiptap|firebase))/i.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('forbidden source imports', forbiddenImports.length === 0, forbiddenImports.join(', ') || 'none')

const invokeViolations = filesBelow('frontend/src', ['.ts', '.tsx'])
  .filter((path) => !path.endsWith(`${join('src', 'tauri.ts')}`))
  .filter((path) => /\binvoke\s*\(/.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('single invoke boundary', invokeViolations.length === 0, invokeViolations.join(', ') || 'tauri.ts only')

const colorViolations = filesBelow('frontend/src/components', ['.ts', '.tsx'])
  .filter((path) => /#[0-9a-f]{3,8}\b/i.test(readFileSync(path, 'utf8')))
  .map((path) => relative(root, path))
record('component theme tokens', colorViolations.length === 0, colorViolations.join(', ') || 'no hard-coded hex colors')

const installerText = `${text('frontend/src-tauri/installer/English.nsh')}\n${text('frontend/src-tauri/installer-hooks.nsh')}`
record('installer identity', !/Aphelion|com\.localllm\.studio/i.test(installerText), 'Syzygy names and data path')
record('icon source', existsSync(join(root, 'frontend/src-tauri/syzygy-icon.svg')), 'syzygy-icon.svg exists')

const tauriConfig = JSON.parse(text('frontend/src-tauri/tauri.conf.json'))
record(
  'bundle identity',
  tauriConfig.productName === 'Syzygy' && tauriConfig.mainBinaryName === 'Syzygy',
  `${tauriConfig.productName}/${tauriConfig.mainBinaryName}`,
)

const ledger = JSON.parse(text('docs/audits/CAPABILITIES.json'))
const expectedIds = [
  ...Array.from({ length: 35 }, (_, index) => `P-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`),
]
const actualIds = ledger.capabilities.map((item) => item.id)
const uniqueIds = new Set(actualIds)
const allowedStatuses = new Set(['planned', 'implemented_unverified', 'verified', 'blocked_external', 'out_of_scope'])
record(
  'capability ledger coverage',
  expectedIds.every((id) => uniqueIds.has(id)) && uniqueIds.size === actualIds.length,
  `${uniqueIds.size}/${expectedIds.length} unique expected capabilities`,
)
record(
  'capability ledger statuses',
  ledger.capabilities.every((item) => allowedStatuses.has(item.status) && Array.isArray(item.evidence)),
  'statuses and evidence arrays are valid',
)

console.log(JSON.stringify({ passed: failures.length === 0, checks, failures }, null, 2))
if (failures.length) process.exit(1)
