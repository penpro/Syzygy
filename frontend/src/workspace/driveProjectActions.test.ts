import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createProjectManifest } from './schema'
import {
  joinSharedDriveProject,
  shareProjectToSelectedDrive,
  type DriveProjectActionDependencies,
} from './driveProjectActions'

function dependencies(overrides: Partial<DriveProjectActionDependencies> = {}): DriveProjectActionDependencies {
  const project = createProjectManifest({
    id: 'project-1',
    documentId: 'document-1',
    title: 'Live collaboration proof',
    timestamp: 100,
  })
  return {
    workspace: vi.fn(async () => ({ id: 'workspace-1', name: 'Research' })),
    publish: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projectId: project.id,
      documentId: project.documentId,
      title: project.title,
      createdAt: project.createdAt,
      workspaceId: 'workspace-1',
      workspaceName: 'Research',
    })),
    discover: vi.fn(async () => ({
      projects: [{
        schemaVersion: 1 as const,
        projectId: project.id,
        documentId: project.documentId,
        title: project.title,
        createdAt: project.createdAt,
        workspaceId: 'workspace-1',
        workspaceName: 'Research',
      }],
      workspaceCount: 1,
      skippedRootCount: 0,
    })),
    selectWorkspace: vi.fn(async () => ({ id: 'workspace-1', name: 'Research' })),
    document: vi.fn(() => new Y.Doc()),
    revision: vi.fn(() => 'revision-1'),
    projects: vi.fn(() => []),
    bind: vi.fn(),
    add: vi.fn(),
    open: vi.fn(),
    ...overrides,
  }
}

describe('Drive project actions', () => {
  it('publishes an exact local identity before binding the project to Drive', async () => {
    const project = createProjectManifest({
      id: 'project-1', documentId: 'document-1', title: 'Live collaboration proof', timestamp: 100,
    })
    const deps = dependencies()
    const result = await shareProjectToSelectedDrive(project, 'revision-1', deps)
    expect(result.descriptor.projectId).toBe(project.id)
    expect(deps.bind).toHaveBeenCalledWith(project.id, 'workspace-1')
  })

  it('rejects a stale revision before publishing', async () => {
    const project = createProjectManifest({
      id: 'project-1', documentId: 'document-1', title: 'Live collaboration proof', timestamp: 100,
    })
    const deps = dependencies({ revision: () => 'revision-2' })
    await expect(shareProjectToSelectedDrive(project, 'revision-1', deps)).rejects.toThrow('changed before sharing')
    expect(deps.publish).not.toHaveBeenCalled()
    expect(deps.bind).not.toHaveBeenCalled()
  })

  it('refetches the exact catalog identity before joining and selecting its parent workspace', async () => {
    const deps = dependencies()
    const project = await joinSharedDriveProject({
      projectId: 'project-1', documentId: 'document-1', workspaceId: 'workspace-1',
    }, deps)
    expect(project.transport).toEqual({ kind: 'drive', workspaceId: 'workspace-1' })
    expect(deps.selectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(deps.add).toHaveBeenCalledWith(project)
  })

  it('fails closed when a local identity collision is not the same active Drive project', async () => {
    const collision = createProjectManifest({
      id: 'project-1', documentId: 'other-document', title: 'Collision', timestamp: 200,
    })
    const deps = dependencies({ projects: () => [collision] })
    await expect(joinSharedDriveProject({
      projectId: 'project-1', documentId: 'document-1', workspaceId: 'workspace-1',
    }, deps)).rejects.toThrow('different local project')
    expect(deps.add).not.toHaveBeenCalled()
  })
})
