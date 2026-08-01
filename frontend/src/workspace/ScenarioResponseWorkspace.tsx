import { useEffect, useState, type FormEvent } from 'react'
import type * as Y from 'yjs'
import { useStore } from '../store'
import { now, uid } from '../util'
import { getProjectSharedTypes } from './projectModel'
import { inspectScenarioGraph, type ResearchScenario } from './scenarioModel'
import {
  createScenarioResponse,
  editScenarioResponse,
  inspectScenarioResponses,
  readScenarioResponses,
  type ScenarioResponse,
} from './scenarioResponseModel'

const RESPONSE_PAGE_SIZE = 50
const LINEAGE_PAGE_SIZE = 50

export interface HumanResponseIdentity {
  authorId: string
  authorDisplayName: string
}

export interface CreateHumanScenarioResponseInput extends HumanResponseIdentity {
  scenarioId: string
  responseId: string
  revisionId: string
  content: string
  timestamp: number
}

export interface EditHumanScenarioResponseInput extends CreateHumanScenarioResponseInput {
  expectedCurrentRevisionId: string
}

export function inspectScenarioResponseWorkspace(doc: Y.Doc) {
  const shared = getProjectSharedTypes(doc)
  const scenarioIntegrity = inspectScenarioGraph(shared.scenarios)
  const responseIntegrity = inspectScenarioResponses(shared.discussions, shared.scenarios)
  return {
    healthy: scenarioIntegrity.healthy && responseIntegrity.healthy,
    scenarioIntegrity,
    responseIntegrity,
    issues: [...scenarioIntegrity.issues, ...responseIntegrity.issues],
  }
}

function assertResponseWorkspaceWritable(doc: Y.Doc): ReturnType<typeof getProjectSharedTypes> {
  const integrity = inspectScenarioResponseWorkspace(doc)
  if (!integrity.scenarioIntegrity.healthy) {
    throw new Error('Scenario data failed integrity checks; response writes are disabled')
  }
  if (!integrity.responseIntegrity.healthy) {
    throw new Error('Scenario response history failed integrity checks; writes are disabled')
  }
  return getProjectSharedTypes(doc)
}

export function createHumanScenarioResponse(
  doc: Y.Doc,
  input: CreateHumanScenarioResponseInput,
): ScenarioResponse {
  const shared = assertResponseWorkspaceWritable(doc)
  return createScenarioResponse(shared.discussions, shared.scenarios, {
    ...input,
    sourceKind: 'human',
    providerId: null,
    modelId: null,
    runId: null,
  })
}

export function editHumanScenarioResponse(
  doc: Y.Doc,
  input: EditHumanScenarioResponseInput,
): ScenarioResponse {
  const shared = assertResponseWorkspaceWritable(doc)
  return editScenarioResponse(shared.discussions, shared.scenarios, {
    ...input,
    sourceKind: 'human',
    providerId: null,
    modelId: null,
    runId: null,
  })
}

export type ResponseEditSession =
  | { mode: 'create' }
  | { mode: 'edit'; responseId: string; expectedCurrentRevisionId: string }

export interface ScenarioResponseWorkspaceContentProps {
  responses: ScenarioResponse[]
  totalResponses: number
  page: number
  pageCount: number
  editSession: ResponseEditSession | null
  draft: string
  conflict: boolean
  writesDisabled: boolean
  generationBusy: boolean
  integrityIssues: string[]
  error: string
  onOpenCreate: () => void
  onOpenEdit: (response: ScenarioResponse) => void
  onDraft: (value: string) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
  onReload: () => void
  onCancel: () => void
  onRegenerate: (response: ScenarioResponse) => void
  onPreviousPage: () => void
  onNextPage: () => void
}

function revisionSource(response: ScenarioResponse) {
  return response.revisions.find(({ revisionId }) => revisionId === response.currentRevisionId)
}

export function ScenarioResponseWorkspaceContent(props: ScenarioResponseWorkspaceContentProps) {
  return (
    <section className="scenario-response-workspace" aria-label="Shared scenario responses">
      <div className="scenario-section-heading">
        <div>
          <h3>Response variants</h3>
          <p className="scenario-generation-intro">
            Write directly or generate with a model. Every saved change becomes an attributed revision; nothing changes the policy draft.
          </p>
        </div>
        <span className="mono">{props.totalResponses}</span>
      </div>

      {props.integrityIssues.length > 0 && (
        <div className="scenario-state error" role="alert">
          Response editing is paused: {props.integrityIssues.join('; ')}
        </div>
      )}
      {props.error && <div className="scenario-state error" role="alert">{props.error}</div>}

      {!props.editSession && (
        <div className="scenario-actions">
          <button className="btn sm" type="button" disabled={props.writesDisabled} onClick={props.onOpenCreate}>
            Write response
          </button>
        </div>
      )}

      {props.editSession && (
        <form
          className="scenario-form scenario-response-editor"
          aria-label={props.editSession.mode === 'create' ? 'Write scenario response' : 'Edit scenario response'}
          onSubmit={props.onSave}
        >
          <div className="scenario-section-heading">
            <h4>{props.editSession.mode === 'create' ? 'New response' : 'Edit current response'}</h4>
            {props.editSession.mode === 'edit' && (
              <span className="mono">based on {props.editSession.expectedCurrentRevisionId.slice(0, 12)}</span>
            )}
          </div>
          <label>
            Response
            <textarea
              value={props.draft}
              maxLength={500_000}
              rows={8}
              required
              onChange={(event) => props.onDraft(event.target.value)}
            />
          </label>
          <p className="scenario-generation-note">
            Saving retains this installation's researcher name and the exact parent revision. Identity is not authenticated; earlier text remains in lineage.
          </p>
          {props.conflict && (
            <div className="scenario-state error" role="alert">
              This response changed while you were editing. Reload the shared version before saving; your draft remains here until then.
            </div>
          )}
          <div className="scenario-actions">
            <button className="btn primary sm" type="submit" disabled={props.writesDisabled || props.conflict}>
              {props.editSession.mode === 'create' ? 'Save response' : 'Save revision'}
            </button>
            {props.editSession.mode === 'edit' && (
              <button className="btn sm" type="button" onClick={props.onReload}>Reload shared</button>
            )}
            <button className="btn sm" type="button" onClick={props.onCancel}>Cancel</button>
          </div>
        </form>
      )}

      {props.totalResponses === 0 && !props.editSession && (
        <p className="scenario-state">No response variants yet. Write one without AI or generate one when useful.</p>
      )}

      {props.responses.length > 0 && (
        <ol className="scenario-responses" aria-label="Scenario response variants">
          {props.responses.map((response) => {
            const current = revisionSource(response)
            const lineage = response.revisions.slice(-LINEAGE_PAGE_SIZE)
            return (
              <li key={response.id}>
                <div className="scenario-turn-meta mono">
                  {current?.sourceKind === 'model'
                    ? `${current.providerId} · ${current.modelId}`
                    : current?.authorDisplayName}
                  {' · '}{response.revisions.length} revision{response.revisions.length === 1 ? '' : 's'}
                </div>
                <div className="scenario-turn-content">{response.content || <em>Empty response</em>}</div>
                <div className="scenario-actions">
                  <button className="btn sm" type="button" disabled={props.writesDisabled} onClick={() => props.onOpenEdit(response)}>
                    Edit
                  </button>
                  <button className="btn sm" type="button" disabled={props.generationBusy || props.writesDisabled} onClick={() => props.onRegenerate(response)}>
                    Regenerate
                  </button>
                </div>
                <details className="scenario-response-lineage">
                  <summary>Variant lineage · {response.revisions.length} retained</summary>
                  {response.revisions.length > LINEAGE_PAGE_SIZE && (
                    <p>Showing the {LINEAGE_PAGE_SIZE} most recent revisions.</p>
                  )}
                  <ol>
                    {lineage.map((revision) => (
                      <li key={revision.revisionId}>
                        <div className="scenario-turn-meta mono">
                          {revision.sourceKind === 'model'
                            ? `${revision.providerId} · ${revision.modelId}`
                            : revision.authorDisplayName}
                          {' · '}parent {revision.parentRevisionId?.slice(0, 12) ?? 'root'}
                        </div>
                        <div className="scenario-turn-content">{revision.content || <em>Empty response</em>}</div>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            )
          })}
        </ol>
      )}

      {props.pageCount > 1 && (
        <nav className="scenario-pagination" aria-label="Response pages">
          <button className="btn sm" type="button" disabled={props.page === 0} onClick={props.onPreviousPage}>Previous</button>
          <span className="mono">Page {props.page + 1} of {props.pageCount}</span>
          <button className="btn sm" type="button" disabled={props.page + 1 >= props.pageCount} onClick={props.onNextPage}>Next</button>
        </nav>
      )}
    </section>
  )
}

export function ScenarioResponseWorkspace({
  doc,
  scenario,
  generationBusy,
  onRegenerate,
}: {
  doc: Y.Doc
  scenario: ResearchScenario
  generationBusy: boolean
  onRegenerate: (response: ScenarioResponse) => void
}) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const [, setRevision] = useState(0)
  const [editSession, setEditSession] = useState<ResponseEditSession | null>(null)
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const onUpdate = () => setRevision((value) => value + 1)
    doc.on('update', onUpdate)
    return () => doc.off('update', onUpdate)
  }, [doc])

  useEffect(() => {
    setEditSession(null)
    setDraft('')
    setPage(0)
    setError('')
  }, [scenario.id])

  const shared = getProjectSharedTypes(doc)
  const workspaceIntegrity = inspectScenarioResponseWorkspace(doc)
  const selectedResponses = readScenarioResponses(shared.discussions, scenario.id)
  const integrityIssues = [
    ...workspaceIntegrity.issues,
    ...(selectedResponses === null ? ['Selected scenario response history failed validation'] : []),
  ]
  const responses = selectedResponses ?? []
  const pageCount = Math.max(1, Math.ceil(responses.length / RESPONSE_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visibleResponses = responses.slice(safePage * RESPONSE_PAGE_SIZE, (safePage + 1) * RESPONSE_PAGE_SIZE)
  const editingResponse = editSession?.mode === 'edit'
    ? responses.find((response) => response.id === editSession.responseId)
    : null
  const conflict = editSession?.mode === 'edit' &&
    editingResponse?.currentRevisionId !== editSession.expectedCurrentRevisionId
  const writesDisabled = integrityIssues.length > 0

  const identity = (): HumanResponseIdentity => {
    if (!researcherId || !researcherName.trim()) {
      throw new Error('Set a researcher name in Settings before editing shared responses')
    }
    return { authorId: researcherId, authorDisplayName: researcherName.trim() }
  }

  const beginEdit = (response: ScenarioResponse) => {
    setEditSession({ mode: 'edit', responseId: response.id, expectedCurrentRevisionId: response.currentRevisionId })
    setDraft(response.content)
    setError('')
  }

  const reload = () => {
    if (!editingResponse) {
      setError('The shared response is no longer available')
      return
    }
    beginEdit(editingResponse)
  }

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    try {
      if (!editSession) throw new Error('Open a response editor first')
      if (!draft.trim()) throw new Error('Response content is required')
      if (draft.length > 500_000) throw new Error('Response content is too large')
      const author = identity()
      if (editSession.mode === 'create') {
        createHumanScenarioResponse(doc, {
          scenarioId: scenario.id,
          responseId: `scenario-response-${uid()}`,
          revisionId: `scenario-revision-${uid()}`,
          content: draft,
          timestamp: now(),
          ...author,
        })
      } else {
        editHumanScenarioResponse(doc, {
          scenarioId: scenario.id,
          responseId: editSession.responseId,
          revisionId: `scenario-revision-${uid()}`,
          expectedCurrentRevisionId: editSession.expectedCurrentRevisionId,
          content: draft,
          timestamp: now(),
          ...author,
        })
      }
      setEditSession(null)
      setDraft('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scenario response update failed')
    }
  }

  return <ScenarioResponseWorkspaceContent
    responses={visibleResponses}
    totalResponses={responses.length}
    page={safePage}
    pageCount={pageCount}
    editSession={editSession}
    draft={draft}
    conflict={Boolean(conflict)}
    writesDisabled={writesDisabled}
    generationBusy={generationBusy}
    integrityIssues={integrityIssues}
    error={error}
    onOpenCreate={() => { setEditSession({ mode: 'create' }); setDraft(''); setError('') }}
    onOpenEdit={beginEdit}
    onDraft={setDraft}
    onSave={save}
    onReload={reload}
    onCancel={() => { setEditSession(null); setDraft(''); setError('') }}
    onRegenerate={onRegenerate}
    onPreviousPage={() => setPage(Math.max(0, safePage - 1))}
    onNextPage={() => setPage(Math.min(pageCount - 1, safePage + 1))}
  />
}
