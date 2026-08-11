import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { LocalProjectSharingPanel, WorkspaceView } from './WorkspaceView'
import {
  editSharedProjectTitleDraft,
  SharedProjectTitleControl,
  syncSharedProjectTitleDraft,
} from './SharedProjectTitleControl'

const localProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'workspace-sharing-project',
  documentId: 'workspace-sharing-document',
  title: 'Local collaboration draft',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}
const driveProject: ResearchProjectManifest = {
  ...localProject,
  id: 'workspace-shared-project',
  documentId: 'workspace-shared-document',
  title: 'Shared collaboration draft',
  transport: { kind: 'drive', workspaceId: 'workspace-drive' },
}

let previousProjects: ResearchProjectManifest[]
let previousActiveProjectId: string | null

beforeEach(() => {
  const state = useStore.getState()
  previousProjects = state.projects
  previousActiveProjectId = state.activeProjectId
  useStore.setState({ projects: [], activeProjectId: null })
})

afterEach(() => {
  useStore.setState({
    projects: previousProjects,
    activeProjectId: previousActiveProjectId,
  })
})

describe('workspace collaboration entry points', () => {
  it('offers Drive setup outside Ask even when no project is open', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceView))

    expect(html).toContain('Google Drive connection')
    expect(html).toContain('Link Drive')
    expect(html).toContain('Create research project')
    expect(html).toContain('Import offline copy')
    expect(html).toContain('Shared Drive projects')
  })

  it('distinguishes live Drive sharing from an independent offline copy', () => {
    const html = renderToStaticMarkup(createElement(LocalProjectSharingPanel, { project: localProject }))

    expect(html).toContain('This project is private on this computer')
    expect(html).toContain('ongoing collaboration')
    expect(html).toContain('Offline copies do not keep syncing')
    expect(html).toContain('Share this project')
    expect(html).toContain('Export offline copy')
  })

  it('makes a Drive-shared title an explicit synchronized action instead of a read-only field', () => {
    const html = renderToStaticMarkup(createElement(SharedProjectTitleControl, { project: driveProject }))

    expect(html).toContain('aria-label="Shared project title"')
    expect(html).toContain('Rename shared project')
    expect(html).toContain('Loading shared title')
    expect(html).not.toContain('Shared project titles are fixed')
  })

  it('retains the exact revision guards captured when a shared-title draft became dirty', () => {
    const original = {
      schemaVersion: 1 as const,
      projectId: driveProject.id,
      documentId: driveProject.documentId,
      baseTitle: driveProject.title,
      title: driveProject.title,
      revisionGuards: ['a'.repeat(64)],
      conflict: false,
      eventCount: 0,
      activeEventCount: 0,
      snapshotCount: 0,
      tips: [],
    }
    const changed = editSharedProjectTitleDraft(
      { title: original.title, revisionGuards: original.revisionGuards, dirty: false },
      'Offline draft title',
      original,
    )
    const peerUpdate = {
      ...original,
      title: 'Peer title',
      revisionGuards: ['b'.repeat(64)],
      eventCount: 1,
    }

    expect(syncSharedProjectTitleDraft(changed, peerUpdate)).toEqual(changed)
    expect(changed.revisionGuards).toEqual(original.revisionGuards)
    expect(changed.revisionGuards).not.toEqual(peerUpdate.revisionGuards)
  })
})
