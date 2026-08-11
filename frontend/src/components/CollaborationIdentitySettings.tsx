import { useEffect, useState } from 'react'
import { collaborationIdentityStatus, type CollaborationIdentityReport } from '../tauri'

export function CollaborationIdentitySettings() {
  const [report, setReport] = useState<CollaborationIdentityReport | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let disposed = false
    void collaborationIdentityStatus().then((next) => {
      if (!disposed) setReport(next)
    }).catch(() => {
      if (!disposed) setUnavailable(true)
    })
    return () => { disposed = true }
  }, [])

  return (
    <div className="field" aria-label="Signed device identity">
      <div className="row gap">
        <strong className="grow">Signed device identity</strong>
        <span className="mono subtle">{report ? 'Ready' : unavailable ? 'Unavailable' : 'Loading...'}</span>
      </div>
      <em className="hint">
        Live collaboration can prove that a session holds this installation's key. The private key is
        persisted only in the operating system credential store and is never sent to the webview or relay.
      </em>
      <em className="hint">
        A signed device is not a verified person or organization. Researcher names remain self-reported.
      </em>
      {report ? (
        <div className="field mono subtle">
          <span>Algorithm: {report.algorithm}</span>
          <span>Fingerprint: {report.fingerprint}</span>
          <span>Scope: installation device, not human identity</span>
        </div>
      ) : null}
    </div>
  )
}
