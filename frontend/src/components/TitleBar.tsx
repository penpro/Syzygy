import { getCurrentWindow } from '@tauri-apps/api/window'
import { SyzygyMark } from './SyzygyMark'
import { ModelBar } from './ModelBar'

// The main menu bar: brand + window controls. The window uses decorations:false, so the bar
// surface is a Tauri drag region and the controls call the window API. getCurrentWindow() is
// resolved lazily so a non-Tauri context (browser dev) doesn't fault.
// (Aphelion's mode tabs lived here; Syzygy has a single Ask surface, so the nav is gone.)
export function TitleBar() {
  const win = () => getCurrentWindow()
  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar-brand" data-tauri-drag-region>
        <SyzygyMark size={16} />
        <span className="brand-word">SYZYGY</span>
      </div>
      <div className="topbar-spacer" data-tauri-drag-region />
      <ModelBar />
      <div className="titlebar-controls">
        <button className="tb-btn" aria-label="Minimize" title="Minimize" onClick={() => win().minimize()}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <line x1="2" y1="5.5" x2="9" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button className="tb-btn" aria-label="Maximize" title="Maximize" onClick={() => win().toggleMaximize()}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <rect x="2" y="2" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button className="tb-btn tb-close" aria-label="Close" title="Close" onClick={() => win().close()}>
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
            <line x1="2.5" y1="2.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="8.5" y1="2.5" x2="2.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
