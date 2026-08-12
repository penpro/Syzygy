import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import {
  codexMcpInstallLocal,
  mcpConnectionInfo,
  openPath,
  type McpConnectionInfo,
} from '../tauri'

type CopyTarget = 'json' | 'toml' | 'connection' | 'starter'

export const CODEX_CONNECT_LABEL = 'Connect Codex on this computer'
export const CODEX_RESTART_COPY = 'Restart Codex once'

function CopyButton({ value, target, copied, onCopy }: {
  value: string
  target: CopyTarget
  copied: CopyTarget | null
  onCopy: (target: CopyTarget, value: string) => void
}) {
  return (
    <button className="btn sm ghost" type="button" onClick={() => onCopy(target, value)}>
      {copied === target ? 'Copied' : 'Copy'}
    </button>
  )
}

export function McpSetupModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<McpConnectionInfo | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [format, setFormat] = useState<'json' | 'toml'>('json')
  const [installingCodex, setInstallingCodex] = useState(false)
  const [codexMessage, setCodexMessage] = useState('')

  useEffect(() => {
    let active = true
    mcpConnectionInfo()
      .then((next) => {
        if (active) setInfo(next)
      })
      .catch(() => {
        if (active) {
          setError('Installation details are unavailable. Open the packaged Syzygy desktop app and try again; if this keeps happening, open Settings → View log.')
        }
      })
    return () => {
      active = false
    }
  }, [])

  const copy = async (target: CopyTarget, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(target)
      window.setTimeout(() => setCopied((current) => current === target ? null : current), 1600)
    } catch {
      setError('Clipboard access is unavailable. Select the text and copy it manually.')
    }
  }

  const revealFolder = async () => {
    if (!info) return
    try {
      await openPath(info.installFolder)
    } catch {
      setError('The install folder could not be opened. Copy the path above and open it with your file manager.')
    }
  }

  const config = format === 'json' ? info?.genericJson : info?.codexToml

  const installCodex = async () => {
    setInstallingCodex(true)
    setError('')
    setCodexMessage('')
    try {
      const result = await codexMcpInstallLocal()
      setCodexMessage(result.restartRequired
        ? `Connected in ${result.configPath}. ${CODEX_RESTART_COPY}; future tasks can pilot this installed Syzygy directly.`
        : `Codex is already connected through ${result.serverName}. No configuration change was needed.`)
    } catch (nextError) {
      setError((nextError as { message?: string })?.message ?? String(nextError))
    } finally {
      setInstallingCodex(false)
    }
  }

  return (
    <Modal title="Connect an LLM" onClose={onClose} wide footer={<div className="row full"><div className="grow" /><button className="btn" onClick={onClose}>Done</button></div>}>
      <div className="mcp-setup">
        <p className="mcp-intro">
          Syzygy includes a local MCP server that lets an MCP-capable assistant pilot the live research workspace.
          It uses this installed app directly—there is no separate server download or mirrored project database.
        </p>

        {!info && !error && <div className="mcp-status" role="status">Inspecting this Syzygy installation…</div>}
        {error && <div className="mcp-error" role="alert">{error}</div>}

        {info && (
          <>
            <section className="mcp-step" aria-labelledby="mcp-install-heading">
              <div className="mcp-step-head">
                <span className="mcp-step-number" aria-hidden="true">1</span>
                <div>
                  <h3 id="mcp-install-heading">Use this Syzygy installation</h3>
                  <p>Detected from the running app. Moving or reinstalling Syzygy can change this path.</p>
                </div>
              </div>
              <dl className="mcp-facts">
                <div><dt>Executable</dt><dd><code>{info.executablePath}</code></dd></div>
                <div><dt>Install folder</dt><dd><code>{info.installFolder}</code></dd></div>
                <div><dt>Server</dt><dd><code>{info.serverName}</code> · {info.transport} · MCP {info.protocolVersion}</dd></div>
              </dl>
              <button className="btn sm ghost" type="button" onClick={revealFolder}>Open install folder</button>
            </section>

            <section className="mcp-step" aria-labelledby="mcp-config-heading">
              <div className="mcp-step-head">
                <span className="mcp-step-number" aria-hidden="true">2</span>
                <div>
                  <h3 id="mcp-config-heading">Connect your assistant</h3>
                  <p>Codex can be configured here in one click. Copy configuration only for another MCP-capable client.</p>
                </div>
              </div>
              <div className="row gap">
                <button className="btn sm" type="button" disabled={installingCodex} onClick={() => void installCodex()}>
                  {installingCodex ? 'Connecting Codex…' : CODEX_CONNECT_LABEL}
                </button>
                <span className="hint">Writes prompt by default; read-only inspection can run unattended.</span>
              </div>
              {codexMessage ? <div className="mcp-status" role="status">{codexMessage}</div> : null}
              <div className="mcp-format" role="group" aria-label="Configuration format">
                <button className={format === 'json' ? 'btn sm' : 'btn sm ghost'} type="button" onClick={() => setFormat('json')}>JSON hosts</button>
                <button className={format === 'toml' ? 'btn sm' : 'btn sm ghost'} type="button" onClick={() => setFormat('toml')}>Codex TOML</button>
              </div>
              <textarea className="mcp-copy-area mono" readOnly value={config ?? ''} aria-label={`${format.toUpperCase()} MCP configuration`} />
              <CopyButton value={config ?? ''} target={format} copied={copied} onCopy={copy} />
            </section>

            <section className="mcp-step" aria-labelledby="mcp-prompt-heading">
              <div className="mcp-step-head">
                <span className="mcp-step-number" aria-hidden="true">3</span>
                <div>
                  <h3 id="mcp-prompt-heading">Connect another MCP client</h3>
                  <p>Use this only when the one-click Codex connection does not apply to that client.</p>
                </div>
              </div>
              <textarea className="mcp-copy-area mcp-prompt-area" readOnly value={info.connectionPrompt} aria-label="MCP connection prompt" />
              <CopyButton value={info.connectionPrompt} target="connection" copied={copied} onCopy={copy} />
            </section>

            <section className="mcp-step" aria-labelledby="mcp-first-task-heading">
              <div className="mcp-step-head">
                <span className="mcp-step-number" aria-hidden="true">4</span>
                <div>
                  <h3 id="mcp-first-task-heading">Try a safe first task</h3>
                  <p>This asks the assistant to explain what is live before proposing a change.</p>
                </div>
              </div>
              <textarea className="mcp-copy-area mcp-prompt-area" readOnly value={info.starterPrompt} aria-label="Syzygy starter prompt" />
              <CopyButton value={info.starterPrompt} target="starter" copied={copied} onCopy={copy} />
            </section>

            <p className="hint">
              The MCP can currently navigate projects and read or revision-safely edit the live document. It does not
              receive automatic Drive, filesystem, or local-model access. Syzygy will report unfinished workspace features as unavailable.
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}
