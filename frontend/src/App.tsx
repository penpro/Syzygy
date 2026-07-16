import { lazy, Suspense, useEffect, useState } from 'react'
import { modelFiles, startEngine } from './tauri'
import { decideLocalAiStartup } from './localAi'
import { startCrashReports, crashReportsAvailable } from './crashReports'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { AskView } from './components/AskView'
import { SettingsPanel } from './components/SettingsPanel'
import { SetupWizard } from './components/SetupWizard'
import { Tutorial } from './components/Tutorial'
import { WelcomeTour } from './components/WelcomeTour'
import { TitleBar } from './components/TitleBar'
import { ResizeHandles } from './components/ResizeHandles'
import { SplashScreen } from './components/SplashScreen'
import { StorageBanner } from './components/StorageBanner'
import { startAutomationBridge } from './automationBridge'

const WorkspaceView = lazy(() => import('./workspace/WorkspaceView').then((module) => ({ default: module.WorkspaceView })))

// Syzygy strips the inherited roleplay surface (chat/story/tree views, character +
// persona editors) but keeps the files in-tree unrouted — restoring one is just
// an import + a route here. Ask mode (experts, documents, folder knowledge) stays.
export default function App() {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.settings.theme)
  const reduceMotion = useStore((s) => s.settings.reduceMotion)
  const highContrast = useStore((s) => s.settings.highContrast)
  const sidebarCollapsed = useStore((s) => !!s.settings.sidebarCollapsed)
  const [showSettings, setShowSettings] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [setupChecked, setSetupChecked] = useState(false)
  const [showStartupSplash, setShowStartupSplash] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false) // reopenable model-download wizard (Settings → Manage models)
  const [showTutorial, setShowTutorial] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const updateSettings = useStore((s) => s.updateSettings)

  // Opt-in crash reporting: only when the user has flipped the Settings toggle (and a DSN is
  // baked in) does the Sentry module even load. Default state sends nothing, ever.
  useEffect(() => {
    if (crashReportsAvailable && useStore.getState().settings.crashReports) startCrashReports()
  }, [])

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    void startAutomationBridge()
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch(() => {
        // Browser-only development has no Tauri event bridge. The typed invoke wrapper records
        // real packaged failures without exposing request arguments or research content.
      })
    return () => {
      disposed = true
      stop?.()
    }
  }, [])

  // The native shell starts no model until the persisted preference is read.
  // It then stays engine-free, offers setup, or starts the saved/downloaded model.
  useEffect(() => {
    let disposed = false
    const boot = async () => {
      try {
        const files = await modelFiles()
        if (disposed) return
        const settings = useStore.getState().settings
        const decision = decideLocalAiStartup(settings.localAiEnabled, settings.model, files)
        if (decision.kind === 'setup') {
          setNeedsSetup(true)
        } else if (decision.kind === 'start') {
          try {
            await startEngine(decision.filename)
            if (disposed) return
            updateSettings({ model: decision.filename })
            useStore.getState().setLoadedModel(decision.filename)
            setShowStartupSplash(true)
          } catch {
            // The header remains available for a retry; never trap the project UI behind a splash.
          }
          if (!useStore.getState().settings.seenWelcome) setShowWelcome(true)
        }
      } catch {
        // Browser-only development has no Tauri model directory; leave the workspace usable.
      } finally {
        if (!disposed) setSetupChecked(true)
      }
    }
    void boot()
    return () => {
      disposed = true
    }
  }, [updateSettings])

  useEffect(() => {
    const r = document.documentElement
    r.setAttribute('data-theme', theme)
    r.setAttribute('data-reduce-motion', String(reduceMotion))
    r.setAttribute('data-contrast', highContrast ? 'high' : 'normal')
  }, [theme, reduceMotion, highContrast])

  return (
    <>
      <TitleBar onNeedModel={() => setShowModelPicker(true)} />
      <StorageBanner />
      <div className="app">
      <a className="skip-link" href="#main-view">
        Skip to content
      </a>
      <Sidebar
        collapsed={sidebarCollapsed}
        onOpenSettings={() => setShowSettings(true)}
        onOpenTutorial={() => setShowTutorial(true)}
        onOpenWelcome={() => setShowWelcome(true)}
      />
      <button
        type="button"
        className={'dock-strip' + (sidebarCollapsed ? ' is-closed' : '')}
        title={sidebarCollapsed ? 'Show the sidebar' : 'Hide the sidebar'}
        aria-label={sidebarCollapsed ? 'Show the sidebar' : 'Hide the sidebar'}
        aria-expanded={!sidebarCollapsed}
        onClick={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
      >
        <span className="dock-chev">{sidebarCollapsed ? '▸' : '◂'}</span>
      </button>

      <main id="main-view" className="view-region">
        {view === 'ask' && <AskView />}
        {view === 'workspace' && (
          <Suspense fallback={<div className="workspace-loading mono">Opening research workspace…</div>}>
            <WorkspaceView />
          </Suspense>
        )}
      </main>

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} onOpenModelPicker={() => setShowModelPicker(true)} />
      )}
      {showModelPicker && (
        <SetupWizard onReady={() => setShowModelPicker(false)} onCancel={() => setShowModelPicker(false)} />
      )}
      {showTutorial && (
        <Tutorial
          onClose={() => {
            setShowTutorial(false)
            updateSettings({ seenTutorial: true })
          }}
        />
      )}
      {showWelcome && (
        <WelcomeTour
          onClose={(dontShowAgain) => {
            setShowWelcome(false)
            if (dontShowAgain) updateSettings({ seenWelcome: true })
          }}
          onOpenArchitecture={() => setShowTutorial(true)}
        />
      )}

      {setupChecked && needsSetup && (
        <SetupWizard
          onReady={() => {
            setNeedsSetup(false)
            // brand-new user just finished setup — greet them with the welcome tour
            if (!useStore.getState().settings.seenWelcome) setShowWelcome(true)
          }}
          onSkip={() => {
            updateSettings({ localAiEnabled: false })
            setNeedsSetup(false)
            if (!useStore.getState().settings.seenWelcome) setShowWelcome(true)
          }}
        />
      )}
      </div>
      <ResizeHandles />
      {/* The splash mounts only after an opted-in startup process has actually spawned. */}
      {setupChecked && !needsSetup && showStartupSplash && <SplashScreen />}
    </>
  )
}
