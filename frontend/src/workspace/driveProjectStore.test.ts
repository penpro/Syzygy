import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'

const localProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-1',
  documentId: 'document-1',
  title: 'Research',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}

afterEach(() => {
  useStore.setState({ projects: [], activeProjectId: null, view: 'ask' })
})

describe('Drive project store binding', () => {
  it('opens shared-project discovery without archiving or changing existing projects', () => {
    useStore.setState({ projects: [localProject], activeProjectId: localProject.id, view: 'ask' })
    useStore.getState().browseSharedProjects()
    expect(useStore.getState().projects).toEqual([localProject])
    expect(useStore.getState().activeProjectId).toBeNull()
    expect(useStore.getState().view).toBe('workspace')
  })

  it('binds an existing local identity to exactly one selected workspace', () => {
    useStore.setState({ projects: [localProject] })
    useStore.getState().bindProjectToDrive(localProject.id, 'workspace-1')
    expect(useStore.getState().projects[0].transport).toEqual({ kind: 'drive', workspaceId: 'workspace-1' })
    expect(() => useStore.getState().bindProjectToDrive(localProject.id, 'workspace-2')).toThrow(
      'already bound to a different Drive workspace',
    )
  })

  it('joins a Drive manifest without changing its shared identity', () => {
    const shared: ResearchProjectManifest = {
      ...localProject,
      transport: { kind: 'drive', workspaceId: 'workspace-1' },
    }
    useStore.getState().addSharedProject(shared)
    expect(useStore.getState().projects).toEqual([shared])
    expect(useStore.getState().activeProjectId).toBe(shared.id)
    expect(useStore.getState().view).toBe('workspace')
    expect(() => useStore.getState().addSharedProject(shared)).toThrow('already exists')
  })
})
