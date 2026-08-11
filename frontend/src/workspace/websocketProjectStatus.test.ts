import { describe, expect, it, vi } from 'vitest'
import {
  getWebsocketProjectStatus,
  registerWebsocketProjectStatus,
  subscribeWebsocketProjectStatus,
} from './websocketProjectStatus'

describe('self-hosted project status registry', () => {
  it('publishes detached state and ignores stale provider cleanup', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeWebsocketProjectStatus('project', listener)
    const first = registerWebsocketProjectStatus('project')
    first.publish({ state: 'connected', syncedAt: 10 })
    const detached = getWebsocketProjectStatus('project')!
    detached.state = 'error'
    expect(getWebsocketProjectStatus('project')).toEqual({ state: 'connected', syncedAt: 10 })

    const replacement = registerWebsocketProjectStatus('project')
    first.unregister()
    first.publish({ state: 'error', error: 'stale' })
    expect(getWebsocketProjectStatus('project')).toEqual({ state: 'connecting' })
    replacement.publish({ state: 'disconnected' })
    expect(getWebsocketProjectStatus('project')).toEqual({ state: 'disconnected' })
    replacement.unregister()
    expect(getWebsocketProjectStatus('project')).toBeNull()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})
