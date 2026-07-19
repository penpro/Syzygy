import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { now, uid } from '../util'
import { getProjectSharedTypes } from './projectModel'
import {
  createSuggestion as createSuggestionRecord,
  decideSuggestion,
  inspectSuggestions,
  listSuggestions,
  type CollaborativeSuggestion,
  type SuggestionDecisionKind,
} from './suggestionModel'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'
import { getAutomationEditorController, type AutomationEditorSnapshot } from './editorAutomationRegistry'
import { applyAcceptedSuggestion } from './suggestionApplication'

interface SuggestionState {
  projectId: string
  ready: boolean
  healthy: boolean
  suggestions: CollaborativeSuggestion[]
  createHumanSuggestion: (content: string, sourceDocumentRevision: string) => CollaborativeSuggestion
  decide: (
    suggestionId: string,
    expectedProposalEventId: string,
    decision: SuggestionDecisionKind,
  ) => CollaborativeSuggestion
  apply: (
    suggestionId: string,
    expectedProposalEventId: string,
    expectedDecisionEventId: string,
  ) => AutomationEditorSnapshot
}

const SuggestionContext = createContext<SuggestionState | null>(null)

export function SuggestionProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
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

  const shared = useMemo(() => doc ? getProjectSharedTypes(doc) : null, [doc, revision])
  const suggestions = useMemo(() => shared ? listSuggestions(shared.discussions) : [], [shared])
  const healthy = useMemo(() => shared ? inspectSuggestions(shared.discussions).healthy : true, [shared])
  const identity = () => {
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before reviewing shared suggestions')
    }
    return { participantId: researcherId, displayName: researcherName.trim() }
  }
  const value = useMemo<SuggestionState>(() => ({
    projectId,
    ready: Boolean(shared),
    healthy,
    suggestions,
    createHumanSuggestion: (content, sourceDocumentRevision) => {
      if (!shared) throw new Error('The collaboration document is still loading')
      const author = identity()
      return createSuggestionRecord(shared.discussions, {
        suggestionId: uid(),
        eventId: uid(),
        content,
        sourceDocumentRevision,
        authorId: author.participantId,
        authorDisplayName: author.displayName,
        timestamp: now(),
      })
    },
    decide: (suggestionId, expectedProposalEventId, decision) => {
      if (!shared) throw new Error('The collaboration document is still loading')
      const reviewer = identity()
      return decideSuggestion(shared.discussions, {
        suggestionId,
        eventId: uid(),
        expectedProposalEventId,
        decision,
        reviewerId: reviewer.participantId,
        reviewerDisplayName: reviewer.displayName,
        timestamp: now(),
      })
    },
    apply: (suggestionId, expectedProposalEventId, expectedDecisionEventId) => {
      if (!shared) throw new Error('The collaboration document is still loading')
      const controller = getAutomationEditorController(projectId)
      return applyAcceptedSuggestion(shared.discussions, controller, {
        suggestionId,
        expectedProposalEventId,
        expectedDecisionEventId,
        expectedDocumentRevision: controller.read().revision,
      })
    },
  }), [projectId, shared, healthy, suggestions, researcherId, researcherName])

  return <SuggestionContext.Provider value={value}>{children}</SuggestionContext.Provider>
}

export function useSuggestionState(): SuggestionState {
  const value = useContext(SuggestionContext)
  if (!value) throw new Error('Suggestions require a live project context')
  return value
}
