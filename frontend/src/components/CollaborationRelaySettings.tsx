import { useEffect, useState } from 'react'
import {
  collaborationRelayConfigure,
  collaborationRelaySettings,
  type CollaborationRelayConfig,
  type CollaborationRelayReport,
} from '../tauri'

const DEFAULT_CONFIG: CollaborationRelayConfig = {
  enabled: false,
  listen: '127.0.0.1',
  port: 37_665,
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export function CollaborationRelaySettings() {
  const [draft, setDraft] = useState(DEFAULT_CONFIG)
  const [report, setReport] = useState<CollaborationRelayReport | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Loading saved relay settings…')

  useEffect(() => {
    let disposed = false
    let first = true
    const refresh = async () => {
      try {
        const next = await collaborationRelaySettings()
        if (disposed) return
        setReport(next)
        if (first) {
          first = false
          setDraft(next.config)
          setInitialized(true)
          setMessage('')
        }
      } catch {
        if (!disposed && first) {
          first = false
          setMessage('The app-managed relay is available in the installed app.')
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  const apply = async () => {
    setBusy(true)
    setMessage('')
    try {
      const next = await collaborationRelayConfigure(draft)
      setDraft(next.config)
      setReport(next)
      setMessage(next.running
        ? 'Research relay is running and will restart with Syzygy.'
        : next.config.enabled
          ? next.lastError ?? 'Research relay settings are saved and its supervisor is retrying.'
          : 'Research relay is off and its listener has been released.')
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const copyEndpoint = async () => {
    if (!report?.endpoint) return
    try {
      await navigator.clipboard.writeText(report.endpoint)
      setMessage('Relay endpoint copied.')
    } catch {
      setMessage('Could not access the clipboard. Select and copy the endpoint manually.')
    }
  }

  const status = report?.running ? 'Running' : draft.enabled ? 'Recovering' : 'Off'

  return (
    <div className="field" aria-label="App-managed research relay">
      <div className="row gap">
        <strong className="grow">App-managed research relay</strong>
        <span className="mono subtle" aria-live="polite">{status}</span>
      </div>
      <label className="row gap">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span>Start this relay with Syzygy and verify it stops when Syzygy closes</span>
      </label>
      <em className="hint">
        This is the research-data relay, separate from the developer MCP network. It is bundled in
        Syzygy and does not require Node.js or PowerShell.
      </em>
      <em className="hint">
        Managed rooms issue separate bearer member capabilities with relay-enforced roles, host-clock
        expiry, rotation/recovery, and revocation. Legacy rooms still use the room ID as one read/edit key. Participant names are
        self-reported. Use a private LAN address only; public hosting needs a separate TLS/WSS proxy.
      </em>
      <div className="row gap">
        <label className="field grow">
          <span>This computer’s private IP</span>
          <input
            value={draft.listen}
            placeholder="192.168.1.73"
            onChange={(event) => setDraft((current) => ({ ...current, listen: event.target.value }))}
          />
        </label>
        <label className="field">
          <span>Port</span>
          <input
            type="number"
            min={1}
            max={65_535}
            value={draft.port}
            onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))}
          />
        </label>
      </div>
      {report?.endpoint ? (
        <div className="row gap">
          <span className="mono subtle grow">{report.endpoint}</span>
          <button type="button" className="btn sm ghost" onClick={() => void copyEndpoint()}>
            Copy endpoint
          </button>
        </div>
      ) : null}
      <em className="hint">
        Document sync updates use a crash-tail-repairing log capped at 64 MiB and 8,192 records per
        room and 512 MiB across the relay. Awareness is never written. This is bounded recovery
        storage, not a backup.
      </em>
      {report ? (
        <div className="field mono subtle">
          <span>Relay process: {report.running ? `running (PID ${report.pid ?? 'unknown'})` : 'stopped'}</span>
          <span>Storage: {report.storagePath}</span>
          <span>Persistence: {report.persistence}</span>
        </div>
      ) : null}
      <div className="row gap">
        <button type="button" className="btn sm" disabled={busy || !initialized} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply relay settings'}
        </button>
        {report?.lastError ? <span className="error-text">{report.lastError}</span> : null}
      </div>
      {message ? <em className="hint" aria-live="polite">{message}</em> : null}
    </div>
  )
}
