import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { AUTOMATION_CAPABILITIES } from './automationCapabilities'
import {
  cancelAdversarialAutomationJob,
  getPersistableAdversarialAutomationJob,
  inspectAdversarialAutomationJob,
  startAdversarialAutomationJob,
} from './extensions/adversarialAutomation'
import {
  decideAdversarialReview,
  saveAdversarialReviewArchive,
  type AdversarialReviewArchive,
  type AdversarialReviewDecisionSummary,
} from './extensions/adversarialHistory'
import { appVersion, automationReady, automationRespond, type DriveProjectTitleState } from './tauri'
import { useStore } from './store'
import {
  automationEditorReady,
  getAutomationEditorController,
} from './workspace/editorAutomationRegistry'
import { inspectResearchState } from './workspace/researchStateInspection'
import {
  attestPolicyVersionEvent,
  attestScenarioAnnotationEvent,
  attestScenarioLabelEvent,
  attestScenarioTurnRevisionEvent,
  attestScenarioVoteEvent,
} from './workspace/researchEventAttribution'
import {
  configureHostedRelayPolicy,
  inspectHostedRelayPolicy,
} from './workspace/relayPolicyAutomation'
import {
  addAutomationScenarioTurn, castAutomationScenarioVote, createAutomationScenario,
  createAutomationScenarioAnnotation, createAutomationScenarioLabel,
  readAutomationScenario, readAutomationScenarioTurnRevision, reconcileAutomationScenarioTurn,
  renameAutomationScenarioLabel, resolveAutomationScenarioAnnotation,
  reviseAutomationScenarioTurn, setAutomationScenarioLabelAssignment,
  updateAutomationScenarioAnnotation,
} from './workspace/scenarioAutomation'
import type { ScenarioAnnotation, ScenarioAnnotationKind } from './workspace/scenarioAnnotationModel'
import type { ScenarioLabel, ScenarioLabelAssignment } from './workspace/scenarioLabelModel'
import type { ResearchScenario, ScenarioStatus, ScenarioTurn, ScenarioTurnRole } from './workspace/scenarioModel'
import type { ScenarioVoteChoice } from './workspace/scenarioVoteModel'
import { refreshDriveProjectDiscovery } from './workspace/driveProjectDiscovery'
import {
  joinSharedDriveProject,
  listSharedDriveProjects,
  shareProjectToSelectedDrive,
} from './workspace/driveProjectActions'
import {
  compactDriveProject,
  compactDriveProjectTitle,
  updateDriveProjectTitle,
} from './workspace/driveProjectMaintenanceRegistry'
import { currentDriveProjectTitleState } from './workspace/driveProjectTitleStatus'
import { driveTitleRepairJobs, type DriveTitleRepairJob } from './workspace/driveTitleRepairJobs'
import { automationProjectDocumentReady, getAutomationProjectDocument } from './workspace/workspaceAutomationRegistry'
import { projectStateFingerprint } from './workspace/projectModel'
import { restoreAutomationPolicyVersion, saveAutomationPolicyVersion } from './workspace/versionAutomation'

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
        capabilities: AUTOMATION_CAPABILITIES,
      }
    }
    case 'project.list':
      return {
        activeProjectId: state.activeProjectId,
        projects: state.projects.map((project) => summarizeProject(project, state.activeProjectId)),
      }
    case 'drive.inspectProjectDiscovery': {
      const result = await refreshDriveProjectDiscovery()
      return { discovery: result.diagnostic }
    }
    case 'drive.listSharedProjects': {
      return { catalog: await listSharedDriveProjects() }
    }
    case 'project.shareDrive': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; open a local project first')
      const expectedDocumentRevision = requiredString(params, 'expectedDocumentRevision')
      const shared = await shareProjectToSelectedDrive(project, expectedDocumentRevision)
      const persisted = useStore.getState().projects.find((candidate) => candidate.id === project.id)
      if (!persisted) throw new Error('The shared project was not persisted locally')
      return {
        project: summarizeProject(persisted, useStore.getState().activeProjectId),
        descriptor: shared.descriptor,
      }
    }
    case 'project.joinDrive': {
      const project = await joinSharedDriveProject({
        projectId: requiredString(params, 'projectId'),
        documentId: requiredString(params, 'documentId'),
        workspaceId: requiredString(params, 'workspaceId'),
      })
      await waitForEditor(project.id, 20_000)
      return {
        project: summarizeProject(project, project.id),
        document: getAutomationEditorController(project.id).read(),
      }
    }
    case 'project.compactDriveHistory': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; open a Drive-shared project first')
      if (project.transport.kind !== 'drive') throw new Error('The active project is not Drive-shared')
      const expectedDocumentRevision = requiredString(params, 'expectedDocumentRevision')
      const expectedResearchRevision = requiredString(params, 'expectedResearchRevision')
      const controller = getAutomationEditorController(project.id)
      const doc = getAutomationProjectDocument(project.id)
      const result = await compactDriveProject(project.id, () => {
        if (controller.read().revision !== expectedDocumentRevision) {
          throw new Error('Document revision conflict; read the active project again before compacting')
        }
        if (projectStateFingerprint(doc) !== expectedResearchRevision) {
          throw new Error('Research revision conflict; inspect research state again before compacting')
        }
      })
      return {
        project: summarizeProject(project, latest.activeProjectId),
        compaction: {
          snapshotByteLength: result.snapshotByteLength,
          activeUpdateCountBefore: result.activeUpdateCountBefore,
          activeUpdateCountAfter: result.activeUpdateCountAfter,
          archivedUpdateCount: result.archivedUpdateCount,
          failedArchiveCount: result.failedArchiveCount,
          remainingIncludedUpdateCount: result.remainingIncludedUpdateCount,
          retainedConcurrentUpdateCount: result.retainedConcurrentUpdateCount,
          complete: result.complete,
        },
      }
    }
    case 'project.compactDriveTitleHistory': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; open a Drive-shared project first')
      if (project.transport.kind !== 'drive') throw new Error('The active project is not Drive-shared')
      const expectedRevisionGuards = requiredStringArray(
        params,
        'expectedTitleRevisionGuards',
        1,
        20,
      ).sort()
      const current = currentDriveProjectTitleState(project.id)
      if (!current) throw new Error('Shared title state is not ready; read the active project again')
      if (JSON.stringify(current.revisionGuards) !== JSON.stringify(expectedRevisionGuards)) {
        throw new Error('Shared title revision conflict; read the active project again before retaining history')
      }
      const result = await compactDriveProjectTitle(project.id, expectedRevisionGuards)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        titleRetention: {
          retainedEventCount: result.retainedEventCount,
          activeEventCountBefore: result.activeEventCountBefore,
          activeEventCountAfter: result.activeEventCountAfter,
          archivedRecordCount: result.archivedRecordCount,
          failedArchiveCount: result.failedArchiveCount,
          remainingRecordCount: result.remainingRecordCount,
          complete: result.complete,
        },
        sharedTitle: summarizeDriveTitle(result.state),
      }
    }
    case 'project.startDriveTitleRepairInspection': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; open a Drive-shared project first')
      if (project.transport.kind !== 'drive') throw new Error('The active project is not Drive-shared')
      return {
        project: summarizeProject(project, latest.activeProjectId),
        titleRepairJob: summarizeDriveTitleRepairJob(
          driveTitleRepairJobs.startInspection(project.id, project.documentId),
        ),
      }
    }
    case 'project.startDriveTitleRepair': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; open a Drive-shared project first')
      if (project.transport.kind !== 'drive') throw new Error('The active project is not Drive-shared')
      const expectedRepairRevision = requiredString(params, 'expectedRepairRevision')
      if (!/^[a-f0-9]{64}$/i.test(expectedRepairRevision)) {
        throw new Error('Drive title repair revision must be an exact SHA-256 value')
      }
      return {
        project: summarizeProject(project, latest.activeProjectId),
        titleRepairJob: summarizeDriveTitleRepairJob(
          driveTitleRepairJobs.startRepair(
            project.id,
            project.documentId,
            expectedRepairRevision.toLowerCase(),
          ),
        ),
      }
    }
    case 'project.inspectDriveTitleRepairJob': {
      return {
        titleRepairJob: summarizeDriveTitleRepairJob(
          driveTitleRepairJobs.inspect(requiredString(params, 'jobId')),
        ),
      }
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
      if (project.transport.kind === 'drive') {
        const expectedRevisionGuards = requiredStringArray(
          params,
          'expectedTitleRevisionGuards',
          1,
          20,
        ).sort()
        const latest = useStore.getState()
        if (!latest.settings.researcherId || !latest.settings.researcherName.trim()) {
          throw new Error('Set a researcher name in Settings before renaming a shared project')
        }
        const titleState = await updateDriveProjectTitle(
          projectId,
          title,
          expectedRevisionGuards,
          latest.settings.researcherId,
          latest.settings.researcherName.trim(),
        )
        const renamed = useStore.getState().projects.find((candidate) => candidate.id === projectId)
        return {
          project: renamed ? summarizeProject(renamed, useStore.getState().activeProjectId) : null,
          sharedTitle: summarizeDriveTitle(titleState),
        }
      }
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
      const titleState = project.transport.kind === 'drive'
        ? currentDriveProjectTitleState(project.id)
        : null
      return {
        project: summarizeProject(project, latest.activeProjectId),
        document: getAutomationEditorController(project.id).read(),
        sharedTitle: titleState ? summarizeDriveTitle(titleState) : null,
      }
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
    case 'project.inspectRelayPolicy': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      return {
        project: summarizeProject(project, latest.activeProjectId),
        relay: await inspectHostedRelayPolicy(
          project,
          getAutomationProjectDocument(project.id),
        ),
      }
    }
    case 'project.configureRelayPolicy': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const enabled = requiredBoolean(params, 'enabled')
      const requiredApprovals = optionalNonNegativeInteger(params, 'requiredApprovals')
      const signerKeyIds = params.signerKeyIds === undefined
        ? undefined
        : requiredStringArray(params, 'signerKeyIds', 1, 16)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        relay: await configureHostedRelayPolicy(
          project,
          getAutomationProjectDocument(project.id),
          {
            enabled,
            expectedRegistryRevision: requiredPositiveInteger(params, 'expectedRegistryRevision'),
            ...(requiredApprovals === null ? {} : { requiredApprovals }),
            ...(signerKeyIds === undefined ? {} : { signerKeyIds }),
          },
        ),
      }
    }
    case 'project.readScenario': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const read = readAutomationScenario(getAutomationProjectDocument(project.id), project.id, {
        scenarioId: requiredString(params, 'scenarioId'),
      })
      return {
        project: summarizeProject(project, latest.activeProjectId),
        scenario: read.scenario,
        turns: read.turns,
        researchRevision: read.researchRevision,
      }
    }
    case 'project.readScenarioTurnRevision': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const read = readAutomationScenarioTurnRevision(getAutomationProjectDocument(project.id), project.id, {
        scenarioId: requiredString(params, 'scenarioId'),
        turnId: requiredString(params, 'turnId'),
        revisionEditId: optionalString(params, 'revisionEditId') ?? undefined,
        revisionIndex: optionalNonNegativeInteger(params, 'revisionIndex') ?? undefined,
      })
      return {
        project: summarizeProject(project, latest.activeProjectId),
        scenario: read.scenario,
        turn: read.turn,
        revision: read.revision,
        revisionIndex: read.revisionIndex,
        revisionIsCurrent: read.revision.editId === read.currentEditId,
        researchRevision: read.researchRevision,
      }
    }
    case 'project.savePolicyVersion': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const controller = getAutomationEditorController(project.id)
      const document = getAutomationProjectDocument(project.id)
      const saved = await saveAutomationPolicyVersion(
        document,
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
      const attribution = await attestPolicyVersionEvent(document, project.id, saved.version)
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
        attribution,
        researchRevision: projectStateFingerprint(document),
        deterministicChangeNote: saved.changeNote,
      }
    }
    case 'project.restorePolicyVersion': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const controller = getAutomationEditorController(project.id)
      const document = getAutomationProjectDocument(project.id)
      const restored = await restoreAutomationPolicyVersion(
        document,
        project.id,
        {
          targetVersionId: requiredString(params, 'targetVersionId'),
          expectedDocumentRevision: requiredString(params, 'expectedDocumentRevision'),
          expectedHeadVersionId: requiredString(params, 'expectedHeadVersionId'),
          participantId: requiredString(params, 'participantId'),
          displayName: requiredString(params, 'displayName'),
          createdAt: Date.now(),
          note: optionalString(params, 'note'),
        },
        controller,
      )
      const attribution = await attestPolicyVersionEvent(document, project.id, restored.version)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        previousDocumentRevision: restored.previousDocumentRevision,
        document: restored.document,
        version: {
          versionId: restored.version.versionId,
          parentVersionId: restored.version.parentVersionId,
          participantId: restored.version.author.participantId,
          displayName: restored.version.author.displayName,
          createdAt: restored.version.createdAt,
          blockCount: restored.version.policy.blocks.length,
          scenarioCount: restored.version.scenarioIds.length,
          hasNote: restored.version.note !== null,
        },
        attribution,
        researchRevision: projectStateFingerprint(document),
        deterministicChangeNote: restored.changeNote,
      }
    }
    case 'project.createScenario': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const statusValue = optionalString(params, 'status')
      if (statusValue !== null && !['draft', 'ready', 'archived'].includes(statusValue)) {
        throw new Error('status must be draft, ready, or archived')
      }
      const createdAt = Date.now()
      const created = createAutomationScenario(getAutomationProjectDocument(project.id), project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        scenarioId: requiredString(params, 'scenarioId'),
        title: requiredString(params, 'title'),
        background: requiredString(params, 'background', true),
        status: statusValue as ScenarioStatus | null ?? undefined,
        parentScenarioId: optionalString(params, 'parentScenarioId'),
        participantId: requiredString(params, 'participantId'),
        createdAt,
        editId: `mcp-${crypto.randomUUID()}`,
      })
      return {
        project: summarizeProject(project, latest.activeProjectId),
        scenario: {
          id: created.scenario.id,
          title: created.scenario.title,
          status: created.scenario.status,
          parentScenarioId: created.scenario.parentScenarioId,
          createdBy: created.scenario.createdBy,
          createdAt: created.scenario.createdAt,
          turnCount: created.scenario.turns.length,
        },
        researchRevision: created.researchRevision,
      }
    }
    case 'project.addScenarioTurn':
    case 'project.reviseScenarioTurn': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const input = {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        scenarioId: requiredString(params, 'scenarioId'),
        turnId: requiredString(params, 'turnId'),
        role: requiredScenarioTurnRole(params),
        content: requiredString(params, 'content', true),
        participantId: requiredString(params, 'participantId'),
        timestamp: Date.now(),
        editId: `mcp-${crypto.randomUUID()}`,
      }
      const document = getAutomationProjectDocument(project.id)
      const changed = request.method === 'project.addScenarioTurn'
        ? addAutomationScenarioTurn(document, project.id, input)
        : reviseAutomationScenarioTurn(document, project.id, input)
      const attribution = await attestScenarioTurnRevisionEvent(
        document, project.id, input.scenarioId, input.turnId, changed.revision,
      )
      return {
        project: summarizeProject(project, latest.activeProjectId),
        scenario: summarizeScenario(changed.scenario),
        turn: summarizeScenarioTurn(changed.turn),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.reconcileScenarioTurn': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const input = {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        expectedCurrentEditId: requiredString(params, 'expectedCurrentEditId'),
        expectedTipEditIds: requiredStringArray(params, 'expectedTipEditIds', 2, 10_000),
        scenarioId: requiredString(params, 'scenarioId'),
        turnId: requiredString(params, 'turnId'),
        role: requiredScenarioTurnRole(params),
        content: requiredString(params, 'content', true),
        participantId: requiredString(params, 'participantId'),
        timestamp: Date.now(),
        editId: `mcp-${crypto.randomUUID()}`,
      }
      const changed = reconcileAutomationScenarioTurn(document, project.id, input)
      const attribution = await attestScenarioTurnRevisionEvent(
        document, project.id, input.scenarioId, input.turnId, changed.revision,
      )
      return {
        project: summarizeProject(project, latest.activeProjectId),
        scenario: summarizeScenario(changed.scenario),
        turn: summarizeScenarioTurn(changed.turn),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.castScenarioVote': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const voted = castAutomationScenarioVote(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        scenarioId: requiredString(params, 'scenarioId'),
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        choice: requiredScenarioVoteChoice(params),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioVoteEvent(document, project.id, voted.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        vote: {
          scenarioId: voted.summary.scenarioId,
          counts: voted.summary.counts,
          activeVoteCount: voted.summary.activeVotes.length,
          eventCount: voted.summary.history.length,
        },
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.createScenarioAnnotation': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const created = createAutomationScenarioAnnotation(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        annotationId: requiredString(params, 'annotationId'),
        scenarioId: requiredString(params, 'scenarioId'),
        turnId: optionalString(params, 'turnId'),
        kind: requiredScenarioAnnotationKind(params),
        body: requiredString(params, 'body'),
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioAnnotationEvent(document, project.id, created.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        annotation: summarizeScenarioAnnotation(created.annotation),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.updateScenarioAnnotation': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const updated = updateAutomationScenarioAnnotation(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        annotationId: requiredString(params, 'annotationId'),
        scenarioId: requiredString(params, 'scenarioId'),
        expectedCurrentEventId: requiredString(params, 'expectedCurrentEventId'),
        body: requiredString(params, 'body'),
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioAnnotationEvent(document, project.id, updated.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        annotation: summarizeScenarioAnnotation(updated.annotation),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.setScenarioAnnotationResolution': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const changed = resolveAutomationScenarioAnnotation(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        annotationId: requiredString(params, 'annotationId'),
        scenarioId: requiredString(params, 'scenarioId'),
        expectedCurrentEventId: requiredString(params, 'expectedCurrentEventId'),
        resolved: requiredBoolean(params, 'resolved'),
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioAnnotationEvent(document, project.id, changed.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        annotation: summarizeScenarioAnnotation(changed.annotation),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.createScenarioLabel': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const created = createAutomationScenarioLabel(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        labelId: requiredString(params, 'labelId'),
        name: requiredString(params, 'name'),
        participantId: requiredString(params, 'participantId'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioLabelEvent(document, project.id, created.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        label: summarizeScenarioLabel(created.label),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.renameScenarioLabel': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const renamed = renameAutomationScenarioLabel(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        labelId: requiredString(params, 'labelId'),
        name: requiredString(params, 'name'),
        expectedCurrentEventId: requiredString(params, 'expectedCurrentEventId'),
        participantId: requiredString(params, 'participantId'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioLabelEvent(document, project.id, renamed.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        label: summarizeScenarioLabel(renamed.label),
        attribution,
        researchRevision: projectStateFingerprint(document),
      }
    }
    case 'project.setScenarioLabelAssignment': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationProjectDocument(project.id)
      const changed = setAutomationScenarioLabelAssignment(document, project.id, {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        scenarioId: requiredString(params, 'scenarioId'),
        labelId: requiredString(params, 'labelId'),
        expectedCurrentEventId: optionalString(params, 'expectedCurrentEventId'),
        assigned: requiredBoolean(params, 'assigned'),
        participantId: requiredString(params, 'participantId'),
        timestamp: Date.now(),
        eventId: `mcp-${crypto.randomUUID()}`,
      })
      const attribution = await attestScenarioLabelEvent(document, project.id, changed.event)
      return {
        project: summarizeProject(project, latest.activeProjectId),
        assignment: summarizeScenarioLabelAssignment(changed.assignment),
        attribution,
        researchRevision: projectStateFingerprint(document),
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
    case 'research.startAdversarialReview': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const document = getAutomationEditorController(project.id).read()
      return { job: startAdversarialAutomationJob(params, document) }
    }
    case 'research.inspectAdversarialReview':
      return { job: inspectAdversarialAutomationJob(requiredString(params, 'jobId')) }
    case 'research.cancelAdversarialReview':
      return { job: cancelAdversarialAutomationJob(requiredString(params, 'jobId')) }
    case 'research.saveAdversarialReview': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const completed = getPersistableAdversarialAutomationJob(requiredString(params, 'jobId'))
      if (completed.projectId !== project.id) {
        throw new Error('Adversarial review job belongs to a different project')
      }
      const saved = await saveAdversarialReviewArchive(getAutomationProjectDocument(project.id), {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        projectId: project.id,
        sourceDocumentRevision: completed.documentRevision,
        request: completed.request,
        outcome: completed.outcome,
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        createdAt: Date.now(),
      })
      return {
        archive: summarizeAdversarialReviewArchive(saved.archive),
        researchRevision: saved.researchRevision,
      }
    }
    case 'research.decideAdversarialReview': {
      const latest = useStore.getState()
      const project = latest.projects.find(
        (candidate) => candidate.id === latest.activeProjectId && !candidate.archivedAt,
      )
      if (!project) throw new Error('No research project is active; list or create a project first')
      const changed = await decideAdversarialReview(getAutomationProjectDocument(project.id), {
        expectedResearchRevision: requiredString(params, 'expectedResearchRevision'),
        projectId: project.id,
        runId: requiredString(params, 'runId'),
        recordSha256: requiredString(params, 'recordSha256'),
        expectedCurrentDecisionId: optionalString(params, 'expectedCurrentDecisionId'),
        decision: requiredString(params, 'decision') as 'accepted' | 'rejected',
        eventId: `mcp-${crypto.randomUUID()}`,
        participantId: requiredString(params, 'participantId'),
        displayName: requiredString(params, 'displayName'),
        notes: optionalString(params, 'notes') ?? '',
        timestamp: Date.now(),
      })
      return {
        decision: summarizeAdversarialReviewDecision(changed.decision),
        researchRevision: changed.researchRevision,
      }
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
        status: project && automationProjectDocumentReady(project.id) ? 'domain-create-ready' : 'needs-open-project',
        use: 'Scenario records, votes, flags/notes, and shared labels have tested collaborative foundations; MCP can inspect and mutate each through revision guards, while the visible gallery and evaluation UI remain unavailable.',
      },
      {
        name: 'Network collaboration',
        status: project?.transport.kind === 'drive'
          ? 'drive-shared'
          : project
            ? 'local-only'
            : 'needs-project',
        use: project?.transport.kind === 'drive'
          ? 'This project keeps local IndexedDB durability and exchanges append-only Yjs updates through its selected Drive workspace. Presence is not yet available.'
          : 'This project stays local until its owner explicitly shares it to a selected Drive workspace. Offline export creates an independent copy, not live sync.',
      },
    ],
  }
}

async function waitForEditor(projectId: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
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

function summarizeDriveTitle(state: DriveProjectTitleState) {
  return {
    title: state.title,
    revisionGuards: [...state.revisionGuards],
    conflict: state.conflict,
    eventCount: state.eventCount,
    activeEventCount: state.activeEventCount,
    snapshotCount: state.snapshotCount,
    tips: state.tips.map((tip) => ({
      revision: tip.revision,
      parentRevisions: [...tip.parentRevisions],
      title: tip.title,
      participantId: tip.participantId,
      displayName: tip.displayName,
      timestamp: tip.timestamp,
    })),
  }
}

function summarizeDriveTitleRepairJob(job: DriveTitleRepairJob) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    heartbeatAt: job.heartbeatAt,
    error: job.error,
    inspection: job.inspection
      ? {
          repairRevision: job.inspection.repairRevision,
          repairRequired: job.inspection.repairRequired,
          recoverableEventCount: job.inspection.recoverableEventCount,
          activeRecordCount: job.inspection.activeRecordCount,
          archivedRecordCount: job.inspection.archivedRecordCount,
          quarantinedRecordCount: job.inspection.quarantinedRecordCount,
          quarantineCandidateCount: job.inspection.quarantineCandidateCount,
          archiveCandidateCount: job.inspection.archiveCandidateCount,
          invalidArchivedRecordCount: job.inspection.invalidArchivedRecordCount,
          recoverableQuarantinedRecordCount: job.inspection.recoverableQuarantinedRecordCount,
          invalidQuarantinedRecordCount: job.inspection.invalidQuarantinedRecordCount,
          moveCountThisRun: job.inspection.moveCountThisRun,
          remainingMoveCount: job.inspection.remainingMoveCount,
        }
      : null,
    repair: job.repair
      ? {
          repairRevision: job.repair.repairRevision,
          snapshotRevision: job.repair.snapshotRevision,
          recoverableEventCount: job.repair.recoverableEventCount,
          quarantinedRecordCount: job.repair.quarantinedRecordCount,
          archivedRecordCount: job.repair.archivedRecordCount,
          failedMoveCount: job.repair.failedMoveCount,
          remainingMoveCount: job.repair.remainingMoveCount,
          complete: job.repair.complete,
          titleStateReady: job.repair.titleStateReady,
        }
      : null,
  }
}

function summarizeAdversarialReviewArchive(archive: AdversarialReviewArchive) {
  return {
    runId: archive.runId,
    recordSha256: archive.recordSha256,
    sourceDocumentRevision: archive.sourceDocumentRevision,
    researchRevisionAtSave: archive.researchRevisionAtSave,
    createdBy: { ...archive.createdBy },
    createdAt: archive.createdAt,
    sourceCount: archive.request.sources.length,
    participantCount: archive.outcome.plan.participantCount,
    providerCount: archive.outcome.plan.providerCount,
    totalRemoteCalls: archive.outcome.authorization.totalRemoteCalls,
    decision: 'pending' as const,
  }
}

function summarizeAdversarialReviewDecision(summary: AdversarialReviewDecisionSummary) {
  return {
    runId: summary.runId,
    recordSha256: summary.recordSha256,
    current: {
      eventId: summary.current.eventId,
      decision: summary.current.decision,
      participantId: summary.current.participantId,
      timestamp: summary.current.timestamp,
    },
    eventCount: summary.history.length,
  }
}

function summarizeScenario(scenario: ResearchScenario) {
  return {
    id: scenario.id, title: scenario.title, status: scenario.status,
    parentScenarioId: scenario.parentScenarioId, createdBy: scenario.createdBy,
    createdAt: scenario.createdAt, turnCount: scenario.turns.length,
  }
}

function summarizeScenarioTurn(turn: ScenarioTurn) {
  return {
    id: turn.id, role: turn.role, content: turn.content, createdBy: turn.createdBy,
    createdAt: turn.createdAt, revisionCount: turn.revisions.length,
    currentEditId: turn.headEditId, tipEditIds: [...turn.tipEditIds],
    requiresReconciliation: turn.tipEditIds.length > 1,
  }
}

function summarizeScenarioAnnotation(annotation: ScenarioAnnotation) {
  return {
    id: annotation.id, scenarioId: annotation.scenarioId, turnId: annotation.turnId,
    kind: annotation.kind, status: annotation.status, currentEventId: annotation.currentEventId,
    createdBy: annotation.createdBy, createdAt: annotation.createdAt,
    lastActionBy: annotation.lastActionBy, lastActionAt: annotation.lastActionAt,
    eventCount: annotation.events.length,
  }
}

function summarizeScenarioLabel(label: ScenarioLabel) {
  return {
    id: label.id, name: label.name, currentEventId: label.currentEventId,
    createdBy: label.createdBy, createdAt: label.createdAt,
    lastActionBy: label.lastActionBy, lastActionAt: label.lastActionAt,
    eventCount: label.events.length,
  }
}

function summarizeScenarioLabelAssignment(assignment: ScenarioLabelAssignment) {
  return {
    scenarioId: assignment.scenarioId, labelId: assignment.labelId,
    assigned: assignment.assigned, currentEventId: assignment.currentEventId,
    lastActionBy: assignment.lastActionBy, lastActionAt: assignment.lastActionAt,
    eventCount: assignment.events.length,
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Automation parameters must be an object')
  return value as Record<string, unknown>
}

function requiredStringArray(
  params: Record<string, unknown>, name: string, minimum: number, maximum: number,
): string[] {
  const value = params[name]
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
    value.some((item) => typeof item !== 'string' || item.length === 0) ||
    new Set(value).size !== value.length) {
    throw new Error(`Automation parameter ${name} must be a unique string array with ${minimum}-${maximum} items`)
  }
  return [...value]
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

function optionalNonNegativeInteger(params: Record<string, unknown>, name: string): number | null {
  const value = params[name]
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer when provided`)
  return value as number
}

function requiredPositiveInteger(params: Record<string, unknown>, name: string): number {
  const value = params[name]
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return Number(value)
}

function requiredScenarioTurnRole(params: Record<string, unknown>): ScenarioTurnRole {
  const role = requiredString(params, 'role')
  if (!['system', 'user', 'assistant'].includes(role)) throw new Error('role must be system, user, or assistant')
  return role as ScenarioTurnRole
}

function requiredScenarioVoteChoice(params: Record<string, unknown>): ScenarioVoteChoice {
  const choice = requiredString(params, 'choice')
  if (!['support', 'oppose', 'abstain', 'withdrawn'].includes(choice)) {
    throw new Error('choice must be support, oppose, abstain, or withdrawn')
  }
  return choice as ScenarioVoteChoice
}

function requiredScenarioAnnotationKind(params: Record<string, unknown>): ScenarioAnnotationKind {
  const kind = requiredString(params, 'kind')
  if (!['flag', 'note'].includes(kind)) throw new Error('kind must be flag or note')
  return kind as ScenarioAnnotationKind
}

function requiredBoolean(params: Record<string, unknown>, name: string): boolean {
  const value = params[name]
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}
