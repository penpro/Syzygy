import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { getProjectSharedTypes } from './projectModel'
import { listScenarios, type ResearchScenario } from './scenarioModel'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

interface ScenarioReferenceState {
  projectId: string
  ready: boolean
  scenarios: ResearchScenario[]
}

const ScenarioReferenceContext = createContext<ScenarioReferenceState | null>(null)

export function ScenarioReferenceProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active: Y.Doc | null = null
    const onUpdate = () => setRevision((value) => value + 1)
    const unsubscribe = subscribeAutomationProjectDocument(projectId, (next) => {
      active?.off('update', onUpdate)
      active = next
      setDoc(next)
      next?.on('update', onUpdate)
      setRevision((value) => value + 1)
    })
    return () => {
      active?.off('update', onUpdate)
      unsubscribe()
    }
  }, [projectId])

  const scenarios = useMemo(
    () => doc ? listScenarios(getProjectSharedTypes(doc).scenarios) : [],
    [doc, revision],
  )
  const value = useMemo(
    () => ({ projectId, ready: Boolean(doc), scenarios }),
    [projectId, doc, scenarios],
  )
  return <ScenarioReferenceContext.Provider value={value}>{children}</ScenarioReferenceContext.Provider>
}

export function useScenarioReferenceState(): ScenarioReferenceState {
  const value = useContext(ScenarioReferenceContext)
  if (!value) throw new Error('Scenario references require a live project context')
  return value
}

export function scenarioReferenceLabel(scenarios: ResearchScenario[], scenarioId: string): {
  label: string
  missing: boolean
} {
  const scenario = scenarios.find((candidate) => candidate.id === scenarioId)
  return scenario
    ? { label: scenario.title, missing: false }
    : { label: `Missing scenario · ${scenarioId}`, missing: true }
}
