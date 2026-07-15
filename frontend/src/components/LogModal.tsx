import { useSyncExternalStore, useState } from 'react'
import { Modal } from './Modal'
import { subscribeLog, getLog, clearLog, logAsText, type LogEntry } from '../log'

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'var(--accent)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
}

const fmtTime = (ts: number) => {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

/** Diagnostic log viewer (Settings → View log). Newest first; copy everything for a bug report. */
export function LogModal({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(subscribeLog, getLog)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logAsText() || '(log is empty)')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — the user can still select the text */
    }
  }

  return (
    <Modal
      title="📜 Diagnostic log"
      onClose={onClose}
      wide
      footer={
        <div className="row full" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={copy}>
            {copied ? '✅ Copied' : '⧉ Copy all'}
          </button>
          <button className="btn sm ghost" onClick={clearLog}>
            🗑 Clear
          </button>
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      <p className="muted xs" style={{ marginTop: 0 }}>
        Recent app activity — backend errors and Drive connection milestones land here automatically and survive
        restarts. The log stays on this machine; use <b>Copy all</b> to paste it into a bug report yourself.
      </p>
      {entries.length === 0 && <div className="muted pad">Nothing logged yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 2, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {entries.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 6px', borderRadius: 4, background: e.level === 'error' ? 'color-mix(in srgb, var(--danger) 8%, transparent)' : 'transparent' }}>
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.ts)}</span>
            <span style={{ color: LEVEL_COLOR[e.level], whiteSpace: 'nowrap', minWidth: 38 }}>{e.level.toUpperCase()}</span>
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>[{e.tag}]</span>
            <span style={{ wordBreak: 'break-word' }}>
              {e.message}
              {e.count > 1 && <span className="muted"> ×{e.count}</span>}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
