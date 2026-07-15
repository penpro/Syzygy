import { describe, expect, it } from 'vitest'
import { createProjectDocument, getProjectSharedTypes, projectStateFingerprint } from './projectModel'
import { readScenario } from './scenarioModel'
import { createAutomationScenario } from './scenarioAutomation'
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
})
