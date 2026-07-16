import { describe, expect, it } from 'vitest'
import { mergePersisted } from './migrations'
import { defaultSettings } from './seed'
import { createProjectManifest } from './workspace/schema'

const current = {
  settings: defaultSettings,
  experts: [],
  asks: [],
  projects: [],
  activeProjectId: null,
  untouchedRuntimeValue: 'current',
}

describe('persisted-store migrations', () => {
  it('defaults legacy saves to local AI on but preserves an explicit opt-out', () => {
    const legacySettings = { ...defaultSettings } as Partial<typeof defaultSettings>
    delete legacySettings.localAiEnabled
    const legacy = mergePersisted({ settings: legacySettings, experts: [], asks: [] }, current)
    const optedOut = mergePersisted({ settings: { ...defaultSettings, localAiEnabled: false }, experts: [], asks: [] }, current)
    expect(legacy.settings.localAiEnabled).toBe(true)
    expect(optedOut.settings.localAiEnabled).toBe(false)
  })

  it('backfills project collections into a pre-workspace save idempotently', () => {
    const legacy = { settings: defaultSettings, experts: [], asks: [] }
    const once = mergePersisted(legacy, current)
    const twice = mergePersisted(once, current)
    expect(once.projects).toEqual([])
    expect(once.activeProjectId).toBeNull()
    expect(twice.projects).toEqual(once.projects)
    expect(twice.activeProjectId).toBe(once.activeProjectId)
  })

  it('drops malformed manifests and selects a valid surviving project', () => {
    const project = createProjectManifest({ id: 'p-1', documentId: 'd-1', timestamp: 1 })
    const merged = mergePersisted(
      {
        settings: defaultSettings,
        experts: [],
        asks: [],
        projects: [{ schemaVersion: 99 }, project],
        activeProjectId: 'missing',
      },
      current,
    )
    expect(merged.projects).toEqual([project])
    expect(merged.activeProjectId).toBe('p-1')
  })
})
