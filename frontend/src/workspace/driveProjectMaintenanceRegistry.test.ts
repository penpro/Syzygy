import { describe, expect, it, vi } from 'vitest'
import {
  compactDriveProject,
  compactDriveProjectTitle,
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
      activeEventCount: 1,
      snapshotCount: 0,
      tips: [],
    }
    const titleCompaction = {
      snapshotRevision: 'retained-title-revision',
      retainedEventCount: 1,
      activeEventCountBefore: 1,
      activeEventCountAfter: 0,
      archivedRecordCount: 1,
      failedArchiveCount: 0,
      remainingRecordCount: 0,
      complete: true,
      state: { ...titleState, activeEventCount: 0, snapshotCount: 1 },
    }
    const first = {
      compactNow: vi.fn(async () => result),
      compactTitleNow: vi.fn(async () => titleCompaction),
      updateTitle: vi.fn(async () => titleState),
    }
    const second = {
      compactNow: vi.fn(async () => ({ ...result, snapshotUpdateId: 'snapshot-2' })),
      compactTitleNow: vi.fn(async () => titleCompaction),
      updateTitle: vi.fn(async () => titleState),
    }
    const unregisterFirst = registerDriveProjectMaintenance(projectId, first)
    const unregisterSecond = registerDriveProjectMaintenance(projectId, second)

    unregisterFirst()
    expect(driveProjectMaintenanceReady(projectId)).toBe(true)
    await expect(compactDriveProject(projectId)).resolves.toMatchObject({ snapshotUpdateId: 'snapshot-2' })
    expect(first.compactNow).not.toHaveBeenCalled()
    expect(second.compactNow).toHaveBeenCalledOnce()
    await expect(compactDriveProjectTitle(projectId, ['revision']))
      .resolves.toMatchObject({ snapshotRevision: 'retained-title-revision' })
    expect(first.compactTitleNow).not.toHaveBeenCalled()
    expect(second.compactTitleNow).toHaveBeenCalledOnce()
    await expect(updateDriveProjectTitle(projectId, 'Renamed', ['base'], 'alice', 'Alice'))
      .resolves.toEqual(titleState)
    expect(first.updateTitle).not.toHaveBeenCalled()
    expect(second.updateTitle).toHaveBeenCalledOnce()

    unregisterSecond()
    expect(driveProjectMaintenanceReady(projectId)).toBe(false)
    await expect(compactDriveProject(projectId)).rejects.toThrow('not ready for maintenance')
  })
})
