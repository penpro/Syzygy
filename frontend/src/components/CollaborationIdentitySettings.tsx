import { useEffect, useState } from 'react'
import { collaborationIdentityStatus, type CollaborationIdentityReport } from '../tauri'
import { createRelayDeviceEnrollment } from '../workspace/relayDeviceEnrollment'

export function CollaborationIdentitySettings() {
  const [report, setReport] = useState<CollaborationIdentityReport | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [enrollment, setEnrollment] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let disposed = false
    void collaborationIdentityStatus().then(async (next) => {
      const code = await createRelayDeviceEnrollment(next)
      if (!disposed) {
        setReport(next)
        setEnrollment(code)
      }
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
      <em className="hint">
        When ready, a public installation key enrollment request appears below. A relay operator can
        bind it to one member so a copied invitation cannot connect from another installation.
      </em>
      {report ? (
        <>
          <div className="field mono subtle">
            <span>Algorithm: {report.algorithm}</span>
            <span>Fingerprint: {report.fingerprint}</span>
            <span>Scope: installation device, not human identity</span>
          </div>
          <label className="field">
            <span>Relay device enrollment request</span>
            <textarea readOnly rows={3} value={enrollment} aria-label="Relay device enrollment request" />
          </label>
          <button className="btn sm" type="button" disabled={!enrollment} onClick={() => {
            void navigator.clipboard.writeText(enrollment).then(
              () => setMessage('Enrollment request copied. Send it privately to the relay operator.'),
              () => setMessage('Clipboard unavailable. Select and copy the enrollment request manually.'),
            )
          }}>Copy enrollment request</button>
          <em className="hint">
            This request contains only the public installation key. A relay operator can bind one
            member role to this key so a copied invitation cannot connect from another installation.
          </em>
          {message ? <span role="status">{message}</span> : null}
        </>
      ) : null}
    </div>
  )
}
