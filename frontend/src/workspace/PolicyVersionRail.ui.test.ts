import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PolicyVersion } from './policyVersionModel'
import {
  assertVersionRailHistory,
  PolicyVersionRailContent,
  selectVersionRailEntry,
} from './PolicyVersionRail'

const root: PolicyVersion = {
  schemaVersion: 1,
  versionId: 'a'.repeat(64),
  projectId: 'version-ui-project',
  parentVersionId: null,
  policy: {
    format: 'syzygy-semantic-blocks-v1',
    blocks: [{ kind: 'policy', policyId: 'rule-1', status: 'draft', text: 'Original rule.' }],
  },
  scenarioIds: [],
  author: { participantId: 'researcher-1', displayName: 'Ada' },
  createdAt: 10,
  note: 'Initial draft',
}

const child: PolicyVersion = {
  ...root,
  versionId: 'b'.repeat(64),
  parentVersionId: root.versionId,
  policy: {
    ...root.policy,
    blocks: [{ kind: 'policy', policyId: 'rule-1', status: 'review', text: 'Changed rule.' }],
  },
  createdAt: 20,
  note: 'Evidence review',
}

const noop = vi.fn()
const render = (props: Parameters<typeof PolicyVersionRailContent>[0]) =>
  renderToStaticMarkup(createElement(PolicyVersionRailContent, props))

describe('policy version rail UI contract', () => {
  it('renders accessible save controls, current head metadata, and an engine-free selected diff', () => {
    const html = render({
      ready: true,
      versions: [root, child],
      headVersionId: child.versionId,
      selectedVersionId: child.versionId,
      note: '',
      busy: false,
      error: '',
      savedStatus: '',
      onSelect: noop,
      onNoteChange: noop,
      onSave: noop,
    })
    expect(html).toContain('aria-label="Project versions"')
    expect(html).toContain('Version note')
    expect(html).toContain('Save current draft')
    expect(html).toContain('Version 2')
    expect(html).toContain('Current head')
    expect(html).toContain('1 change: 0 added, 0 removed, 1 changed, 0 moved; 0 unchanged.')
    expect(html).toContain('Changed rule.')
    expect(html).toContain('Inspection is read-only')
  })

  it('selects a version only from the supplied verified history and waits for the live project', () => {
    expect(selectVersionRailEntry([root, child], 'c'.repeat(64))).toEqual({
      version: null,
      parent: null,
      diff: null,
      changeNote: null,
    })
    expect(() => selectVersionRailEntry([child], child.versionId)).toThrow('missing parent')
    expect(() => assertVersionRailHistory([root], 2, root.versionId)).toThrow('invalid checkpoint')
    expect(() => assertVersionRailHistory([root], 1, child.versionId)).toThrow('head is missing')
    expect(() => assertVersionRailHistory([child], 1, child.versionId)).toThrow('missing parent')
    const html = render({
      ready: false,
      versions: [],
      headVersionId: null,
      selectedVersionId: null,
      note: '',
      busy: false,
      error: '',
      savedStatus: '',
      onSelect: noop,
      onNoteChange: noop,
      onSave: noop,
    })
    expect(html).toContain('Opening the live project')
    expect(html).toContain('disabled=""')
    const blockedHtml = render({
      ready: false,
      versions: [],
      headVersionId: null,
      selectedVersionId: null,
      note: '',
      busy: false,
      error: 'Version history contains an invalid checkpoint',
      savedStatus: '',
      onSelect: noop,
      onNoteChange: noop,
      onSave: noop,
    })
    expect(blockedHtml).toContain('role="alert"')
    expect(blockedHtml).toContain('Version history contains an invalid checkpoint')
    expect(blockedHtml).toContain('disabled=""')
    expect(blockedHtml).not.toContain('Opening the live project')
  })
})
