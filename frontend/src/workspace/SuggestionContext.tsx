import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  type SuggestionEvent,
} from './suggestionModel'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'
import { getAutomationEditorController, type AutomationEditorSnapshot } from './editorAutomationRegistry'
import { applyAcceptedSuggestion } from './suggestionApplication'
import {
  attestSuggestionEvent,
  type ResearchEventAttributionResult,
} from './researchEventAttribution'

interface SuggestionState {
  projectId: string
  ready: boolean
  healthy: boolean
  suggestions: CollaborativeSuggestion[]
  attribution: { eventId: string; result: ResearchEventAttributionResult } | null
  attributionPendingEventId: string | null
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
  const [attribution, setAttribution] = useState<SuggestionState['attribution']>(null)
  const [attributionPendingEventId, setAttributionPendingEventId] = useState<string | null>(null)
  const attributionOperation = useRef(0)

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

  useEffect(() => {
    attributionOperation.current += 1
    setAttribution(null)
    setAttributionPendingEventId(null)
  }, [projectId, doc])

  const shared = useMemo(() => doc ? getProjectSharedTypes(doc) : null, [doc, revision])
  const suggestions = useMemo(() => shared ? listSuggestions(shared.discussions) : [], [shared])
  const healthy = useMemo(() => shared ? inspectSuggestions(shared.discussions).healthy : true, [shared])
  const identity = () => {
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before reviewing shared suggestions')
    }
    return { participantId: researcherId, displayName: researcherName.trim() }
  }
  const publishAttribution = (event: SuggestionEvent) => {
    if (!doc) return
    const operation = attributionOperation.current + 1
    attributionOperation.current = operation
    setAttribution(null)
    setAttributionPendingEventId(event.eventId)
    void attestSuggestionEvent(doc, projectId, event).then((result) => {
      if (attributionOperation.current !== operation) return
      setAttribution({ eventId: event.eventId, result })
      setAttributionPendingEventId(null)
    }, () => {
      if (attributionOperation.current !== operation) return
      setAttribution({
        eventId: event.eventId,
        result: {
          status: 'unsigned',
          reason: 'signing-or-registration-unavailable',
          authority: 'installation-device-not-human-identity',
        },
      })
      setAttributionPendingEventId(null)
    })
  }
  const value = useMemo<SuggestionState>(() => ({
    projectId,
    ready: Boolean(shared),
    healthy,
    suggestions,
    attribution,
    attributionPendingEventId,
    createHumanSuggestion: (content, sourceDocumentRevision) => {
      if (!shared) throw new Error('The collaboration document is still loading')
      const author = identity()
      const suggestion = createSuggestionRecord(shared.discussions, {
        suggestionId: uid(),
        eventId: uid(),
        content,
        sourceDocumentRevision,
        authorId: author.participantId,
        authorDisplayName: author.displayName,
        timestamp: now(),
      })
      publishAttribution(suggestion.proposal)
      return suggestion
    },
    decide: (suggestionId, expectedProposalEventId, decision) => {
      if (!shared) throw new Error('The collaboration document is still loading')
      const reviewer = identity()
      const eventId = uid()
      const suggestion = decideSuggestion(shared.discussions, {
        suggestionId,
        eventId,
        expectedProposalEventId,
        decision,
        reviewerId: reviewer.participantId,
        reviewerDisplayName: reviewer.displayName,
        timestamp: now(),
      })
      const event = suggestion.decisions.find((candidate) => candidate.eventId === eventId)
      if (!event) throw new Error('Suggestion decision was not retained')
      publishAttribution(event)
      return suggestion
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
  }), [projectId, shared, healthy, suggestions, researcherId, researcherName,
    attribution, attributionPendingEventId, doc])

  return <SuggestionContext.Provider value={value}>{children}</SuggestionContext.Provider>
}

export function useSuggestionState(): SuggestionState {
  const value = useContext(SuggestionContext)
  if (!value) throw new Error('Suggestions require a live project context')
  return value
}
