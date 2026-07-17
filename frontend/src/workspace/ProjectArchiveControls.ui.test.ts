import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProjectArchiveControlsContent } from './ProjectArchiveControls'
import type { ResearchProjectManifest } from './schema'

const project: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'archive-ui-project',
  title: 'Portable research',
  documentId: 'archive-ui-document',
  createdAt: 10,
  updatedAt: 20,
  transport: { kind: 'local' },
}

const render = (props: Partial<Parameters<typeof ProjectArchiveControlsContent>[0]> = {}) =>
  renderToStaticMarkup(createElement(ProjectArchiveControlsContent, {
    project,
    documentReady: true,
    busy: false,
    status: '',
    error: '',
    onExport: vi.fn(),
    onChooseImport: vi.fn(),
    ...props,
  }))

describe('portable project archive UI contract', () => {
  it('offers export and import with an accessible archive label', () => {
    const html = render()
    expect(html).toContain('aria-label="Portable project archive"')
    expect(html).toContain('Export offline copy')
    expect(html).toContain('Import offline copy')
  })

  it('keeps import available without an existing project', () => {
    const html = render({ project: null, documentReady: false })
    expect(html).not.toContain('Export offline copy')
    expect(html).toContain('Import offline copy')
  })

  it('disables export until the live document is ready and reports failures', () => {
    const preparing = render({ documentReady: false })
    expect(preparing).toContain('Export offline copy</button>')
    expect(preparing).toContain('disabled=""')
    expect(preparing).toContain('Preparing project data…')

    const failed = render({ error: 'Archive checksum does not match' })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Archive checksum does not match')
  })
})