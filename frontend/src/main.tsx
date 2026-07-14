import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ConfirmProvider } from './components/ConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
// Syzygy type system — IBM Plex (bundled, offline)
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-serif/400.css'
import '@fontsource/ibm-plex-serif/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/700.css'
import './brand-tokens.css'
import './styles.css'
import './a11y.css'
import './ui-polish.css'
import 'highlight.js/styles/github-dark.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
