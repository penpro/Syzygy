import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DriveProjectControls } from './DriveProjectControls'
import type { ResearchProjectManifest } from './schema'

const localProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-local',
  documentId: 'document-local',
  title: 'Local draft',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}

describe('Drive project controls UI contract', () => {
  it('offers shared-project discovery from the empty workspace', () => {
    const html = renderToStaticMarkup(createElement(DriveProjectControls))
    expect(html).toContain('Shared Drive projects')
    expect(html).toContain('Refresh')
    expect(html).toContain('Joining selects the exact shared folder')
  })

  it('keeps sharing disabled until the local collaborative document is ready', () => {
    const html = renderToStaticMarkup(createElement(DriveProjectControls, { project: localProject }))
    expect(html).toContain('Share this project')
    expect(html).toContain('Preparing local project')
    expect(html).toContain('disabled')
  })

  it('labels a Drive binding honestly while its provider starts', () => {
    const html = renderToStaticMarkup(createElement(DriveProjectControls, {
      project: { ...localProject, transport: { kind: 'drive', workspaceId: 'workspace-1' } },
    }))
    expect(html).toContain('Drive shared · starting sync')
  })
})
