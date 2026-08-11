import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ScenarioCollaborationPanelContent,
  type ScenarioLabelRow,
} from './ScenarioCollaborationPanel'
import type { ScenarioAnnotation } from './scenarioAnnotationModel'
import type { ResearchScenario } from './scenarioModel'

const scenario: ResearchScenario = {
  schemaVersion: 2,
  id: 'scenario-collaboration-ui',
  title: 'Procurement exception',
  background: 'A reviewer needs to preserve dissent and context.',
  status: 'ready',
  parentScenarioId: null,
  createdBy: 'researcher-1',
  createdAt: 10,
  turns: [{
    id: 'turn-collaboration-ui',
    createdBy: 'researcher-1',
    createdAt: 10,
    role: 'user',
    content: 'Can this exception be granted?',
    headEditId: 'turn-collaboration-edit',
    tipEditIds: ['turn-collaboration-edit'],
    revisions: [{
      editId: 'turn-collaboration-edit', role: 'user', content: 'Can this exception be granted?',
      authorId: 'researcher-1', timestamp: 10, parentEditIds: [], source: 'create',
    }],
  }],
  edits: [{
    editId: 'scenario-collaboration-edit', authorId: 'researcher-1', timestamp: 10,
    fields: ['title'], changes: { title: 'Procurement exception' },
  }],
}

const annotation: ScenarioAnnotation = {
  id: 'annotation-ui-1',
  scenarioId: scenario.id,
  turnId: scenario.turns[0].id,
  kind: 'flag',
  body: 'The source does not establish delegated authority.',
  status: 'open',
  createdBy: 'researcher-1',
  createdByDisplayName: 'Ada',
  createdAt: 20,
  currentEventId: 'annotation-event-ui-1',
  lastActionBy: 'researcher-1',
  lastActionDisplayName: 'Ada',
  lastActionAt: 20,
  resolvedBy: null,
  resolvedAt: null,
  events: [{
    schemaVersion: 1,
    eventId: 'annotation-event-ui-1',
    annotationId: 'annotation-ui-1',
    scenarioId: scenario.id,
    turnId: scenario.turns[0].id,
    kind: 'flag',
    action: 'create',
    body: 'The source does not establish delegated authority.',
    authorId: 'researcher-1',
    displayName: 'Ada',
    timestamp: 20,
    parentEventId: null,
  }],
}

const labelRow: ScenarioLabelRow = {
  label: {
    id: 'label-ui-1',
    name: 'Needs legal review',
    createdBy: 'researcher-1',
    createdAt: 20,
    currentEventId: 'label-event-ui-1',
    lastActionBy: 'researcher-1',
    lastActionAt: 20,
    events: [{
      schemaVersion: 1,
      eventId: 'label-event-ui-1',
      labelId: 'label-ui-1',
      action: 'create',
      name: 'Needs legal review',
      authorId: 'researcher-1',
      timestamp: 20,
      parentEventId: null,
    }],
  },
  assignment: {
    scenarioId: scenario.id,
    labelId: 'label-ui-1',
    assigned: true,
    currentEventId: 'assignment-event-ui-1',
    lastActionBy: 'researcher-1',
    lastActionAt: 21,
    events: [{
      schemaVersion: 1,
      eventId: 'assignment-event-ui-1',
      scenarioId: scenario.id,
      labelId: 'label-ui-1',
      action: 'add',
      authorId: 'researcher-1',
      timestamp: 21,
      parentEventId: null,
    }],
  },
}

const noop = vi.fn()
const props: Parameters<typeof ScenarioCollaborationPanelContent>[0] = {
  scenario,
  annotations: [annotation],
  annotationTotal: 1,
  labels: [labelRow],
  labelTotal: 1,
  canWrite: true,
  annotationAttribution: null,
  annotationPending: false,
  integrityIssues: [],
  error: '',
  annotationKind: 'note',
  annotationTurnId: '',
  annotationBody: '',
  editingAnnotationId: null,
  annotationEditBody: '',
  labelName: '',
  renamingLabelId: null,
  labelRenameName: '',
  onAnnotationKind: noop,
  onAnnotationTurn: noop,
  onAnnotationBody: noop,
  onCreateAnnotation: noop,
  onStartAnnotationEdit: noop,
  onCancelAnnotationEdit: noop,
  onAnnotationEditBody: noop,
  onSaveAnnotationEdit: noop,
  onSetAnnotationResolved: noop,
  onMoreAnnotations: noop,
  onLabelName: noop,
  onCreateLabel: noop,
  onToggleLabel: noop,
  onStartLabelRename: noop,
  onCancelLabelRename: noop,
  onLabelRenameName: noop,
  onSaveLabelRename: noop,
  onMoreLabels: noop,
}

const render = (patch: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(ScenarioCollaborationPanelContent, { ...props, ...patch }))

describe('scenario collaboration product controls', () => {
  it('renders shared annotation lifecycle and exact label assignment controls without an AI dependency', () => {
    const html = render()
    expect(html).toContain('aria-label="Scenario notes and labels"')
    expect(html).toContain('aria-label="Add shared scenario annotation"')
    expect(html).toContain('Whole scenario')
    expect(html).toContain('Turn 1 · user')
    expect(html).toContain('The source does not establish delegated authority.')
    expect(html).toContain('>Edit</button>')
    expect(html).toContain('>Resolve</button>')
    expect(html).toContain('aria-label="Create shared scenario label"')
    expect(html).toContain('Needs legal review')
    expect(html).toContain('type="checkbox" checked=""')
    expect(html).toContain('>Rename</button>')
    expect(html).toContain('Researcher names and local time are self-reported')
    expect(html).not.toContain('Run model')
  })

  it('shows signed, unsigned, and pending annotation attribution without claiming human identity', () => {
    const signed = render({
      annotationAttribution: {
        status: 'signed-device',
        keyId: 'ed25519-sha256:abcdefghijklmnopqrstuv0123456789ABCDEFG',
        eventKind: 'scenario-annotation',
        eventId: '33:scenario-collaboration-uievent-1',
        eventSha256: 'abcdefghijklmnopqrstuv0123456789ABCDEFG',
        attestationCount: 1,
        authority: 'installation-device-not-human-identity',
      },
    })
    expect(signed).toContain('Shared annotation event signed by registered device')
    expect(signed).toContain('not a person or organization')

    const unsigned = render({
      annotationAttribution: {
        status: 'unsigned',
        reason: 'attestation-history-unhealthy',
        authority: 'installation-device-not-human-identity',
      },
    })
    expect(unsigned).toContain('Shared annotation saved without a device signature')
    expect(unsigned).toContain('signed attribution history needs attention')

    const pending = render({ annotationPending: true })
    expect(pending).toContain('Shared annotation saved. Checking registered-device attribution')
    expect(pending).toContain('<button class="btn sm" type="submit">Create label</button>')
  })

  it('shows edit and reopen workflows while preserving explicit shared-history language', () => {
    const editing = render({ editingAnnotationId: annotation.id, annotationEditBody: annotation.body })
    expect(editing).toContain('aria-label="Edit flag"')
    expect(editing).toContain('Save edit')

    const resolved: ScenarioAnnotation = {
      ...annotation,
      status: 'resolved',
      currentEventId: 'annotation-event-ui-2',
      resolvedBy: 'researcher-2',
      resolvedAt: 30,
    }
    const resolvedHtml = render({ annotations: [resolved] })
    expect(resolvedHtml).toContain('flag · resolved')
    expect(resolvedHtml).toContain('>Reopen</button>')
    expect(resolvedHtml).not.toContain('>Edit</button>')

    const renaming = render({ renamingLabelId: labelRow.label.id, labelRenameName: labelRow.label.name })
    expect(renaming).toContain('aria-label="Rename shared scenario label"')
    expect(renaming).toContain('Save name')
  })

  it('fails visibly closed on invalid collaboration history', () => {
    const html = render({
      canWrite: false,
      integrityIssues: ['1 scenario annotation record failed validation'],
      error: 'Scenario label revision conflict',
    })
    expect(html.match(/role="alert"/g)).toHaveLength(2)
    expect(html).toContain('Collaboration history needs attention')
    expect(html).toContain('Scenario label revision conflict')
    expect(html).toContain('type="checkbox" disabled="" checked=""')
    expect(html).toContain('type="submit" disabled=""')
  })

  it('discloses deterministic paging for hostile large histories', () => {
    const html = render({ annotationTotal: 51, labelTotal: 51 })
    expect(html.match(/Show next 50 · 50 remaining/g)).toHaveLength(2)
  })
})
