import { describe, expect, it, vi } from 'vitest'
import type { DriveProjectTitleState } from '../tauri'
import {
  clearDriveProjectTitleState,
  currentDriveProjectTitleState,
  publishDriveProjectTitleState,
  subscribeDriveProjectTitleState,
} from './driveProjectTitleStatus'

const state = (title: string): DriveProjectTitleState => ({
  projectId: 'project-title-status',
  documentId: 'document-title-status',
  baseTitle: 'Base',
  title,
  revisionGuards: [`revision-${title}`],
  conflict: false,
  eventCount: 1,
  activeEventCount: 1,
  snapshotCount: 0,
  tips: [],
})

describe('Drive project title status', () => {
  it('keeps replacement state when an older provider disconnects', () => {
    const projectId = `title-status-${crypto.randomUUID()}`
    const older = {}
    const replacement = {}
    const listener = vi.fn()
    const unsubscribe = subscribeDriveProjectTitleState(projectId, listener)

    publishDriveProjectTitleState(projectId, older, state('Older'))
    publishDriveProjectTitleState(projectId, replacement, state('Replacement'))
    clearDriveProjectTitleState(projectId, older)

    expect(currentDriveProjectTitleState(projectId)?.title).toBe('Replacement')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Replacement' }))
    clearDriveProjectTitleState(projectId, replacement)
    expect(currentDriveProjectTitleState(projectId)).toBeNull()
    expect(listener).toHaveBeenLastCalledWith(null)
    unsubscribe()
  })
})
