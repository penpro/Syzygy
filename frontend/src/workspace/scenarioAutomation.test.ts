import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { readScenario } from './scenarioModel'
import {
  addAutomationScenarioTurn, castAutomationScenarioVote, createAutomationScenario,
  createAutomationScenarioAnnotation, resolveAutomationScenarioAnnotation,
  reviseAutomationScenarioTurn, updateAutomationScenarioAnnotation,
} from './scenarioAutomation'
import { readScenarioAnnotations } from './scenarioAnnotationModel'
import { readScenarioVotes } from './scenarioVoteModel'
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

  it('casts, revises, and withdraws one participant vote through chained revisions', () => {
    const doc = createProjectDocument(manifest)
    const created = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'vote-scenario', title: 'Vote', background: '',
      participantId: 'alice', createdAt: 10, editId: 'create-vote-scenario',
    })
    const support = castAutomationScenarioVote(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'vote-scenario', participantId: 'alice',
      displayName: 'Alice', choice: 'support', timestamp: 11, eventId: 'alice-support',
    })
    const oppose = castAutomationScenarioVote(doc, manifest.id, {
      expectedResearchRevision: support.researchRevision, scenarioId: 'vote-scenario', participantId: 'alice',
      displayName: 'Alice Updated', choice: 'oppose', timestamp: 12, eventId: 'alice-oppose',
    })
    expect(oppose.summary).toMatchObject({ counts: { support: 0, oppose: 1, abstain: 0 }, activeVotes: [{ displayName: 'Alice Updated' }] })
    const withdrawn = castAutomationScenarioVote(doc, manifest.id, {
      expectedResearchRevision: oppose.researchRevision, scenarioId: 'vote-scenario', participantId: 'alice',
      displayName: 'Alice Updated', choice: 'withdrawn', timestamp: 13, eventId: 'alice-withdraw',
    })
    expect(withdrawn.summary.counts).toEqual({ support: 0, oppose: 0, abstain: 0 })
    expect(withdrawn.summary.history).toHaveLength(3)
  })

  it('rejects a stale vote without adding a vote event', () => {
    const doc = createProjectDocument(manifest)
    const created = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'guarded-vote', title: 'Vote guard', background: '',
      participantId: 'alice', createdAt: 10, editId: 'create-guarded-vote',
    })
    const first = castAutomationScenarioVote(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'guarded-vote', participantId: 'alice',
      displayName: 'Alice', choice: 'support', timestamp: 11, eventId: 'alice-first-vote',
    })
    expect(() => castAutomationScenarioVote(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, scenarioId: 'guarded-vote', participantId: 'bob',
      displayName: 'Bob', choice: 'oppose', timestamp: 12, eventId: 'bob-stale-vote',
    })).toThrow('Research state revision conflict')
    expect(readScenarioVotes(getProjectSharedTypes(doc).discussions, 'guarded-vote')?.history).toHaveLength(1)
    expect(first.researchRevision).toBe(projectStateFingerprint(doc))
  })

  it('creates, edits, resolves, and reopens an annotation through dual revision guards', () => {
    const doc = createProjectDocument(manifest)
    const createdScenario = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'annotation-scenario', title: 'Annotations', background: '',
      participantId: 'alice', createdAt: 10, editId: 'create-annotation-scenario',
    })
    const created = createAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: createdScenario.researchRevision, annotationId: 'source-note', scenarioId: 'annotation-scenario',
      kind: 'note', body: 'Check the source.', participantId: 'alice', displayName: 'Alice', timestamp: 11, eventId: 'create-source-note',
    })
    const edited = updateAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, annotationId: 'source-note', scenarioId: 'annotation-scenario',
      expectedCurrentEventId: created.annotation.currentEventId, body: 'Source checked.', participantId: 'bob', displayName: 'Bob', timestamp: 12, eventId: 'edit-source-note',
    })
    const resolved = resolveAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: edited.researchRevision, annotationId: 'source-note', scenarioId: 'annotation-scenario',
      expectedCurrentEventId: edited.annotation.currentEventId, resolved: true, participantId: 'bob', displayName: 'Bob', timestamp: 13, eventId: 'resolve-source-note',
    })
    const reopened = resolveAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: resolved.researchRevision, annotationId: 'source-note', scenarioId: 'annotation-scenario',
      expectedCurrentEventId: resolved.annotation.currentEventId, resolved: false, participantId: 'alice', displayName: 'Alice', timestamp: 14, eventId: 'reopen-source-note',
    })
    expect(reopened.annotation).toMatchObject({ body: 'Source checked.', status: 'open', lastActionBy: 'alice' })
    expect(reopened.annotation.events).toHaveLength(4)
  })

  it('rejects stale research and annotation revisions without adding lifecycle events', () => {
    const doc = createProjectDocument(manifest)
    const createdScenario = createAutomationScenario(doc, manifest.id, {
      expectedResearchRevision: projectStateFingerprint(doc), scenarioId: 'guarded-annotation', title: 'Guarded annotations', background: '',
      participantId: 'alice', createdAt: 10, editId: 'create-guarded-annotation',
    })
    const created = createAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: createdScenario.researchRevision, annotationId: 'guarded-note', scenarioId: 'guarded-annotation',
      kind: 'flag', body: 'Needs evidence.', participantId: 'alice', displayName: 'Alice', timestamp: 11, eventId: 'create-guarded-note',
    })
    expect(() => updateAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: createdScenario.researchRevision, annotationId: 'guarded-note', scenarioId: 'guarded-annotation',
      expectedCurrentEventId: created.annotation.currentEventId, body: 'Stale research.', participantId: 'bob', displayName: 'Bob', timestamp: 12, eventId: 'stale-research-edit',
    })).toThrow('Research state revision conflict')
    expect(() => updateAutomationScenarioAnnotation(doc, manifest.id, {
      expectedResearchRevision: created.researchRevision, annotationId: 'guarded-note', scenarioId: 'guarded-annotation',
      expectedCurrentEventId: 'wrong-current-event', body: 'Stale annotation.', participantId: 'bob', displayName: 'Bob', timestamp: 13, eventId: 'stale-annotation-edit',
    })).toThrow('Scenario annotation revision conflict')
    expect(readScenarioAnnotations(getProjectSharedTypes(doc).discussions, 'guarded-annotation')?.[0].events).toHaveLength(1)
  })
})
