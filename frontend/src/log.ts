// In-app diagnostic log: a small ring buffer the Settings viewer reads. Captures
//  - every failed backend command (via the invoke wrapper in tauri.ts — the single chokepoint),
//  - uncaught window errors and unhandled promise rejections,
//  - explicit logInfo/logWarn/logError calls from feature code.
// Privacy: log COMMAND NAMES and ERROR TEXT, never prompts, file contents, or tokens.

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  tag: string
  message: string
  /** How many consecutive times this exact entry repeated (poll loops in a failed state). */
  count: number
}

const MAX_ENTRIES = 500
const STORAGE_KEY = 'syzygy-diagnostic-log-v1'

/** Validate persisted diagnostics defensively so corrupted localStorage cannot break app startup. */
export function normalizeStoredLog(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Partial<LogEntry> => Boolean(entry) && typeof entry === 'object')
    .filter(
      (entry) =>
        (entry.level === 'info' || entry.level === 'warn' || entry.level === 'error') &&
        typeof entry.tag === 'string' &&
        typeof entry.message === 'string' &&
        typeof entry.ts === 'number' &&
        Number.isFinite(entry.ts),
    )
    .map((entry) => ({
      ts: entry.ts as number,
      level: entry.level as LogLevel,
      tag: (entry.tag as string).slice(0, 80),
      message: (entry.message as string).slice(0, 2000),
      count:
        typeof entry.count === 'number' && Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1,
    }))
    .slice(-MAX_ENTRIES)
}

function loadPersistedLog(): LogEntry[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? normalizeStoredLog(JSON.parse(stored)) : []
  } catch {
    return []
  }
}

function persistLog(next: LogEntry[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Diagnostics must never make the app fail when storage is unavailable or full.
  }
}

let entries: LogEntry[] = loadPersistedLog()
let listeners: Array<() => void> = []

function notify() {
  for (const l of listeners) l()
}

export function addLog(level: LogLevel, tag: string, message: string): void {
  const msg = String(message).slice(0, 2000)
  // Collapse consecutive repeats (e.g. a polling command failing every 2s) into one row ×N.
  const last = entries[entries.length - 1]
  if (last && last.level === level && last.tag === tag && last.message === msg) {
    entries = [...entries.slice(0, -1), { ...last, ts: Date.now(), count: last.count + 1 }]
    persistLog(entries)
    notify()
    return
  }
  const entry: LogEntry = { ts: Date.now(), level, tag, message: msg, count: 1 }
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry]
  persistLog(entries)
  // Mirror to the devtools console so `tauri dev` sessions see everything in one place.
  // eslint-disable-next-line no-console
  ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[${tag}] ${message}`)
  notify()
}

export const logInfo = (tag: string, message: string) => addLog('info', tag, message)
export const logWarn = (tag: string, message: string) => addLog('warn', tag, message)
export const logError = (tag: string, message: string) => addLog('error', tag, message)

/** Snapshot for useSyncExternalStore — a stable reference until the next addLog/clearLog. */
export function getLog(): LogEntry[] {
  return entries
}

export function clearLog(): void {
  entries = []
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Clearing the in-memory view is still useful if storage is unavailable.
    }
  }
  notify()
}

export function subscribeLog(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

/** The whole log as copy-pasteable text (for bug reports). */
export function logAsText(): string {
  return entries
    .map(
      (e) =>
        `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.tag}]${e.count > 1 ? ` (×${e.count})` : ''} ${e.message}`,
    )
    .join('\n')
}

// ---- global capture: errors that would otherwise vanish ----
if (typeof window !== 'undefined') {
  addLog('info', 'app', 'Diagnostic session started')
  window.addEventListener('error', (e) => {
    addLog('error', 'window', e.message || String(e.error ?? 'unknown error'))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined
    addLog('error', 'promise', r?.message ?? String(e.reason ?? 'unhandled rejection'))
  })
}
