import type * as Y from 'yjs'
import {
  collaborationRelayAdminPolicyConfigure,
  collaborationRelayRoomStatus,
  collaborationRelaySettings,
  type CollaborationRelayReport,
  type RelayAdminPolicyConfig,
  type RelayRoomMembershipReport,
} from '../tauri'
import type { ResearchProjectManifest } from './schema'
import { getProjectSharedTypes } from './projectModel'
import {
  inspectProjectDeviceDirectory,
  type ProjectDeviceDirectoryInspection,
} from './projectDeviceDirectory'

export interface RelayPolicyAutomationDependencies {
  relaySettings: () => Promise<CollaborationRelayReport>
  roomStatus: (roomId: string) => Promise<RelayRoomMembershipReport>
  configure: (
    roomId: string,
    expectedRevision: number,
    config: RelayAdminPolicyConfig | null,
  ) => Promise<RelayRoomMembershipReport>
  inspectDirectory: (document: Y.Doc, projectId: string) => Promise<ProjectDeviceDirectoryInspection>
}

export interface RelayPolicyAutomationInput {
  enabled: boolean
  expectedRegistryRevision: number
  requiredApprovals?: number
  signerKeyIds?: string[]
}

const DEFAULT_DEPENDENCIES: RelayPolicyAutomationDependencies = {
  relaySettings: collaborationRelaySettings,
  roomStatus: collaborationRelayRoomStatus,
  configure: collaborationRelayAdminPolicyConfigure,
  inspectDirectory: (document, projectId) => inspectProjectDeviceDirectory(
    getProjectSharedTypes(document).settings,
    projectId,
  ),
}

function summarizeRoom(room: RelayRoomMembershipReport) {
  const active = room.members.filter(({ revokedAtMs }) => revokedAtMs === null)
  return {
    schemaVersion: 1 as const,
    projectId: room.projectId,
    roomId: room.roomId,
    registryRevision: room.registryRevision,
    memberCounts: {
      total: room.members.length,
      active: active.length,
      revoked: room.members.length - active.length,
      admins: active.filter(({ role }) => role === 'admin').length,
      editors: active.filter(({ role }) => role === 'editor').length,
      viewers: active.filter(({ role }) => role === 'viewer').length,
      deviceBound: active.filter(({ deviceKeyId }) => deviceKeyId !== null).length,
      bearerOnly: active.filter(({ deviceKeyId }) => deviceKeyId === null).length,
    },
    policy: room.adminPolicy ? {
      schemaVersion: room.adminPolicy.schemaVersion,
      requiredApprovals: room.adminPolicy.requiredApprovals,
      configuredAtMs: room.adminPolicy.configuredAtMs,
      signerKeyIds: [...room.adminPolicy.signerKeyIds],
    } : null,
  }
}

function summarizeDirectory(directory: ProjectDeviceDirectoryInspection) {
  return {
    healthy: directory.healthy,
    registrationCount: directory.registrationCount,
    conflictingDevices: directory.conflictingDevices,
    invalidRecords: directory.invalidRecords,
    unavailableRecords: directory.unavailableRecords,
    excessRecords: directory.excessRecords,
    eligibleSigners: directory.devices.map((device) => ({
      keyId: device.keyId,
      participantIds: [...device.participantIds],
      eligible: device.status === 'registered-device',
    })),
  }
}

async function context(
  project: ResearchProjectManifest,
  document: Y.Doc,
  dependencies: RelayPolicyAutomationDependencies,
) {
  if (project.transport.kind !== 'websocket') {
    throw new Error('The active project is not connected to a self-hosted relay')
  }
  const relay = await dependencies.relaySettings()
  if (!relay.running || !relay.endpoint || relay.endpoint !== project.transport.endpoint) {
    throw new Error('The active project is not hosted by this running Syzygy relay installation')
  }
  const [room, directory] = await Promise.all([
    dependencies.roomStatus(project.transport.roomId),
    dependencies.inspectDirectory(document, project.id),
  ])
  if (room.projectId !== project.id || room.roomId !== project.transport.roomId) {
    throw new Error('The local relay room does not match the active project identity')
  }
  return { room, directory }
}

export async function inspectHostedRelayPolicy(
  project: ResearchProjectManifest,
  document: Y.Doc,
  dependencies: RelayPolicyAutomationDependencies = DEFAULT_DEPENDENCIES,
) {
  const { room, directory } = await context(project, document, dependencies)
  return {
    hostedHere: true as const,
    room: summarizeRoom(room),
    projectDeviceDirectory: summarizeDirectory(directory),
    authority: 'installation-device-keys-not-people-or-organizations' as const,
    hostEmergencyAuthority: true as const,
    secretsReturned: false as const,
  }
}

export async function configureHostedRelayPolicy(
  project: ResearchProjectManifest,
  document: Y.Doc,
  input: RelayPolicyAutomationInput,
  dependencies: RelayPolicyAutomationDependencies = DEFAULT_DEPENDENCIES,
) {
  const { room, directory } = await context(project, document, dependencies)
  if (!Number.isSafeInteger(input.expectedRegistryRevision) || input.expectedRegistryRevision < 1 ||
    room.registryRevision !== input.expectedRegistryRevision) {
    throw new Error('Relay membership changed; inspect the policy and retry with its exact registry revision')
  }
  let config: RelayAdminPolicyConfig | null = null
  if (input.enabled) {
    const signerKeyIds = input.signerKeyIds
    const requiredApprovals = input.requiredApprovals
    if (!directory.healthy || !Array.isArray(signerKeyIds) || signerKeyIds.length < 1 ||
      signerKeyIds.length > 16 || new Set(signerKeyIds).size !== signerKeyIds.length ||
      !Number.isSafeInteger(requiredApprovals) || Number(requiredApprovals) < 1 ||
      Number(requiredApprovals) > signerKeyIds.length) {
      throw new Error('Relay approval policy requires a healthy directory, 1-16 unique signers, and a bounded quorum')
    }
    const requested = new Set(signerKeyIds)
    const signers = directory.devices
      .filter(({ keyId, status }) => requested.has(keyId) && status === 'registered-device')
      .map(({ keyId, publicKey }) => ({
        schemaVersion: 1 as const,
        algorithm: 'Ed25519' as const,
        keyId,
        publicKey,
      }))
    if (signers.length !== requested.size) {
      throw new Error('Every relay approval signer must be one exact unconflicted registered project installation')
    }
    config = {
      schemaVersion: 1,
      requiredApprovals: Number(requiredApprovals),
      signers,
    }
  } else if (input.requiredApprovals !== undefined || input.signerKeyIds !== undefined) {
    throw new Error('Disabled relay approval policy must not include a quorum or signer set')
  }
  const changed = await dependencies.configure(
    room.roomId,
    input.expectedRegistryRevision,
    config,
  )
  if (changed.projectId !== project.id || changed.roomId !== room.roomId ||
    changed.registryRevision !== room.registryRevision + 1) {
    throw new Error('Relay policy response did not prove the expected revision transition')
  }
  const expectedSignerKeyIds = config?.signers.map(({ keyId }) => keyId).sort() ?? []
  const returnedSignerKeyIds = changed.adminPolicy?.signerKeyIds ?? []
  if ((config === null && changed.adminPolicy !== undefined) ||
    (config !== null && (
      changed.adminPolicy?.schemaVersion !== 1 ||
      changed.adminPolicy.requiredApprovals !== config.requiredApprovals ||
      returnedSignerKeyIds.length !== expectedSignerKeyIds.length ||
      returnedSignerKeyIds.some((keyId, index) => keyId !== expectedSignerKeyIds[index])
    ))) {
    throw new Error('Relay policy response did not prove the requested policy transition')
  }
  return {
    hostedHere: true as const,
    room: summarizeRoom(changed),
    projectDeviceDirectory: summarizeDirectory(directory),
    authority: 'installation-device-keys-not-people-or-organizations' as const,
    hostEmergencyAuthority: true as const,
    secretsReturned: false as const,
  }
}
