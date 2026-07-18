const DEFAULT_RESTART_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000])

export function superviseLanAgent({
  spawnAgent,
  terminateAgent,
  log = () => {},
  restartDelaysMs = DEFAULT_RESTART_DELAYS_MS,
  stableAfterMs = 30_000,
}) {
  if (typeof spawnAgent !== 'function' || typeof terminateAgent !== 'function') {
    throw new TypeError('LAN agent supervision requires spawn and terminate functions')
  }
  if (!Array.isArray(restartDelaysMs) || restartDelaysMs.length === 0 || restartDelaysMs.some((delay) => !Number.isInteger(delay) || delay < 0)) {
    throw new TypeError('LAN agent restart delays must be a non-empty array of non-negative integers')
  }

  let activeAgent = null
  let restartTimer = null
  let stableTimer = null
  let stopping = false
  let consecutiveFailures = 0

  const clearTimers = () => {
    if (restartTimer) clearTimeout(restartTimer)
    if (stableTimer) clearTimeout(stableTimer)
    restartTimer = null
    stableTimer = null
  }

  const start = () => {
    if (stopping) return
    const child = spawnAgent()
    activeAgent = child
    let handled = false

    const restart = (reason) => {
      if (handled) return
      handled = true
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = null
      if (activeAgent === child) activeAgent = null
      if (stopping) return

      const delay = restartDelaysMs[Math.min(consecutiveFailures, restartDelaysMs.length - 1)]
      consecutiveFailures += 1
      log(`local agent stopped (${reason}); restarting in ${delay}ms`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        start()
      }, delay)
    }

    child.once('spawn', () => {
      log(`local agent started (pid ${child.pid})`)
      stableTimer = setTimeout(() => {
        if (!stopping && activeAgent === child && child.exitCode === null) {
          consecutiveFailures = 0
          log('local agent remained stable; restart backoff reset')
        }
      }, stableAfterMs)
    })
    child.once('error', (error) => restart(`spawn error: ${error.message}`))
    child.once('exit', (code, signal) => restart(`exit=${code ?? 'none'} signal=${signal ?? 'none'}`))
  }

  start()

  return {
    currentAgent: () => activeAgent,
    stop() {
      if (stopping) return
      stopping = true
      clearTimers()
      if (activeAgent) terminateAgent(activeAgent)
      activeAgent = null
    },
  }
}
