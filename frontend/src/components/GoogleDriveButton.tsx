import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { logInfo } from '../log'
import { Modal } from './Modal'
import {
  googleOauthStart,
  googleOauthStatus,
  googleOauthCancel,
  googleOauthDisconnect,
  googleDriveCreateFolder,
} from '../tauri'

/** Google failures that all mean the same thing: the Drive permission checkbox on the consent
 * screen wasn't ticked, so the token can't touch Drive. */
const SCOPE_PROBLEM = /insufficient|scope|checkbox|drive access/i

/**
 * Compact Google Drive control for the Ask top bar (lives next to the folder grant).
 * Auth + a create-folder smoke test for now; the shared-folder sync layer builds on this.
 * The OAuth flow and tokens live entirely in the Rust core — this only sees the email.
 */
export function GoogleDriveButton() {
  const clientId = useStore((s) => s.settings.googleClientId)
  const clientSecret = useStore((s) => s.settings.googleClientSecret)
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState(false) // a sign-in is waiting on the browser (cancelable)
  const [flash, setFlash] = useState<{ label: string; title?: string } | null>(null)
  const [showScopeHelp, setShowScopeHelp] = useState(false)
  const flashTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    googleOauthStatus()
      .then(setEmail)
      .catch(() => setEmail(null)) // not running under Tauri (browser dev)
    return () => window.clearTimeout(flashTimer.current)
  }, [])

  const showFlash = (label: string, title?: string, ms = 4000) => {
    window.clearTimeout(flashTimer.current)
    setFlash({ label, title })
    flashTimer.current = window.setTimeout(() => setFlash(null), ms)
  }

  const connect = async () => {
    setBusy(true)
    setLinking(true)
    try {
      const who = await googleOauthStart(clientId, clientSecret)
      setEmail(who)
      logInfo('drive', `Linked Google Drive as ${who}`)
      showFlash('✅ Linked', `Linked as ${who}`)
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e)
      if (/canceled/i.test(msg)) showFlash('Sign-in canceled', undefined, 2500)
      else if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
      else showFlash('⚠ Link failed', msg, 15000) // already in the diagnostic log via the invoke wrapper
    } finally {
      setBusy(false)
      setLinking(false)
    }
  }

  const makeTestFolder = async () => {
    setBusy(true)
    try {
      const result = await googleDriveCreateFolder('Syzygy')
      const [status, id] = result.split(':', 2)
      logInfo('drive', `Drive test: "Syzygy" folder ${status} (id ${id})`)
      showFlash(status === 'created' ? '✅ Folder created' : '✅ Folder exists', `"Syzygy" folder id ${id} — check drive.google.com`)
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e)
      if (SCOPE_PROBLEM.test(msg)) setShowScopeHelp(true)
      else showFlash('⚠ Drive call failed', msg, 8000)
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setBusy(true)
    try {
      await googleOauthDisconnect()
      setEmail(null)
      showFlash('Unlinked')
    } catch (e) {
      showFlash('⚠ Unlink failed', (e as { message?: string })?.message ?? String(e), 8000)
    } finally {
      setBusy(false)
    }
  }

  // The one mistake everyone makes: Google's consent screen shows the Drive permission as an
  // UNTICKED checkbox, and "allowing" without ticking it produces a link that can't touch Drive.
  const scopeHelp = showScopeHelp && (
    <Modal
      title="One more click on Google's screen"
      onClose={() => setShowScopeHelp(false)}
      footer={
        <div className="row full">
          <div className="grow" />
          <button className="btn ghost" onClick={() => setShowScopeHelp(false)}>
            Close
          </button>
          <button
            className="btn"
            onClick={async () => {
              setShowScopeHelp(false)
              try {
                await googleOauthDisconnect()
              } catch {
                /* nothing stored — fine */
              }
              setEmail(null)
              connect()
            }}
          >
            🔗 Re-link now
          </button>
        </div>
      }
    >
      <p>
        Your Google sign-in went through, but the <b>Drive permission checkbox was left unticked</b> — so Syzygy got a
        link that isn't allowed to touch your Drive.
      </p>
      <p>
        On Google's consent screen, <b>tick the box</b> that says{' '}
        <em>“See, edit, create and delete only the specific Google Drive files that you use with this app”</em> before
        clicking Continue. That's the whole fix.
      </p>
      <p className="muted xs">
        That checkbox is also the only Drive access Syzygy ever asks for — files this app creates or that you pick,
        nothing else in your Drive.
      </p>
    </Modal>
  )

  if (flash) {
    return (
      <>
        <button className="btn sm ghost" title={flash.title} disabled>
          {flash.label}
        </button>
        {scopeHelp}
      </>
    )
  }

  if (!email) {
    // While a sign-in is pending the button stays LIVE as a cancel control — never a dead
    // "Waiting…" that can only be escaped by finishing (or timing out) in the browser.
    if (linking) {
      return (
        <button className="btn sm ghost" title="Abort the sign-in waiting in your browser" onClick={() => googleOauthCancel()}>
          Waiting for browser… ✕ cancel
        </button>
      )
    }
    return (
      <>
        <button
          className="btn sm ghost"
          title="Link your Google Drive (sign-in happens in your own browser; drive.file scope only)"
          disabled={busy || !clientId.trim()}
          onClick={connect}
        >
          🔗 Link Drive
        </button>
        {scopeHelp}
      </>
    )
  }

  return (
    <span className="row" style={{ gap: 4, alignItems: 'center' }}>
      <button
        className="btn sm ghost"
        title={`Linked as ${email} — click to create a "Syzygy" test folder in your Drive`}
        disabled={busy}
        onClick={makeTestFolder}
      >
        {busy ? '…' : '📁 Drive test'}
      </button>
      <button className="icon-btn sm" title={`Unlink Google Drive (${email})`} disabled={busy} onClick={unlink}>
        ✕
      </button>
      {scopeHelp}
    </span>
  )
}
