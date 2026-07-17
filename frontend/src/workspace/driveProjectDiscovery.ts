import { logInfo } from '../log'
import {
  googleDriveProjectList,
  googleDriveWorkspace,
  type DriveProjectDescriptor,
  type DriveWorkspace,
  type DriveWorkspaceOption,
} from '../tauri'

const MAX_DIAGNOSTIC_PROJECTS = 200

export interface DriveProjectDiscoveryDiagnostic {
  connected: boolean
  workspace: { name: string; folderCode: string } | null
  projectCount: number
  projects: Array<{ projectId: string; documentId: string }>
  truncated: boolean
  checkedAt: number
}

export interface DriveProjectDiscoveryResult {
  workspace: DriveWorkspace | null
  descriptors: DriveProjectDescriptor[]
  diagnostic: DriveProjectDiscoveryDiagnostic
}

interface DiscoveryDependencies {
  workspace: () => Promise<DriveWorkspace | null>
  list: () => Promise<DriveProjectDescriptor[]>
  now: () => number
  log: (message: string) => void
}

const defaultDependencies: DiscoveryDependencies = {
  workspace: googleDriveWorkspace,
  list: googleDriveProjectList,
  now: Date.now,
  log: (message) => logInfo('drive-projects', message),
}

export function driveWorkspaceCode(id: string): string {
  const normalized = id.trim().replace(/[^A-Za-z0-9_-]/g, '')
  return normalized ? normalized.slice(-8) : 'unknown'
}

export function driveWorkspaceLabel(workspace: Pick<DriveWorkspace, 'id' | 'name'>): string {
  return `${workspace.name} · folder ${driveWorkspaceCode(workspace.id)}`
}

export function driveWorkspaceOptionLabel(option: DriveWorkspaceOption): string {
  const modified = Date.parse(option.modified)
  const suffix = Number.isFinite(modified)
    ? ` · modified ${new Date(modified).toLocaleDateString()}`
    : ''
  return `${driveWorkspaceLabel(option)}${suffix}`
}

export async function refreshDriveProjectDiscovery(
  dependencies: DiscoveryDependencies = defaultDependencies,
): Promise<DriveProjectDiscoveryResult> {
  const checkedAt = dependencies.now()
  const workspace = await dependencies.workspace()
  if (!workspace) {
    dependencies.log('Shared-project discovery stopped: no Drive workspace is selected')
    return {
      workspace: null,
      descriptors: [],
      diagnostic: {
        connected: false,
        workspace: null,
        projectCount: 0,
        projects: [],
        truncated: false,
        checkedAt,
      },
    }
  }

  const descriptors = await dependencies.list()
  if (descriptors.some((descriptor) => descriptor.workspaceId !== workspace.id)) {
    throw new Error('Drive returned a shared project from outside the selected workspace.')
  }
  const projects = descriptors.slice(0, MAX_DIAGNOSTIC_PROJECTS).map((descriptor) => ({
    projectId: descriptor.projectId,
    documentId: descriptor.documentId,
  }))
  const folderCode = driveWorkspaceCode(workspace.id)
  dependencies.log(`Shared-project discovery checked folder ${folderCode}: ${descriptors.length} project(s)`)
  return {
    workspace,
    descriptors,
    diagnostic: {
      connected: true,
      workspace: { name: workspace.name, folderCode },
      projectCount: descriptors.length,
      projects,
      truncated: descriptors.length > projects.length,
      checkedAt,
    },
  }
}
