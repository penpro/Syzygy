import type { DriveProjectCompactionResult } from '../tauri'

export interface DriveProjectMaintenance {
  compactNow(assertSnapshotReady?: () => void): Promise<DriveProjectCompactionResult>
}

const maintenanceByProject = new Map<string, DriveProjectMaintenance>()

export function registerDriveProjectMaintenance(
  projectId: string,
  maintenance: DriveProjectMaintenance,
): () => void {
  maintenanceByProject.set(projectId, maintenance)
  return () => {
    if (maintenanceByProject.get(projectId) === maintenance) {
      maintenanceByProject.delete(projectId)
    }
  }
}

export function driveProjectMaintenanceReady(projectId: string): boolean {
  return maintenanceByProject.has(projectId)
}

export async function compactDriveProject(
  projectId: string,
  assertSnapshotReady?: () => void,
): Promise<DriveProjectCompactionResult> {
  const maintenance = maintenanceByProject.get(projectId)
  if (!maintenance) throw new Error(`Drive project ${projectId} is not ready for maintenance`)
  return maintenance.compactNow(assertSnapshotReady)
}
