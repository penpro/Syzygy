import { describe, expect, it } from 'vitest'
import { CODEX_CONNECT_LABEL, CODEX_RESTART_COPY } from './McpSetupModal'

describe('McpSetupModal', () => {
  it('connects Codex directly while keeping copyable config for other clients', () => {
    expect(CODEX_CONNECT_LABEL).toBe('Connect Codex on this computer')
    expect(CODEX_RESTART_COPY).toBe('Restart Codex once')
  })
})
