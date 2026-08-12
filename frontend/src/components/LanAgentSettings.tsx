import { useEffect, useState } from 'react'
import {
  createLanPairingKeyFile,
  lanAgentConfigure,
  lanAgentReconnect,
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

export function lanConnectionStatus({
  busy,
  draft,
  hostEnabled,
  report,
  hostReport,
}: {
  busy: boolean
  draft: LanAgentConfig
  hostEnabled: boolean
  report: LanAgentReport | null
  hostReport: LanDevCoordinatorReport | null
}): string {
  const authenticated = report?.connectionState === 'connected'
  const savedHostEnabled = hostReport?.config.enabled === true
  const savedAgentEnabled = report?.config.enabled === true
  const unapplied = Boolean(report && hostReport) && (
    draft.enabled !== report?.config.enabled
    || draft.nodeId !== report?.config.nodeId
    || draft.coordinator !== report?.config.coordinator
    || draft.port !== report?.config.port
    || draft.keyFile !== report?.config.keyFile
    || hostEnabled !== savedHostEnabled
  )
  return busy
    ? 'Applying'
    : unapplied
      ? 'Changes not applied'
      : savedAgentEnabled
        ? savedHostEnabled
          ? authenticated && hostReport?.running
            ? 'Developer network connected'
            : 'Host enabled, recovering'
          : authenticated
            ? 'Authenticated'
            : report?.connectionState === 'starting'
              ? 'Starting'
              : 'Enabled, retrying'
        : 'Off'
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

  const createKey = async () => {
    const selected = await createLanPairingKeyFile()
    if (!selected) return null
    setDraft((current) => ({ ...current, keyFile: selected }))
    setMessage('Pairing file created. Apply the host connection, then copy this file securely to each client and choose it there.')
    return selected
  }

  const createKeyOnly = async () => {
    setBusy(true)
    setMessage('')
    try {
      await createKey()
    } catch (error) {
      setMessage((error as { message?: string })?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    setMessage('')
    try {
      let appliedDraft = draft
      if (draft.enabled && hostEnabled && !draft.keyFile) {
        const keyFile = await createKey()
        if (!keyFile) {
          setMessage('Host setup was cancelled before a pairing file was created.')
          return
        }
        appliedDraft = { ...draft, keyFile }
      }
      const hostConfig: LanDevCoordinatorConfig = {
        enabled: appliedDraft.enabled && hostEnabled,
        listen: appliedDraft.coordinator,
        port: appliedDraft.port,
        keyFile: appliedDraft.keyFile,
      }
      let nextAgent: LanAgentReport
      let nextHost: LanDevCoordinatorReport
      if (hostConfig.enabled) {
        nextHost = await lanDevCoordinatorConfigure(hostConfig)
        nextAgent = await lanAgentConfigure(appliedDraft)
      } else {
        // Disconnect the outbound agent before closing the server it may be using.
        nextAgent = await lanAgentConfigure(appliedDraft)
        nextHost = await lanDevCoordinatorConfigure(hostConfig)
      }
      setDraft(nextAgent.config)
      setReport(nextAgent)
      setHostReport(nextHost)
      if (hostConfig.enabled) {
        setMessage(
          nextAgent.connectionState === 'connected' && nextHost.running
            ? 'Collaboration developer network is authenticated and running.'
            : 'Developer mode is saved and its supervisor is recovering the connection.',
        )
      } else {
        setMessage(
          nextAgent.connectionState === 'connected'
            ? 'Private LAN connection is authenticated.'
            : nextAgent.config.enabled
              ? 'Private LAN connection is retrying.'
              : 'Private LAN connection is off.',
        )
      }
    } catch (error) {
      setMessage((error as { message?: string })?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const reconnect = async () => {
    setBusy(true)
    setMessage('')
    try {
      const next = await lanAgentReconnect()
      setDraft(next.config)
      setReport(next)
      setMessage(
        next.config.enabled
          ? 'Reconnect requested. Authenticated status will update automatically.'
          : 'Enable and apply the private LAN connection first.',
      )
    } catch (error) {
      setMessage((error as { message?: string })?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  const status = lanConnectionStatus({ busy, draft, hostEnabled, report, hostReport })

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
        The agent process and encrypted authentication are checked separately. A running process is not reported as connected until its handshake succeeds.
      </em>
      <em className="hint">
        {hostEnabled
          ? 'The primary opens one encrypted listener on the private address below and an authenticated loopback-only MCP attachment. Node.js must be installed. This control network does not sync research data by itself.'
          : 'This computer makes an outbound encrypted control connection and never opens a LAN listener. It does not sync research data by itself.'}
      </em>
      <em className="hint">
        {hostEnabled
          ? 'Start here: create a pairing file, apply this host, then copy that file securely to each client. Treat the file like a password.'
          : 'Copy the pairing file from the host computer, choose it below, then apply this client connection.'}
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
      {report ? (
        <div className="field mono subtle" aria-live="polite">
          <span>Agent process: {report.running ? `running (PID ${report.pid ?? 'unknown'})` : 'stopped'}</span>
          <span>Encrypted handshake: {report.connectionState}</span>
          <span>Reconnect attempts: {report.reconnectCount}</span>
          {report.lastConnectedAtMs ? (
            <span>
              Last authenticated: <time dateTime={new Date(report.lastConnectedAtMs).toISOString()}>
                {new Date(report.lastConnectedAtMs).toLocaleTimeString()}
              </time>
            </span>
          ) : (
            <span>Last authenticated: not yet</span>
          )}
          {report.retryInMs !== null && !report.running ? (
            <span>Next process restart: within {Math.max(1, Math.ceil(report.retryInMs / 1_000))}s</span>
          ) : null}
        </div>
      ) : null}
      <label className="field">
        <span>LAN pairing file</span>
        <div className="row gap">
          <input className="grow" readOnly value={draft.keyFile} placeholder={hostEnabled ? 'Create a new .syzygy-lan.key file' : 'Choose the file copied from the host'} />
          {hostEnabled ? (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void createKeyOnly()}>
              Create file
            </button>
          ) : null}
          <button type="button" className="btn sm ghost" onClick={() => void chooseKey()}>
            {hostEnabled ? 'Use existing' : 'Choose file'}
          </button>
        </div>
      </label>
      <div className="row gap">
        <button type="button" className="btn sm" disabled={busy} onClick={() => void apply()}>
          {busy
            ? 'Applying…'
            : hostEnabled && !draft.keyFile
              ? 'Create pairing file & start host'
              : 'Apply developer connection'}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy || !report?.config.enabled}
          onClick={() => void reconnect()}
        >
          Reconnect now
        </button>
        {report?.lastError ? <span className="error-text">{report.lastError}</span> : null}
        {hostReport?.lastError ? <span className="error-text">{hostReport.lastError}</span> : null}
      </div>
      {message ? <em className="hint" aria-live="polite">{message}</em> : null}
    </div>
  )
}
