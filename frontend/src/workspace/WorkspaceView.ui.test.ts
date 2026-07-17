import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { LocalProjectSharingPanel, WorkspaceView } from './WorkspaceView'

const localProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'workspace-sharing-project',
  documentId: 'workspace-sharing-document',
  title: 'Local collaboration draft',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
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
})
