import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { readScenario } from './scenarioModel'
import { addAutomationScenarioTurn, createAutomationScenario, reviseAutomationScenarioTurn } from './scenarioAutomation'
import { createProjectManifest } from './schema'

const manifest = createProjectManifest({ id: 'scenario-automation-project', documentId: 'scenario-automation-document', timestamp: 1 })

describe('automation scenario creation', () => {
  it('creates one scenario against the exact monotonic research revision', () => {
    const doc = createProjectDocument(manifest)
    const before = projectStateFingerprint(doc)
    const result = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: before, scenarioId: 'mcp-scenario', title: 'MCP scenario', background: 'Test a claim.',
      participantId: 'mcp-researcher', createdAt: 10, editId: 'create-mcp-scenario',
    })
    expect(result.scenario).toMatchObject({ id: 'mcp-scenario', status: 'draft', createdBy: 'mcp-researcher' })
    expect(result.researchRevision).not.toBe(before)
    expect(readScenario(getProjectSharedTypes(doc).scenarios, 'mcp-scenario')?.title).toBe('MCP scenario')
  })

  it('rejects a stale revision without mutating scenario state', () => {
    const doc = createProjectDocument(manifest)
    expect(() => createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: 'stale', scenarioId: 'must-not-land', title: 'No', background: '',
      participantId: 'mcp-researcher', createdAt: 10, editId: 'create-must-not-land',
    })).toThrow('Research state revision conflict')
    expect(getProjectSharedTypes(doc).scenarios.size).toBe(0)
  })

  it('supports a guarded branch only when its parent exists', () => {
    const doc = createProjectDocument(manifest)
    const root = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'root-scenario', title: 'Root', background: '',
      participantId: 'mcp-researcher', createdAt: 10, editId: 'create-root-scenario',
    })
    const branch = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: root.researchRevision, scenarioId: 'branch-scenario', title: 'Branch', background: '',
      parentScenarioId: 'root-scenario', participantId: 'mcp-researcher', createdAt: 11, editId: 'create-branch-scenario',
    })
    expect(branch.scenario.parentScenarioId).toBe('root-scenario')
  })

  it('adds and revises a turn through successive exact research revisions', () => {
    const doc = createProjectDocument(manifest)
    const created = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'turn-scenario', title: 'Turns', background: '',
      participantId: 'mcp-researcher', createdAt: 10, editId: 'create-turn-scenario',
    })
    const added = addAutomationScenarioTurn(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'turn-scenario', turnId: 'answer-turn',
      role: 'assistant', content: 'Initial answer.', participantId: 'mcp-researcher', timestamp: 11, editId: 'add-answer-turn',
    })
    expect(added.turn).toMatchObject({ id: 'answer-turn', content: 'Initial answer.', revisions: [{ editId: 'add-answer-turn' }] })
    const revised = reviseAutomationScenarioTurn(doc, manifest.id, {
      expectedResearchRevision: added.researchRevision, scenarioId: 'turn-scenario', turnId: 'answer-turn',
      role: 'assistant', content: 'Revised answer.', participantId: 'reviewer', timestamp: 12, editId: 'revise-answer-turn',
    })
    expect(revised.turn.content).toBe('Revised answer.')
    expect(revised.turn.revisions.map((revision) => revision.authorId)).toEqual(['mcp-researcher', 'reviewer'])
  })

  it('rejects stale turn add and revision without changing turn history', () => {
    const doc = createProjectDocument(manifest)
    const created = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'guarded-turns', title: 'Guarded', background: '',
      participantId: 'mcp-researcher', createdAt: 10, editId: 'create-guarded-turns',
    })
    const added = addAutomationScenarioTurn(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'guarded-turns', turnId: 'question-turn',
      role: 'user', content: 'Question?', participantId: 'mcp-researcher', timestamp: 11, editId: 'add-question-turn',
    })
    expect(() => addAutomationScenarioTurn(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'guarded-turns', turnId: 'stale-turn',
      role: 'user', content: 'Stale.', participantId: 'mcp-researcher', timestamp: 12, editId: 'add-stale-turn',
    })).toThrow('Research state revision conflict')
    expect(() => reviseAutomationScenarioTurn(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'guarded-turns', turnId: 'question-turn',
      role: 'user', content: 'Stale revision.', participantId: 'mcp-researcher', timestamp: 13, editId: 'stale-revision',
    })).toThrow('Research state revision conflict')
    expect(readScenario(getProjectSharedTypes(doc).scenarios, 'guarded-turns')?.turns).toMatchObject([
      { id: 'question-turn', content: 'Question?', revisions: [{ editId: 'add-question-turn' }] },
    ])
    expect(added.researchRevision).toBe(projectStateFingerprint(doc))
  })
})
