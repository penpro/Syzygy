import { useEffect, useState } from 'react'
import {
  lanAgentConfigure,
  lanAgentSettings,
  lanDevCoordinatorConfigure,
  lanDevCoordinatorSettings,
  pickLanPairingKeyFile,
  type LanAgentConfig,
  type LanAgentReport,
  type LanDevCoordinatorConfig,
  type LanDevCoordinatorReport,
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
  const [hostEnabled, setHostEnabled] = useState(false)
  const [report, setReport] = useState<LanAgentReport | null>(null)
  const [hostReport, setHostReport] = useState<LanDevCoordinatorReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Loading saved connection…')

  useEffect(() => {
    let disposed = false
    let initialized = false
    const refresh = async () => {
      try {
        const [nextAgent, nextHost] = await Promise.all([
          lanAgentSettings(),
          lanDevCoordinatorSettings(),
        ])
        if (disposed) return
        setReport(nextAgent)
        setHostReport(nextHost)
        if (!initialized) {
          initialized = true
          setDraft(nextAgent.config)
          setHostEnabled(nextHost.config.enabled)
          setMessage('')
        }
      } catch {
        if (!disposed && !initialized) {
          setMessage('Private LAN connections are available in the installed app.')
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

  const chooseKey = async () => {
    const selected = await pickLanPairingKeyFile()
    if (selected) setDraft((current) => ({ ...current, keyFile: selected }))
  }

  const apply = async () => {
    setBusy(true)
    setMessage('')
    const hostConfig: LanDevCoordinatorConfig = {
      enabled: draft.enabled && hostEnabled,
      listen: draft.coordinator,
      port: draft.port,
      keyFile: draft.keyFile,
    }
    try {
      let nextAgent: LanAgentReport
      let nextHost: LanDevCoordinatorReport
      if (hostConfig.enabled) {
        nextHost = await lanDevCoordinatorConfigure(hostConfig)
        nextAgent = await lanAgentConfigure(draft)
      } else {
        // Disconnect the outbound agent before closing the server it may be using.
        nextAgent = await lanAgentConfigure(draft)
        nextHost = await lanDevCoordinatorConfigure(hostConfig)
      }
      setDraft(nextAgent.config)
      setReport(nextAgent)
      setHostReport(nextHost)
      if (hostConfig.enabled) {
        setMessage(
          nextAgent.running && nextHost.running
            ? 'Collaboration developer network is running.'
            : 'Developer mode is saved and its supervisor is recovering the connection.',
        )
      } else {
        setMessage(nextAgent.running ? 'Private LAN connection is running.' : 'Private LAN connection is off.')
      }
    } catch (error) {
      setMessage((error as { message?: string })?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const status = draft.enabled
    ? hostEnabled
      ? report?.running && hostReport?.running
        ? 'Developer network running'
        : 'Host enabled, recovering'
      : report?.running
        ? 'Connected in background'
        : 'Enabled, reconnecting'
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
      <label className="row gap">
        <input
          type="checkbox"
          checked={hostEnabled}
          disabled={!draft.enabled}
          onChange={(event) => setHostEnabled(event.target.checked)}
        />
        <span>Host the collaboration developer network on this computer</span>
      </label>
      <em className="hint">
        Host mode starts and supervises the interconnect server with Syzygy, then stops and reaps it during shutdown. PowerShell is diagnostic-only.
      </em>
      <em className="hint">
        {hostEnabled
          ? 'The primary opens one encrypted listener on the private address below and an authenticated loopback-only MCP attachment. Node.js must be installed. This control network does not sync research data by itself.'
          : 'This computer makes an outbound encrypted control connection and never opens a LAN listener. It does not sync research data by itself.'}
      </em>
      <label className="field">
        <span>Computer label</span>
        <input
          value={draft.nodeId}
          maxLength={64}
          placeholder={hostEnabled ? 'office-primary' : 'office-secondary'}
          onChange={(event) => setDraft((current) => ({ ...current, nodeId: event.target.value }))}
        />
      </label>
      <div className="row gap">
        <label className="field grow">
          <span>{hostEnabled ? 'This computer’s private IP' : 'Primary computer’s private IP'}</span>
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
            max={65_534}
            value={draft.port}
            onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))}
          />
        </label>
      </div>
      {hostEnabled && hostReport?.controlPort ? (
        <span className="mono subtle">Local MCP attachment: 127.0.0.1:{hostReport.controlPort}</span>
      ) : null}
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
          {busy ? 'Applying…' : 'Apply developer connection'}
        </button>
        {report?.lastError ? <span className="error-text">{report.lastError}</span> : null}
        {hostReport?.lastError ? <span className="error-text">{hostReport.lastError}</span> : null}
      </div>
      {message ? <em className="hint" aria-live="polite">{message}</em> : null}
    </div>
  )
}
