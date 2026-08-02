import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { applyProjectUpdate, createProjectDocument, encodeProjectState, getProjectSharedTypes } from './projectModel'
import { createScenario, readScenario, type ScenarioTurn, type ScenarioTurnRevision } from './scenarioModel'
import type { ResearchProjectManifest } from './schema'
import {
  createHumanScenarioTurn,
  editHumanScenarioTurn,
  ScenarioTurnWorkspaceContent,
  type ScenarioTurnWorkspaceContentProps,
} from './ScenarioTurnWorkspace'

const manifest: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'project-turn-workspace',
  documentId: 'document-turn-workspace',
  title: 'Turn workspace',
  createdAt: 1,
  transport: { kind: 'local' },
  updatedAt: 1,
}

function seededDocument() {
  const doc = createProjectDocument(manifest)
  createScenario(getProjectSharedTypes(doc).scenarios, {
    id: 'scenario-turn-ui',
    title: 'Shared turn test',
    background: '',
    authorId: 'researcher-seed',
    timestamp: 1,
    editId: 'scenario-create',
    turns: [{ id: 'turn-root', role: 'user', content: 'Initial question?', editId: 'turn-root-revision' }],
  })
  return doc
}

function replica(source: Y.Doc) {
  const doc = new Y.Doc({ guid: source.guid })
  applyProjectUpdate(doc, encodeProjectState(source))
  return doc
}

function contentProps(overrides: Partial<ScenarioTurnWorkspaceContentProps> = {}): ScenarioTurnWorkspaceContentProps {
  return {
    turns: [],
    totalTurns: 0,
    page: 0,
    pageCount: 1,
    editSession: null,
    role: 'user',
    content: '',
    conflict: false,
    writesDisabled: false,
    integrityIssues: [],
    error: '',
    onOpenCreate: vi.fn(),
    onOpenEdit: vi.fn(),
    onRole: vi.fn(),
    onContent: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    onCancel: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    ...overrides,
  }
}

describe('editable shared scenario turn product workflow', () => {
  it('adds and revises turns with exact parent and immutable author history', () => {
    const doc = seededDocument()
    createHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-answer', role: 'assistant', content: 'Initial answer.',
      authorId: 'researcher-1', timestamp: 10, editId: 'turn-answer-root',
    })
    const edited = editHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-answer', role: 'assistant', content: 'Revised answer.',
      authorId: 'researcher-2', timestamp: 20, editId: 'turn-answer-edit', expectedCurrentEditId: 'turn-answer-root',
    })
    const turn = edited.turns.find(({ id }) => id === 'turn-answer')
    expect(turn).toMatchObject({ role: 'assistant', content: 'Revised answer.', createdBy: 'researcher-1' })
    expect(turn?.revisions).toEqual([
      expect.objectContaining({ editId: 'turn-answer-root', authorId: 'researcher-1', content: 'Initial answer.' }),
      expect.objectContaining({ editId: 'turn-answer-edit', authorId: 'researcher-2', content: 'Revised answer.' }),
    ])
    expect(editHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-answer', role: 'assistant', content: 'Revised answer.',
      authorId: 'researcher-2', timestamp: 20, editId: 'turn-answer-edit', expectedCurrentEditId: 'turn-answer-root',
    }).turns.find(({ id }) => id === 'turn-answer')?.revisions).toHaveLength(2)
  })

  it('rejects a stale turn save before mutating the shared document', () => {
    const doc = seededDocument()
    editHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-root', role: 'user', content: 'Current shared question?',
      authorId: 'researcher-current', timestamp: 10, editId: 'turn-current', expectedCurrentEditId: 'turn-root-revision',
    })
    const before = Array.from(encodeProjectState(doc))
    expect(() => editHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-root', role: 'user', content: 'Stale overwrite?',
      authorId: 'researcher-stale', timestamp: 20, editId: 'turn-stale', expectedCurrentEditId: 'turn-root-revision',
    })).toThrow('revision conflict')
    expect(Array.from(encodeProjectState(doc))).toEqual(before)
    expect(readScenario(getProjectSharedTypes(doc).scenarios, 'scenario-turn-ui')?.turns[0].content)
      .toBe('Current shared question?')
  })

  it('retains disconnected exact-parent edits and converges deterministically', () => {
    const base = seededDocument()
    const left = replica(base)
    const right = replica(base)
    editHumanScenarioTurn(left, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-root', role: 'user', content: 'Left question?',
      authorId: 'researcher-left', timestamp: 20, editId: 'turn-left', expectedCurrentEditId: 'turn-root-revision',
    })
    editHumanScenarioTurn(right, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-root', role: 'user', content: 'Right question?',
      authorId: 'researcher-right', timestamp: 20, editId: 'turn-right', expectedCurrentEditId: 'turn-root-revision',
    })
    applyProjectUpdate(left, encodeProjectState(right))
    applyProjectUpdate(right, encodeProjectState(left))
    const leftTurn = readScenario(getProjectSharedTypes(left).scenarios, 'scenario-turn-ui')?.turns[0]
    const rightTurn = readScenario(getProjectSharedTypes(right).scenarios, 'scenario-turn-ui')?.turns[0]
    expect(leftTurn).toEqual(rightTurn)
    expect(leftTurn?.revisions.map(({ editId }) => editId)).toEqual([
      'turn-root-revision', 'turn-left', 'turn-right',
    ])
    expect(leftTurn?.content).toBe('Right question?')
  })

  it('fails closed on hostile scenario data without adding a turn revision', () => {
    const doc = seededDocument()
    const scenarios = getProjectSharedTypes(doc).scenarios
    const record = Array.from(scenarios.values())
      .find((value) => value instanceof Y.Map && value.get('id') === 'scenario-turn-ui') as Y.Map<unknown>
    record.set('unexpected', true)
    const before = Array.from(encodeProjectState(doc))
    expect(() => editHumanScenarioTurn(doc, {
      scenarioId: 'scenario-turn-ui', turnId: 'turn-root', role: 'user', content: 'Must not write.',
      authorId: 'researcher-1', timestamp: 20, editId: 'turn-hostile', expectedCurrentEditId: 'turn-root-revision',
    })).toThrow('integrity checks')
    expect(Array.from(encodeProjectState(doc))).toEqual(before)
  })

  it('renders an accessible no-AI add path and empty state', () => {
    const html = renderToStaticMarkup(<ScenarioTurnWorkspaceContent {...contentProps()} />)
    expect(html).toContain('Shared scenario conversation turns')
    expect(html).toContain('Add turn')
    expect(html).toContain('without starting a model')
    expect(html).toContain('No turns yet')
  })

  it('keeps stale content visible, blocks save, and offers shared reload', () => {
    const html = renderToStaticMarkup(<ScenarioTurnWorkspaceContent {...contentProps({
      editSession: { mode: 'edit', turnId: 'turn-root', expectedCurrentEditId: 'turn-old' },
      role: 'assistant',
      content: 'My unsaved turn edit.',
      conflict: true,
    })} />)
    expect(html).toContain('Edit scenario turn')
    expect(html).toContain('My unsaved turn edit.')
    expect(html).toContain('changed while you were editing')
    expect(html).toContain('Reload shared')
    expect(html).toContain('Identity and time are not authenticated')
    expect(html).toMatch(/type="submit" disabled=""/)
  })

  it('bounds visible turn lineage and exposes conversation pagination', () => {
    const revisions: ScenarioTurnRevision[] = Array.from({ length: 51 }, (_, index) => ({
      editId: `turn-revision-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `Turn content ${index}`,
      authorId: 'researcher-1',
      timestamp: index,
    }))
    const turn: ScenarioTurn = {
      id: 'turn-many', createdBy: 'researcher-1', createdAt: 0,
      role: 'user', content: 'Turn content 50', revisions,
    }
    const html = renderToStaticMarkup(<ScenarioTurnWorkspaceContent {...contentProps({
      turns: [turn], totalTurns: 101, page: 1, pageCount: 3,
    })} />)
    expect(html).toContain('51 retained')
    expect(html).toContain('Showing the 50 most recent revisions')
    expect(html).not.toContain('Turn content 0')
    expect(html).toContain('Turn content 50')
    expect(html).toContain('Page 2 of 3')
    expect(html).toContain('aria-label="Conversation turn pages"')
  })
})
