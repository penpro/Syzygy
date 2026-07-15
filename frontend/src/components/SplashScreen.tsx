import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { getEngineStatus } from '../api/ollama'
import { gpuVram } from '../tauri'
import { friendlyModelName } from '../models'
import { SyzygySplashMark } from './SyzygyMark'
import { cx } from '../util'

type Phase = 'down' | 'loading' | 'ready'

// Startup splash: covers the app while the bundled engine spins up and the model loads into VRAM
// (which can briefly hitch the UI). It's CSS-animated, so it stays smooth even if the main thread
// stutters, shows the VRAM filling as real progress, and auto-dismisses with a fade once ready.
export function SplashScreen() {
  const baseUrl = useStore((s) => s.settings.baseUrl)
  const fallback = useStore((s) => s.settings.model)
  const loadedModel = useStore((s) => s.loadedModel)
  const [phase, setPhase] = useState<Phase>('down')
  const [vram, setVram] = useState<{ used: number; total: number } | null>(null)
  const [fading, setFading] = useState(false)
  const [hidden, setHidden] = useState(false)
  const done = useRef(false)

  useEffect(() => {
    // Browser-only development and headless UI runs have no bundled engine. The OpenAI-compatible
    // health endpoint can still return a valid "down" response, so waiting for a thrown Tauri call
    // is not a reliable escape hatch and would leave the test surface covered for 90 seconds.
    if (!('__TAURI_INTERNALS__' in window)) {
      done.current = true
      setHidden(true)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      done.current = true
      setFading(true)
      setTimeout(() => alive && setHidden(true), 550)
    }
    const tick = async () => {
      if (done.current) return
      try {
        const [s, v] = await Promise.all([getEngineStatus(baseUrl), gpuVram().catch(() => null)])
        if (!alive) return
        setPhase(s)
        if (v) setVram(v)
        if (s === 'ready') return finish()
      } catch {
        // not under Tauri, or the engine is unreachable — never trap the user behind the splash
        if (alive) {
          done.current = true
          setHidden(true)
        }
        return
      }
      timer = setTimeout(tick, 700)
    }
    tick()
    // hard safety net: never block longer than 90s, whatever happens
    const safety = setTimeout(() => {
      if (alive && !done.current) finish()
    }, 90000)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      clearTimeout(safety)
    }
  }, [baseUrl])

  if (hidden) return null
  const model = friendlyModelName(loadedModel || fallback)
  const usedGb = vram ? vram.used / 1024 : 0
  const totalGb = vram ? vram.total / 1024 : 0
  const pct = vram && vram.total > 0 ? Math.min(100, (vram.used / vram.total) * 100) : 0

  return (
    <div className={cx('splash', fading && 'is-out')} data-tauri-drag-region>
      <div className="splash-inner">
        <div className="splash-mark">
          <SyzygySplashMark width={300} />
        </div>
        <div className="splash-title">SYZYGY</div>
        <div className="splash-msg">
          {phase === 'down' ? 'Warming up the engine…' : `Loading ${model} into memory…`}
        </div>
        {vram && (
          <div className="splash-vram">
            <div className="splash-bar">
              <i style={{ width: pct + '%' }} />
            </div>
            <div className="splash-vram-label">
              {usedGb.toFixed(1)} / {totalGb.toFixed(1)} GB
            </div>
          </div>
        )}
        <div className="splash-hint">First load takes a moment — the model is moving into your GPU's memory.</div>
      </div>
    </div>
  )
}
