import { useEffect, useState } from 'react'
import {
  lanAgentConfigure,
  lanAgentSettings,
  pickLanPairingKeyFile,
  type LanAgentConfig,
  type LanAgentReport,
} from '../tauri'

const DEFAULT_CONFIG: LanAgentConfig = {
  enabled: false,
  nodeId: 'syzygy-node',
  coordinator: '',
  port: 37_663,
  keyFile: '',
}

export function LanAgentSettings() {
  const [draft, setDraft] = useState<LanAgentConfig>(DEFAULT_CONFIG)
  const [report, setReport] = useState<LanAgentReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Loading saved connection…')

  useEffect(() => {
    let disposed = false
    void lanAgentSettings()
      .then((next) => {
        if (disposed) return
        setDraft(next.config)
        setReport(next)
        setMessage('')
      })
      .catch(() => {
        if (!disposed) setMessage('Private LAN connections are available in the installed app.')
      })
    return () => {
      disposed = true
    }
  }, [])

  const chooseKey = async () => {
    const selected = await pickLanPairingKeyFile()
    if (selected) setDraft((current) => ({ ...current, keyFile: selected }))
  }

  const apply = async () => {
    setBusy(true)
    setMessage('')
    try {
      const next = await lanAgentConfigure(draft)
      setDraft(next.config)
      setReport(next)
      setMessage(next.running ? 'Private LAN connection is running.' : 'Private LAN connection is off.')
    } catch (error) {
      setMessage((error as { message?: string })?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const status = report?.running
    ? 'Running in background'
    : draft.enabled
      ? 'Enabled, not running'
      : 'Off'

  return (
    <div className="field">
      <div className="row gap">
        <strong className="grow">Private LAN test connection</strong>
        <span className="mono subtle" aria-live="polite">{status}</span>
      </div>
      <label className="row gap">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span>Keep this computer available to the private LAN test host</span>
      </label>
      <em className="hint">
        Syzygy starts an outbound encrypted control connection for tools and automated checks. It never opens a LAN listener and does not sync research data by itself.
      </em>
      <label className="field">
        <span>Computer label</span>
        <input
          value={draft.nodeId}
          maxLength={64}
          placeholder="office-secondary"
          onChange={(event) => setDraft((current) => ({ ...current, nodeId: event.target.value }))}
        />
      </label>
      <div className="row gap">
        <label className="field grow">
          <span>Coordinator private IP</span>
          <input
            value={draft.coordinator}
            placeholder="192.168.1.73"
            onChange={(event) => setDraft((current) => ({ ...current, coordinator: event.target.value }))}
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
      <label className="field">
        <span>Pairing-key file</span>
        <div className="row gap">
          <input className="grow" readOnly value={draft.keyFile} placeholder="Choose the copied .syzygy-lan.key file" />
          <button type="button" className="btn sm ghost" onClick={() => void chooseKey()}>
            Choose file
          </button>
        </div>
      </label>
      <div className="row gap">
        <button type="button" className="btn sm" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply connection'}
        </button>
        {report?.lastError ? <span className="error-text">{report.lastError}</span> : null}
      </div>
      {message ? <em className="hint" aria-live="polite">{message}</em> : null}
    </div>
  )
}
