import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { googleOauthStart, googleOauthStatus, googleOauthDisconnect } from '../tauri'

/**
 * Google Drive account linking (Settings section). Auth only — the collaboration/sync layer
 * builds on top of this. The OAuth flow and tokens live entirely in the Rust core; this
 * component only ever sees the connected account's email.
 *
 * Uses the "installed app" loopback flow, which needs an OAuth Client ID of type "Desktop app"
 * (no secret) from console.cloud.google.com → APIs & Services → Credentials. Until a client ID
 * ships baked into the app, it's entered here once and kept in settings.
 */
export function GoogleDriveSettings() {
  const clientId = useStore((s) => s.settings.googleClientId)
  const updateSettings = useStore((s) => s.updateSettings)
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    googleOauthStatus()
      .then(setEmail)
      .catch(() => setEmail(null)) // not running under Tauri (browser dev)
  }, [])

  const connect = async () => {
    setErr('')
    setBusy(true)
    try {
      setEmail(await googleOauthStart(clientId))
    } catch (e) {
      setErr((e as { message?: string })?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setErr('')
    setBusy(true)
    try {
      await googleOauthDisconnect()
      setEmail(null)
    } catch (e) {
      setErr((e as { message?: string })?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <span>Google Drive</span>
      {email ? (
        <div className="row gap" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>
            ✅ Connected as <b>{email}</b>
          </span>
          <button className="btn sm ghost" disabled={busy} onClick={disconnect}>
            {busy ? '…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <>
          <input
            placeholder="OAuth Client ID (Desktop app) — from console.cloud.google.com"
            value={clientId}
            onChange={(e) => updateSettings({ googleClientId: e.target.value })}
          />
          <div className="row gap" style={{ marginTop: 6 }}>
            <button className="btn sm" disabled={busy || !clientId.trim()} onClick={connect}>
              {busy ? 'Waiting for browser…' : '🔗 Connect Google Drive'}
            </button>
          </div>
        </>
      )}
      {err && <div style={{ color: '#ff6b6b', marginTop: 6 }}>{err}</div>}
      <em className="hint">
        Sign-in happens in your own browser; Syzygy never sees your password. Access is limited to files this app
        creates or that you explicitly pick (<code>drive.file</code> scope), and the credentials stay on this machine —
        used only for the collaboration features you invoke.
      </em>
    </div>
  )
}
