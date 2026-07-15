import { useEffect, useState } from 'react'
import { listModels } from './tauri'
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
  const [showModelPicker, setShowModelPicker] = useState(false) // reopenable model-download wizard (Settings → Manage models)
  const [showTutorial, setShowTutorial] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const updateSettings = useStore((s) => s.updateSettings)

  // Opt-in crash reporting: only when the user has flipped the Settings toggle (and a DSN is
  // baked in) does the Sentry module even load. Default state sends nothing, ever.
  useEffect(() => {
    if (crashReportsAvailable && useStore.getState().settings.crashReports) startCrashReports()
  }, [])

  // First run: if no model has been downloaded yet, show the setup wizard.
  // Once a model exists, run the welcome tour until it's dismissed with "don't show again".
  useEffect(() => {
    listModels()
      .then((models) => {
        setNeedsSetup(models.length === 0)
        if (models.length > 0 && !useStore.getState().settings.seenWelcome) setShowWelcome(true)
      })
      .catch(() => setNeedsSetup(false)) // not running under Tauri (browser dev) — skip
  }, [])

  useEffect(() => {
    const r = document.documentElement
    r.setAttribute('data-theme', theme)
    r.setAttribute('data-reduce-motion', String(reduceMotion))
    r.setAttribute('data-contrast', highContrast ? 'high' : 'normal')
  }, [theme, reduceMotion, highContrast])

  return (
    <>
      <TitleBar />
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

      {needsSetup && (
        <SetupWizard
          onReady={() => {
            setNeedsSetup(false)
            // brand-new user just finished setup — greet them with the welcome tour
            if (!useStore.getState().settings.seenWelcome) setShowWelcome(true)
          }}
        />
      )}
      </div>
      <ResizeHandles />
      {/* First-run setup runs standalone — the splash must not sit on top of it waiting to load a
          model that doesn't exist yet. The splash only covers the model load, so it mounts once a
          model is present (either already, or after setup completes), never during setup itself. */}
      {!needsSetup && <SplashScreen />}
    </>
  )
}
