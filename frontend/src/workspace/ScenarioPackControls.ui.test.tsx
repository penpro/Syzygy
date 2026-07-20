import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ScenarioPackControlsContent } from './ScenarioPackControls'

const noop = vi.fn()
const base: Parameters<typeof ScenarioPackControlsContent>[0] = {
  ready: true,
  healthy: true,
  scenarioCount: 2,
  selectedTitle: 'Skeptical branch',
  title: 'Reusable source review',
  description: '',
  license: 'CC0-1.0',
  busy: false,
  pending: null,
  status: '',
  error: '',
  onTitle: noop,
  onDescription: noop,
  onLicense: noop,
  onExportSelected: noop,
  onExportAll: noop,
  onChooseImport: noop,
  onConfirmImport: noop,
  onCancelImport: noop,
}

describe('scenario pack product controls', () => {
  it('discloses the portable boundary and offers selected, complete, and import paths', () => {
    const html = renderToStaticMarkup(createElement(ScenarioPackControlsContent, base))
    expect(html).toContain('aria-label="Portable scenario packs"')
    expect(html).toContain('Export selected: Skeptical branch')
    expect(html).toContain('Export all')
    expect(html).toContain('Choose pack to import')
    expect(html).toContain('full revision and edit history')
    expect(html).toContain('Excludes votes, annotations, labels, model outputs, policies, and project files')
    expect(html).toContain('Import does not contact a model or network')
  })

  it('requires explicit confirmation after validation and reports collisions accessibly', () => {
    const pending = {
      pack: {
        format: 'syzygy-scenario-pack' as const, schemaVersion: 1 as const, packId: 'pack',
        title: 'Validated pack', description: '', license: null,
        source: {
          projectId: 'source', documentId: 'document', projectTitle: 'Source', exportedBy: 'author',
          exportedByDisplayName: 'Author', exportedAt: 1,
        },
        scenarios: [],
        checksum: { algorithm: 'SHA-256' as const, canonicalization: 'syzygy-json-v1' as const, value: '0'.repeat(64) },
      },
      plan: { addScenarioIds: ['one'], existingScenarioIds: ['two'], collisionScenarioIds: [] },
    }
    const html = renderToStaticMarkup(createElement(ScenarioPackControlsContent, { ...base, pending }))
    expect(html).toContain('Validated pack')
    expect(html).toContain('1 new')
    expect(html).toContain('1 already present')
    expect(html).toContain('Import validated pack')
    const failed = renderToStaticMarkup(createElement(ScenarioPackControlsContent, { ...base, error: 'Scenario ID collision: one' }))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Scenario ID collision: one')
  })
})
