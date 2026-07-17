import { describe, expect, it, vi } from 'vitest'
import type { DriveProjectDescriptor, DriveWorkspace } from '../tauri'
import {
  driveWorkspaceLabel,
  refreshDriveProjectDiscovery,
} from './driveProjectDiscovery'

const workspace: DriveWorkspace = { id: 'drive-folder-alpha-12345678', name: 'Syzygy' }

function descriptor(index: number, workspaceId = workspace.id): DriveProjectDescriptor {
  return {
    schemaVersion: 1,
    projectId: `project-${index}`,
    documentId: `document-${index}`,
    title: `Secret project title ${index}`,
    createdAt: index,
    workspaceId,
    workspaceName: workspace.name,
  }
}

describe('Drive project discovery diagnostics', () => {
  it('distinguishes same-name Drive folders without exposing their complete IDs', () => {
    const alpha = driveWorkspaceLabel(workspace)
    const beta = driveWorkspaceLabel({ id: 'drive-folder-beta-87654321', name: 'Syzygy' })
    expect(alpha).toBe('Syzygy · folder 12345678')
    expect(beta).toBe('Syzygy · folder 87654321')
    expect(alpha).not.toContain(workspace.id)
  })

  it('returns bounded content-free project identity for MCP and LAN comparison', async () => {
    const log = vi.fn()
    const result = await refreshDriveProjectDiscovery({
      workspace: async () => workspace,
      list: async () => Array.from({ length: 205 }, (_, index) => descriptor(index)),
      now: () => 42,
      log,
    })
    expect(result.diagnostic).toMatchObject({
      connected: true,
      workspace: { name: 'Syzygy', folderCode: '12345678' },
      projectCount: 205,
      truncated: true,
      checkedAt: 42,
    })
    expect(result.diagnostic.projects).toHaveLength(200)
    expect(JSON.stringify(result.diagnostic)).not.toContain('Secret project title')
    expect(log).toHaveBeenCalledWith('Shared-project discovery checked folder 12345678: 205 project(s)')
  })

  it('does not contact Drive project listing without a selected workspace', async () => {
    const list = vi.fn(async () => [descriptor(1)])
    const result = await refreshDriveProjectDiscovery({
      workspace: async () => null,
      list,
      now: () => 7,
      log: vi.fn(),
    })
    expect(result.diagnostic.connected).toBe(false)
    expect(list).not.toHaveBeenCalled()
  })

  it('fails closed if a descriptor claims another workspace', async () => {
    await expect(refreshDriveProjectDiscovery({
      workspace: async () => workspace,
      list: async () => [descriptor(1, 'another-workspace')],
      now: () => 1,
      log: vi.fn(),
    })).rejects.toThrow('outside the selected workspace')
  })
})
