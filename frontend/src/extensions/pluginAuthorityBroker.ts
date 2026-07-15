import {
  validatePluginChangeProposal,
  validateResearchPluginManifest,
  type PluginCapability,
  type PluginChangeProposal,
  type ResearchPluginManifest,
} from './pluginManifest'

const SESSION_LIFETIME_MS = 15 * 60 * 1000
const MAX_PROJECT_CONTENT = 200_000
const MAX_SOURCE_IDS = 10_000

export interface PluginAuthorityGrant {
  capabilities: PluginCapability[]
  networkDomains: string[]
  modelProviders: string[]
}

export interface PluginProjectSnapshot {
  projectId: string
  revision: string
  semanticText: string
  sourceSnapshotIds: string[]
}

export interface PluginHostSessionStatus {
  sessionId: string
  pluginId: string
  pluginVersion: string
  projectId: string
  capabilities: PluginCapability[]
  expiresAt: string
}

export interface PluginProposalReceipt {
  status: 'pending-human-review'
  proposal: PluginChangeProposal
}

export interface PluginNetworkAuthorization {
  url: string
  method: 'GET'
  maxResponseBytes: number
  requiresPublicAddressRecheck: true
}

export interface PluginModelAuthorization {
  provider: string
  requiresProviderDisclosure: boolean
  requiresProviderRunRecord: true
}

export interface PluginDriveAuthorization {
  workspaceId: string
  mode: 'read' | 'propose'
  requiresTargetRecheck: true
}

type Session = {
  manifest: ResearchPluginManifest
  grant: PluginAuthorityGrant
  snapshot: PluginProjectSnapshot
  expiresAtMs: number
}

const unique = (values: string[]) => new Set(values).size === values.length
const validId = (value: unknown, max = 500): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function domainMatches(pattern: string, hostname: string) {
  const normalizedPattern = pattern.toLowerCase()
  const normalizedHostname = hostname.toLowerCase()
  if (!normalizedPattern.startsWith('*.')) return normalizedHostname === normalizedPattern
  const suffix = normalizedPattern.slice(1)
  return normalizedHostname.endsWith(suffix) && normalizedHostname.length > suffix.length
}

function isForbiddenHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    !normalized.includes('.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
    normalized.includes(':')
  )
}

export class PluginHostError extends Error {
  readonly code:
    | 'invalid-session'
    | 'session-expired'
    | 'permission-denied'
    | 'invalid-request'
    | 'stale-revision'
    | 'target-denied'

  constructor(code: PluginHostError['code']) {
    super('Plugin host request denied')
    this.name = 'PluginHostError'
    this.code = code
  }
}

export class ResearchPluginAuthorityBroker {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sessionId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  openSession(
    manifest: ResearchPluginManifest,
    grant: PluginAuthorityGrant,
    snapshot: PluginProjectSnapshot,
  ): PluginHostSessionStatus {
    if (validateResearchPluginManifest(manifest).length > 0) throw new PluginHostError('invalid-request')
    if (
      !validId(snapshot.projectId, 200) ||
      !validId(snapshot.revision) ||
      typeof snapshot.semanticText !== 'string' ||
      snapshot.semanticText.length > MAX_PROJECT_CONTENT ||
      !stringList(snapshot.sourceSnapshotIds) ||
      snapshot.sourceSnapshotIds.length > MAX_SOURCE_IDS ||
      !unique(snapshot.sourceSnapshotIds) ||
      snapshot.sourceSnapshotIds.some((id) => !validId(id, 200)) ||
      !stringList(grant.capabilities) ||
      !stringList(grant.networkDomains) ||
      !stringList(grant.modelProviders) ||
      !unique(grant.capabilities) ||
      !unique(grant.networkDomains) ||
      !unique(grant.modelProviders) ||
      grant.capabilities.some((capability) => !manifest.permissions.capabilities.includes(capability)) ||
      grant.networkDomains.some((domain) => !manifest.permissions.networkDomains.includes(domain)) ||
      grant.modelProviders.some((provider) => !manifest.permissions.modelProviders.includes(provider)) ||
      (grant.networkDomains.length > 0 && !grant.capabilities.includes('network.fetch')) ||
      (grant.modelProviders.length > 0 && !grant.capabilities.includes('model.invoke'))
    ) {
      throw new PluginHostError('invalid-request')
    }
    const id = this.sessionId()
    if (!validId(id, 200) || this.sessions.has(id)) throw new PluginHostError('invalid-request')
    const expiresAtMs = this.now() + SESSION_LIFETIME_MS
    const session: Session = {
      manifest: structuredClone(manifest),
      grant: structuredClone(grant),
      snapshot: structuredClone(snapshot),
      expiresAtMs,
    }
    this.sessions.set(id, session)
    return this.status(id, session)
  }

  sessionStatus(sessionId: string): PluginHostSessionStatus {
    const session = this.session(sessionId)
    return this.status(sessionId, session)
  }

  revokeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  readProject(sessionId: string): PluginProjectSnapshot {
    const session = this.require(sessionId, 'project.read')
    return structuredClone(session.snapshot)
  }

  submitProjectProposal(sessionId: string, proposal: PluginChangeProposal): PluginProposalReceipt {
    const session = this.require(sessionId, 'project.propose')
    if (validatePluginChangeProposal(proposal).length > 0) throw new PluginHostError('invalid-request')
    if (proposal.pluginId !== session.manifest.id || proposal.projectId !== session.snapshot.projectId) {
      throw new PluginHostError('target-denied')
    }
    if (proposal.expectedRevision !== session.snapshot.revision) throw new PluginHostError('stale-revision')
    return { status: 'pending-human-review', proposal: structuredClone(proposal) }
  }

  authorizeNetworkFetch(sessionId: string, target: string): PluginNetworkAuthorization {
    const session = this.require(sessionId, 'network.fetch')
    let url: URL
    try {
      url = new URL(target)
    } catch {
      throw new PluginHostError('invalid-request')
    }
    if (
      url.protocol !== 'https:' ||
      (url.port !== '' && url.port !== '443') ||
      url.username ||
      url.password ||
      isForbiddenHostname(url.hostname) ||
      !session.grant.networkDomains.some((domain) => domainMatches(domain, url.hostname))
    ) {
      throw new PluginHostError('target-denied')
    }
    return {
      url: url.toString(),
      method: 'GET',
      maxResponseBytes: 1024 * 1024,
      requiresPublicAddressRecheck: true,
    }
  }

  authorizeModelInvocation(sessionId: string, provider: string): PluginModelAuthorization {
    const session = this.require(sessionId, 'model.invoke')
    if (!validId(provider, 64) || !session.grant.modelProviders.includes(provider)) {
      throw new PluginHostError('target-denied')
    }
    return { provider, requiresProviderDisclosure: provider !== 'local', requiresProviderRunRecord: true }
  }

  authorizeDriveAccess(
    sessionId: string,
    workspaceId: string,
    selectedWorkspaceId: string,
    mode: 'read' | 'propose',
  ): PluginDriveAuthorization {
    this.require(sessionId, mode === 'read' ? 'drive.read' : 'drive.propose')
    if (!validId(workspaceId, 200) || workspaceId !== selectedWorkspaceId) {
      throw new PluginHostError('target-denied')
    }
    return { workspaceId, mode, requiresTargetRecheck: true }
  }

  private require(sessionId: string, capability: PluginCapability) {
    const session = this.session(sessionId)
    if (!session.grant.capabilities.includes(capability)) throw new PluginHostError('permission-denied')
    return session
  }

  private session(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new PluginHostError('invalid-session')
    if (session.expiresAtMs <= this.now()) {
      this.sessions.delete(sessionId)
      throw new PluginHostError('session-expired')
    }
    return session
  }

  private status(sessionId: string, session: Session): PluginHostSessionStatus {
    return {
      sessionId,
      pluginId: session.manifest.id,
      pluginVersion: session.manifest.version,
      projectId: session.snapshot.projectId,
      capabilities: [...session.grant.capabilities],
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    }
  }
}
