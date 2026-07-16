// Save-format migrations: everything that reconciles an OLDER persisted store with the CURRENT
// shape lives here, out of store.ts. This is zustand-persist's `merge` — it runs on every boot,
// shallow-merging the persisted slices over the defaults and backfilling fields added since the
// save was written. Every block is idempotent: a fully-migrated save passes through unchanged.
import type { Settings, Expert, Ask } from './types'
import { defaultExperts } from './seed'
import { isResearchProjectManifest, type ResearchProjectManifest } from './workspace/schema'

/** The persisted data slices the migrations touch (the rest of the save passes through as-is). */
interface PersistedData {
  settings: Settings
  experts: Expert[]
  asks: Ask[]
  projects: ResearchProjectManifest[]
  activeProjectId: string | null
}

/**
 * Merge a persisted save over the current defaults, migrating old shapes:
 * - experts: seed built-ins on first run; backfill newly shipped built-ins by id
 * - settings: deep-merge so new fields (including localAiEnabled) keep defaults; guard against a broken baseUrl
 */
export function mergePersisted<S extends PersistedData>(persisted: unknown, current: S): S {
  const p = (persisted ?? {}) as Partial<PersistedData>
  // Seed built-in experts on first run; backfill any newly shipped built-ins
  // (matched by id) into existing saves without disturbing the user's own
  // experts or their edits. (A deleted built-in reappears on next load.)
  const persistedExperts = Array.isArray(p.experts) ? p.experts : []
  const seenExpertIds = new Set(persistedExperts.map((e) => e.id))
  const experts = persistedExperts.length
    ? [...persistedExperts, ...defaultExperts.filter((e) => !seenExpertIds.has(e.id))]
    : defaultExperts
  const mergedSettings = { ...current.settings, ...((p.settings ?? {}) as Partial<Settings>) }
  const projects = Array.isArray(p.projects) ? p.projects.filter(isResearchProjectManifest) : current.projects
  const requestedActiveProjectId = typeof p.activeProjectId === 'string' ? p.activeProjectId : null
  const activeProjectId = projects.some((project) => project.id === requestedActiveProjectId && !project.archivedAt)
    ? requestedActiveProjectId
    : (projects.find((project) => !project.archivedAt)?.id ?? null)
  // Guard against a save with a missing/relative baseUrl (e.g. an old dev proxy).
  if (!mergedSettings.baseUrl || mergedSettings.baseUrl.startsWith('/')) {
    mergedSettings.baseUrl = current.settings.baseUrl
  }
  // Backfill the baked-in Google client ID/secret onto saves that predate them.
  if (!mergedSettings.googleClientId) {
    mergedSettings.googleClientId = current.settings.googleClientId
  }
  if (!mergedSettings.googleClientSecret) {
    mergedSettings.googleClientSecret = current.settings.googleClientSecret
  }
  // Saves from before the paper design carry the old default theme — move them to the new
  // default once. (A deliberately chosen dark preset like 'cyber' is left alone.)
  if (!mergedSettings.theme || mergedSettings.theme === 'penumbra') {
    mergedSettings.theme = 'syzygy'
  }
  return {
    ...current,
    ...p,
    experts,
    projects,
    activeProjectId,
    settings: mergedSettings,
  }
}
