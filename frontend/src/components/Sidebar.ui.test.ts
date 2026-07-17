import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ResearchProjectManifest } from '../workspace/schema'
import { ProjectList } from './Sidebar'

const openProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-open',
  documentId: 'document-open',
  title: 'Open research project',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}


describe('Sidebar project discovery', () => {
  it('keeps shared-project browsing visible while a local project is open', () => {
    const html = renderToStaticMarkup(createElement(ProjectList, {
      projects: [openProject],
      activeProjectId: openProject.id,
      view: 'workspace',
      createProject: () => openProject.id,
      openProject: () => {},
      browseSharedProjects: () => {},
    }))

    expect(html).toContain('Browse shared projects')
    expect(html).toContain('Open research project')
  })
})
