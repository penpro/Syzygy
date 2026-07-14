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

let entries: LogEntry[] = []
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
    notify()
    return
  }
  const entry: LogEntry = { ts: Date.now(), level, tag, message: msg, count: 1 }
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry]
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
  window.addEventListener('error', (e) => {
    addLog('error', 'window', e.message || String(e.error ?? 'unknown error'))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined
    addLog('error', 'promise', r?.message ?? String(e.reason ?? 'unhandled rejection'))
  })
}
