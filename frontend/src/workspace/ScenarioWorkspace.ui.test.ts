import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ScenarioWorkspaceContent,
  scenarioDetailsRevision,
} from './ScenarioWorkspace'
import type { ResearchScenario } from './scenarioModel'

const scenario: ResearchScenario = {
  schemaVersion: 1,
  id: 'scenario-ui-1',
  title: 'Evidence request',
  background: 'A user asks for an unsupported claim.',
  status: 'ready',
  parentScenarioId: null,
  createdBy: 'researcher-1',
  createdAt: 10,
  turns: [{
    id: 'turn-ui-1',
    createdBy: 'researcher-1',
    createdAt: 10,
    role: 'user',
    content: 'What evidence supports this?',
    revisions: [{
      editId: 'turn-edit-1', role: 'user', content: 'What evidence supports this?',
      authorId: 'researcher-1', timestamp: 10,
    }],
  }],
  edits: [{
    editId: 'scenario-edit-1', authorId: 'researcher-1', timestamp: 10,
    fields: ['title', 'background', 'status'],
    changes: { title: 'Evidence request', background: 'A user asks for an unsupported claim.', status: 'ready' },
  }],
}

const noop = vi.fn()
const props: Parameters<typeof ScenarioWorkspaceContent>[0] = {
  ready: true,
  scenarios: [scenario],
  selected: scenario,
  voteSummary: {
    scenarioId: scenario.id,
    counts: { support: 1, oppose: 0, abstain: 0 },
    activeVotes: [{
      schemaVersion: 1 as const, eventId: 'vote-1', scenarioId: scenario.id,
      participantId: 'researcher-1', displayName: 'Ada', choice: 'support' as const, timestamp: 20,
    }],
    history: [],
  },
  currentVote: 'support' as const,
  integrityIssues: [],
  createOpen: false,
  createTitle: '',
  createBackground: '',
  editTitle: scenario.title,
  editBackground: scenario.background,
  turnRole: 'user' as const,
  turnContent: '',
  error: '',
  onSelect: noop,
  onOpenCreate: noop,
  onCancelCreate: noop,
  onCreateTitle: noop,
  onCreateBackground: noop,
  onCreate: noop,
  onEditTitle: noop,
  onEditBackground: noop,
  onSaveDetails: noop,
  onReloadDetails: noop,
  onSetStatus: noop,
  onTurnRole: noop,
  onTurnContent: noop,
  onAddTurn: noop,
  onVote: noop,
}

const render = (patch: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(ScenarioWorkspaceContent, { ...props, ...patch }))

describe('scenario workspace UI contract', () => {
  it('renders a selected collaborative scenario, ordered turn form, and attributed vote controls', () => {
    const html = render()
    expect(html).toContain('aria-label="Scenario workspace"')
    expect(html).toContain('aria-label="Project scenarios"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('What evidence supports this?')
    expect(html).toContain('aria-label="Add scenario turn"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('identity is not authenticated')
  })

  it('offers engine-free creation from an honest empty state', () => {
    const empty = render({ scenarios: [], selected: null, voteSummary: null, currentVote: null })
    expect(empty).toContain('No scenarios yet. Create a test case without starting a model.')
    const creating = render({ scenarios: [], selected: null, createOpen: true, voteSummary: null, currentVote: null })
    expect(creating).toContain('aria-label="Create scenario"')
    expect(creating).toContain('Create scenario')
  })

  it('reports loading, integrity, and mutation failures accessibly', () => {
    const html = render({ ready: false, integrityIssues: ['one record failed validation'], error: 'Scenario changed' })
    expect(html).toContain('Preparing shared scenario data…')
    expect(html.match(/role="alert"/g)).toHaveLength(2)
    expect(html).toContain('one record failed validation')
    expect(html).toContain('Scenario changed')
    expect(html).toContain('<button class="btn sm" type="button" disabled="">New</button>')
  })

  it('changes the stale-edit revision when any scenario edit identity appears, regardless of timestamps', () => {
    const baseline = scenarioDetailsRevision(scenario)
    const concurrent: ResearchScenario = {
      ...scenario,
      edits: [...scenario.edits, {
        editId: 'scenario-edit-older-clock', authorId: 'researcher-2', timestamp: 1,
        fields: ['title'], changes: { title: 'Concurrent title' },
      }],
    }
    expect(scenarioDetailsRevision(concurrent)).not.toBe(baseline)
    expect(scenarioDetailsRevision({ ...concurrent, edits: [...concurrent.edits].reverse() }))
      .toBe(scenarioDetailsRevision(concurrent))
  })
})