import { describe, expect, it, vi } from 'vitest'
import {
  compactDriveProject,
  driveProjectMaintenanceReady,
  registerDriveProjectMaintenance,
  updateDriveProjectTitle,
} from './driveProjectMaintenanceRegistry'

const result = {
  snapshotUpdateId: 'snapshot-1',
  snapshotByteLength: 128,
  activeUpdateCountBefore: 4,
  activeUpdateCountAfter: 2,
  archivedUpdateCount: 2,
  failedArchiveCount: 0,
  remainingIncludedUpdateCount: 0,
  retainedConcurrentUpdateCount: 1,
  complete: true,
}

describe('Drive project maintenance registry', () => {
  it('keeps a replacement provider registered when an older provider disconnects', async () => {
    const projectId = `maintenance-${crypto.randomUUID()}`
    const titleState = {
      projectId,
      documentId: 'document',
      baseTitle: 'Base',
      title: 'Renamed',
      revisionGuards: ['revision'],
      conflict: false,
      eventCount: 1,
      tips: [],
    }
    const first = {
      compactNow: vi.fn(async () => result),
      updateTitle: vi.fn(async () => titleState),
    }
    const second = {
      compactNow: vi.fn(async () => ({ ...result, snapshotUpdateId: 'snapshot-2' })),
      updateTitle: vi.fn(async () => titleState),
    }
    const unregisterFirst = registerDriveProjectMaintenance(projectId, first)
    const unregisterSecond = registerDriveProjectMaintenance(projectId, second)

    unregisterFirst()
    expect(driveProjectMaintenanceReady(projectId)).toBe(true)
    await expect(compactDriveProject(projectId)).resolves.toMatchObject({ snapshotUpdateId: 'snapshot-2' })
    expect(first.compactNow).not.toHaveBeenCalled()
    expect(second.compactNow).toHaveBeenCalledOnce()
    await expect(updateDriveProjectTitle(projectId, 'Renamed', ['base'], 'alice', 'Alice'))
      .resolves.toEqual(titleState)
    expect(first.updateTitle).not.toHaveBeenCalled()
    expect(second.updateTitle).toHaveBeenCalledOnce()

    unregisterSecond()
    expect(driveProjectMaintenanceReady(projectId)).toBe(false)
    await expect(compactDriveProject(projectId)).rejects.toThrow('not ready for maintenance')
  })
})
