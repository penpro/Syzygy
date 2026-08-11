// Save-format migrations: everything that reconciles an OLDER persisted store with the CURRENT
// shape lives here, out of store.ts. This is zustand-persist's `merge` — it runs on every boot,
// shallow-merging the persisted slices over the defaults and backfilling fields added since the
// save was written. Every block is idempotent: a fully-migrated save passes through unchanged.
import type * as Y from 'yjs'
import type { Settings, Expert, Ask } from './types'
import { defaultExperts } from './seed'
import { isResearchProjectManifest, type ResearchProjectManifest } from './workspace/schema'
import { getProjectSharedTypes } from './workspace/projectModel'
import { migrateScenarioCollectionToV2, type ScenarioCollectionMigrationResult } from './workspace/scenarioModel'
import {
  getPolicyContentText,
  initializePolicyContent,
  normalizePolicyContentDelta,
  POLICY_CONTENT_SCHEMA_VERSION,
  policyContentFingerprint,
  readPolicyContent,
  readPolicyContentStatus,
  type PolicyContentDelta,
  type StablePolicyStatus,
} from './workspace/policyContentModel'

export const PERSISTED_STORE_VERSION = 7

export interface LegacyPolicyContentSeed {
  policyId: string
  status: StablePolicyStatus
  delta: unknown
}

export interface PolicyContentDocumentMigrationResult {
  schemaVersion: typeof POLICY_CONTENT_SCHEMA_VERSION
  initialized: number
  existing: number
}

/** Idempotently upgrades every valid scenario record after local/remote state has loaded. */
export function migrateScenarioDocument(doc: Y.Doc): ScenarioCollectionMigrationResult {
  return migrateScenarioCollectionToV2(getProjectSharedTypes(doc).scenarios)
}

/**
 * Idempotently backfills the stable policy-content roots for a local project before it is shared.
 * Every seed is validated before the first Yjs write so a conflict cannot leave a partial migration.
 * Existing Drive projects do not call this automatically: their reorder gate remains closed until a
 * coordinated migration can prove one baseline for every peer.
 */
export function migrateLocalPolicyContentDocument(
  doc: Y.Doc,
  seedsValue: readonly LegacyPolicyContentSeed[],
): PolicyContentDocumentMigrationResult {
  const { metadata } = getProjectSharedTypes(doc)
  const currentVersion = metadata.get('policyContentSchemaVersion')
  if (currentVersion !== undefined && currentVersion !== POLICY_CONTENT_SCHEMA_VERSION) {
    throw new Error('Policy content document schema version is unsupported')
  }
  const seen = new Set<string>()
  const seeds = seedsValue.map((seed) => {
    if (seen.has(seed.policyId)) throw new Error('Policy content migration contains a duplicate policyId')
    seen.add(seed.policyId)
    if (!['draft', 'review', 'approved'].includes(seed.status)) throw new Error('Policy content migration status is invalid')
    return {
      policyId: seed.policyId,
      status: seed.status,
      delta: normalizePolicyContentDelta(seed.delta) as PolicyContentDelta,
    }
  })
  let existing = 0
  const pending = seeds.filter((seed) => {
    const current = readPolicyContent(doc, seed.policyId)
    if (current) {
      if (policyContentFingerprint(current) !== policyContentFingerprint(seed.delta) ||
        readPolicyContentStatus(doc, seed.policyId) !== seed.status) {
        throw new Error('Policy content migration conflicts with an existing stable record')
      }
      existing += 1
      return false
    }
    const shared = getPolicyContentText(doc, seed.policyId)
    if (shared.length !== 0 || Object.keys(shared.getAttributes()).length !== 0) {
      throw new Error('Policy content migration found unindexed shared data')
    }
    return true
  })
  doc.transact(() => {
    for (const seed of pending) {
      initializePolicyContent(doc, seed.policyId, seed.delta, {
        status: seed.status,
        origin: 'syzygy-policy-content-document-migration',
      })
    }
    metadata.set('policyContentSchemaVersion', POLICY_CONTENT_SCHEMA_VERSION)
  }, 'syzygy-policy-content-document-migration')
  return { schemaVersion: POLICY_CONTENT_SCHEMA_VERSION, initialized: pending.length, existing }
}

/**
 * Zustand rewrites storage only when its numbered migration runs. Version 7 accepts only the strict
 * device-bound relay access-v3 shape used by v4 invitations. Version 6 adds a strict managed
 * relay access-v2 shape carrying the capability generation and operator-clock expiry shown in v3
 * invitations. Version 5 access-v1 and version 4 legacy room-bearer transports remain readable;
 * mergePersisted rejects partial, unknown, or malformed managed-member shapes.
 */
export function migratePersistedVersion(persisted: unknown, storedVersion: number): unknown {
  if (!Number.isInteger(storedVersion) || storedVersion < 0 || storedVersion > PERSISTED_STORE_VERSION) {
    throw new Error('Invalid or unsupported persisted store version')
  }
  return persisted ?? {}
}

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
