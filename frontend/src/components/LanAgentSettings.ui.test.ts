import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LanAgentSettings, lanConnectionStatus } from './LanAgentSettings'

describe('LanAgentSettings', () => {
  it('offers app-owned developer hosting while keeping the default outbound boundary honest', () => {
    const markup = renderToStaticMarkup(createElement(LanAgentSettings))
    expect(markup).toContain('Private LAN test connection')
    expect(markup).toContain('Host the collaboration developer network on this computer')
    expect(markup).toContain('starts and supervises the interconnect server with Syzygy')
    expect(markup).toContain('stops and reaps it during shutdown')
    expect(markup).toContain('PowerShell is diagnostic-only')
    expect(markup).toContain('outbound encrypted control connection')
    expect(markup).toContain('never opens a LAN listener')
    expect(markup).toContain('does not sync research data by itself')
    expect(markup).toContain('Copy the pairing file from the host computer')
    expect(markup).toContain('LAN pairing file')
    expect(markup).toContain('Choose the file copied from the host')
    expect(markup).toContain('Apply developer connection')
    expect(markup).toContain('running process is not reported as connected')
    expect(markup).toContain('Reconnect now')
  })

  it('does not call an unsaved host toggle enabled or recovering', () => {
    const config = {
      enabled: false,
      nodeId: 'syzygy-node',
      coordinator: '',
      port: 37_663,
      keyFile: '',
    }
    expect(lanConnectionStatus({
      busy: false,
      draft: { ...config, enabled: true },
      hostEnabled: true,
      report: {
        config,
        running: false,
        pid: null,
        connectionState: 'off',
        lastEventAtMs: null,
        lastConnectedAtMs: null,
        reconnectCount: 0,
        retryInMs: null,
        lastError: null,
      },
      hostReport: {
        config: { enabled: false, listen: '', port: 37_663, keyFile: '' },
        running: false,
        pid: null,
        controlPort: null,
        lastError: null,
      },
    })).toBe('Changes not applied')
  })
})
