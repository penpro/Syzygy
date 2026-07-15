import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { appVersion, automationReady, automationRespond } from './tauri'
import { useStore } from './store'
import {
  automationEditorReady,
  getAutomationEditorController,
} from './workspace/editorAutomationRegistry'
import { inspectResearchState } from './workspace/researchStateInspection'
import { automationProjectDocumentReady, getAutomationProjectDocument } from './workspace/workspaceAutomationRegistry'
import { saveAutomationPolicyVersion } from './workspace/versionAutomation'

interface AutomationRequest {
  id: string
  method: string
  params: unknown
}

interface AutomationReply {
  ok: boolean
  result?: unknown
  error?: string
}

const AUTOMATION_EVENT = 'syzygy://automation/request'

export async function startAutomationBridge(): Promise<UnlistenFn> {
  const unlisten = await listen<AutomationRequest>(AUTOMATION_EVENT, (event) => {
    void answerRequest(event.payload)
  })
  try {
    await automationReady()
  } catch (error) {
    unlisten()
    throw error
  }
  return unlisten
}

export async function dispatchAutomationRequest(
  request: Pick<AutomationRequest, 'method' | 'params'>,
): Promise<unknown> {
  const params = asObject(request.params)
  const state = useStore.getState()

  switch (request.method) {
    case 'app.inspect': {
      const activeProject = state.projects.find(
        (project) => project.id === state.activeProjectId && !project.archivedAt,
      )
      return {
        app: 'Syzygy',
        version: await appVersion(),
        view: state.view,
        projectCount: state.projects.filter((project) => !project.archivedAt).length,
        activeProject: activeProject ? summarizeProject(activeProject, state.activeProjectId) : null,
        editorReady: activeProject ? automationEditorReady(activeProject.id) : false,
        researchStateReady: activeProject ? automationProjectDocumentReady(activeProject.id) : false,
        capabilities: {
          available: [
            'local project identity',
            'local collaborative rich-text draft',
            'automatic IndexedDB persistence',
            'revision-guarded semantic MCP reads and writes',
            'read-only MCP integrity inspection for heuristics and immutable version history',
            'dual-revision-guarded MCP creation of immutable policy checkpoints',
          ],
          unavailable: [
            'version save, restore, and diff controls in the product UI; MCP restore remains unavailable',
            'scenario and evaluation workflows',
            'Drive-backed project CRDT transport',
            'real-time collaborator presence',
          ],
        },
      }
    }
    case 'project.list':
      return {
        activeProjectId: state.activeProjectId,
        projects: state.projects.map((project) => summarizeProject(project, state.activeProjectId)),
      }
    case 'project.create': {
      const title = requiredString(params, 'title')
      const projectId = state.createProject(title)
      await waitForEditor(projectId)
      const project = useStore.getState().projects.find((candidate) => candidate.id === projectId)
      if (!project) throw new Error('The new project was not persisted')
      return { project: summarizeProject(project, projectId), document: getAutomationEditorController(projectId).read() }
    }
    case 'project.open': {
      const projectId = requiredString(params, 'projectId')
      const project = state.projects.find((candidate) => candidate.id === projectId && !candidate.archivedAt)
      if (!project) throw new Error(`No active research project has ID ${projectId}`)
      state.openProject(projectId)
      await waitForEditor(projectId)
      return { project: summarizeProject(project, projectId), document: getAutomationEditorController(projectId).read() }
    }
    case 'project.rename': {
      const projectId = requiredString(params, 'projectId')
      const title = requiredString(params, 'title').trim()
      if (!title) throw new Error('Project title cannot be empty')
      const project = state.projects.find((candidate) => candidate.id === projectId && !candidate.archivedAt)
      if (!project) throw new Error(`No active research project has ID ${projectId}`)
      state.renameProject(projectId, title)
      const renamed = useStore.getState().projects.find((candidate) => candidate.id === projectId)
      return { project: renamed ? summarizeProject(renamed, useStore.getState().activeProjectId) : null }
    }
    case 'project.readActive': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      return { project: summarizeProject(project, latest.activeProjectId), document: getAutomationEditorController(project.id).read() }
    }
    case 'project.readResearchState': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      return { project: summarizeProject(project, latest.activeProjectId), researchState: await inspectResearchState(
        getAutomationProjectDocument(project.id),
        project.id,
      ) }
    }
    case 'project.savePolicyVersion': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const controller = getAutomationEditorController(project.id)
      const saved = await saveAutomationPolicyVersion(
        getAutomationProjectDocument(project.id),
        project.id,
        {
          expectedDocumentRevision: requiredString(params, 'expectedDocumentRevision'),
          expectedHeadVersionId: optionalString(params, 'expectedHeadVersionId'),
          participantId: requiredString(params, 'participantId'),
          displayName: requiredString(params, 'displayName'),
          createdAt: Date.now(),
          note: optionalString(params, 'note'),
        },
        controller.read,
      )
      return {
        project: summarizeProject(project, latest.activeProjectId),
        documentRevision: saved.documentRevision,
        version: {
          versionId: saved.version.versionId,
          parentVersionId: saved.version.parentVersionId,
          participantId: saved.version.author.participantId,
          displayName: saved.version.author.displayName,
          createdAt: saved.version.createdAt,
          blockCount: saved.version.policy.blocks.length,
          scenarioCount: saved.version.scenarioIds.length,
          hasNote: saved.version.note !== null,
        },
        deterministicChangeNote: saved.changeNote,
      }
    }
    case 'document.replace': {
      const expectedRevision = requiredString(params, 'expectedRevision')
      const content = requiredString(params, 'content', true)
      return { document: getAutomationEditorController().replace(expectedRevision, content) }
    }
    case 'document.append': {
      const expectedRevision = requiredString(params, 'expectedRevision')
      const content = requiredString(params, 'content', true)
      return { document: getAutomationEditorController().append(expectedRevision, content) }
    }
    case 'workspace.walkthrough':
      return buildWalkthrough()
    default:
      throw new Error(`Unsupported live Syzygy operation: ${request.method}`)
  }
}

async function answerRequest(request: AutomationRequest): Promise<void> {
  let reply: AutomationReply
  try {
    reply = { ok: true, result: await dispatchAutomationRequest(request) }
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    await automationRespond(request.id, reply)
  } catch {
    // The authenticated requester may have timed out or disconnected. The normal invoke wrapper
    // already records the backend failure without request arguments or research content.
  }
}

function buildWalkthrough() {
  const state = useStore.getState()
  const project = state.projects.find(
    (candidate) => candidate.id === state.activeProjectId && !candidate.archivedAt,
  )
  const document = project && automationEditorReady(project.id) ? getAutomationEditorController(project.id).read() : null
  const wordCount = document?.blocks
    .flatMap((block) => block.text.trim().split(/\s+/))
    .filter(Boolean).length ?? 0

  return {
    purpose:
      'A research project is the stable container for a policy or research draft. Today the center document is usable and persists locally; the side rails visibly reserve later versioning, scenarios, and evaluation work.',
    currentState: project
      ? `“${project.title}” is open with ${document?.blocks.length ?? 0} document blocks and about ${wordCount} words.`
      : 'No research project is open yet.',
    recommendedNextAction: project
      ? 'Read the active project, explain its current draft, then offer one concrete edit. Make any edit only with the revision returned by that read.'
      : 'Create one clearly named demonstration project, then replace its starter text with a small policy containing a title, rule, rationale, and testable example.',
    steps: [
      {
        name: 'Project identity',
        status: project ? 'ready' : 'needs-project',
        use: 'Keeps the same project and document IDs as transports and collaboration are added.',
      },
      {
        name: 'Draft policy or research document',
        status: document ? 'ready' : 'needs-open-project',
        use: 'Write headings, paragraphs, and quotations in the live collaborative document.',
      },
      {
        name: 'Versions and comparisons',
        status: project && automationProjectDocumentReady(project.id) ? 'domain-inspection-ready' : 'needs-open-project',
        use: 'Immutable history and deterministic diff foundations are headlessly tested; MCP can inspect and save exact-revision checkpoints, while the visible rail and restore remain unavailable.',
      },
      {
        name: 'Scenarios and evaluation',
        status: 'not-implemented',
        use: 'The right rail is a visible placeholder for testing a policy against concrete cases.',
      },
      {
        name: 'Network collaboration',
        status: 'not-implemented-for-projects',
        use: 'Drive can already supply shared Ask evidence, but this project draft is still local IndexedDB state.',
      },
    ],
  }
}

async function waitForEditor(projectId: string): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (automationEditorReady(projectId)) return
    await new Promise((resolve) => window.setTimeout(resolve, 25))
  }
  throw new Error(`Project ${projectId} opened, but its live editor did not become ready`)
}

function summarizeProject(
  project: ReturnType<typeof useStore.getState>['projects'][number],
  activeProjectId: string | null,
) {
  return {
    schemaVersion: project.schemaVersion,
    id: project.id,
    documentId: project.documentId,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt ?? null,
    transport: project.transport,
    active: project.id === activeProjectId,
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Automation parameters must be an object')
  return value as Record<string, unknown>
}

function requiredString(
  params: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = params[name]
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`)
  }
  return value
}

function optionalString(params: Record<string, unknown>, name: string): string | null {
  const value = params[name]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string when provided`)
  return value
}
