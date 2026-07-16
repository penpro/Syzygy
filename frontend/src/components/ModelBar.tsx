import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { getEngineStatus, listModels } from '../api/ollama'
import { friendlyModelName } from '../models'
import { gpuVram, modelFiles, shutdownEngine, startEngine } from '../tauri'
import { decideLocalAiStartup } from '../localAi'
import { cx } from '../util'

type Status = 'off' | 'down' | 'loading' | 'ready'

const LABEL: Record<Status, string> = {
  off: 'Local AI is off',
  down: 'Starting local AI…',
  loading: 'Loading model — please wait…',
  ready: 'Local AI ready',
}

export function LocalAiToggle({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={cx('ts-ai-toggle', enabled && 'on')}
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? 'Turn local AI off' : 'Turn local AI on'}
      title={enabled ? 'Unload the local model and keep projects and remote APIs available' : 'Load a local model'}
      disabled={busy}
      onClick={onToggle}
    >
      <span className="ts-k">LOCAL AI</span>
      <span className="ts-switch" aria-hidden="true"><i /></span>
    </button>
  )
}

/** Engine/model status, an explicit lifecycle switch, model name, and live VRAM gauge. */
export function ModelBar({ onNeedModel }: { onNeedModel: () => void }) {
  const baseUrl = useStore((s) => s.settings.baseUrl)
  const fallback = useStore((s) => s.settings.model)
  const contextLength = useStore((s) => s.settings.contextLength)
  const localAiEnabled = useStore((s) => s.settings.localAiEnabled)
  const updateSettings = useStore((s) => s.updateSettings)
  const loadedModel = useStore((s) => s.loadedModel)
  const setLoadedModel = useStore((s) => s.setLoadedModel)
  const [status, setStatus] = useState<Status>(localAiEnabled ? 'down' : 'off')
  const [vram, setVram] = useState<{ used: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const tick = async () => {
      const v = await gpuVram()
      if (!alive) return
      setVram(v)
      if (!localAiEnabled) {
        setStatus('off')
        setLoadedModel(null)
        return
      }
      const [nextStatus, models] = await Promise.all([getEngineStatus(baseUrl), listModels(baseUrl)])
      if (!alive) return
      setStatus(nextStatus)
      setLoadedModel(models[0] ?? null)
    }
    void tick()
    const id = setInterval(() => void tick(), 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [baseUrl, localAiEnabled, setLoadedModel])

  const toggleLocalAi = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    if (localAiEnabled) {
      updateSettings({ localAiEnabled: false })
      setLoadedModel(null)
      try {
        await shutdownEngine()
      } catch (cause) {
        setError((cause as { message?: string })?.message ?? 'Could not stop the local engine.')
      } finally {
        setBusy(false)
      }
      return
    }

    try {
      const files = await modelFiles()
      const decision = decideLocalAiStartup(true, fallback, files)
      if (decision.kind !== 'start') {
        onNeedModel()
        return
      }
      updateSettings({ localAiEnabled: true, model: decision.filename })
      setLoadedModel(decision.filename)
      try {
        await startEngine(decision.filename)
      } catch (cause) {
        updateSettings({ localAiEnabled: false })
        setLoadedModel(null)
        throw cause
      }
    } catch (cause) {
      setError((cause as { message?: string })?.message ?? 'Could not start local AI.')
    } finally {
      setBusy(false)
    }
  }

  const dotColor = status === 'ready' ? 'var(--accent)' : status === 'loading' ? 'var(--warn)' : 'var(--faint)'
  const usedGb = vram ? vram.used / 1024 : 0
  const totalGb = vram ? vram.total / 1024 : 0
  const pct = vram && vram.total > 0 ? Math.min(100, (vram.used / vram.total) * 100) : 0
  const modelName = localAiEnabled ? friendlyModelName(loadedModel || fallback) : 'Off'
  const ctxLabel = contextLength >= 1024 ? `${Math.round(contextLength / 1024)}K` : String(contextLength)
  const statusLabel = error || LABEL[status]

  return (
    <div className="topbar-stats">
      <LocalAiToggle
        enabled={localAiEnabled}
        busy={busy}
        onToggle={() => void toggleLocalAi()}
      />
      <span
        className={cx('status-dot', status === 'ready' && 'live')}
        style={{ background: dotColor }}
        title={statusLabel}
      />
      <span className="ts-model" title={localAiEnabled ? loadedModel || fallback : 'No local model loaded'}>
        {busy ? 'Working…' : modelName}
      </span>
      {error && <span className="ts-engine-error" role="alert" title={error}>!</span>}
      {vram && (
        <span className="ts-chip" title={`VRAM ${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`}>
          <span className="ts-k">VRAM</span>
          <span className="ts-bar">
            <i style={{ width: pct + '%', background: pct > 92 ? 'var(--danger)' : 'var(--accent)' }} />
          </span>
          <span className="ts-v">
            {usedGb.toFixed(1)}/{totalGb.toFixed(0)}
          </span>
        </span>
      )}
      <span className="ts-chip" title="Context window">
        <span className="ts-k">CTX</span>
        <span className="ts-v">{ctxLabel}</span>
      </span>
    </div>
  )
}
