import * as Y from 'yjs'
import {
  googleDriveProjectDiscover,
  googleDriveProjectPublish,
  googleDriveSelectWorkspace,
  googleDriveWorkspace,
  type DriveProjectCatalog,
  type DriveProjectDescriptor,
  type DriveWorkspace,
} from '../tauri'
import { useStore } from '../store'
import { bytesToBase64 } from './driveProjectProvider'
import { getAutomationEditorController } from './editorAutomationRegistry'
import type { ResearchProjectManifest } from './schema'
import { getAutomationProjectDocument } from './workspaceAutomationRegistry'

interface DriveProjectActionDependencies {
  workspace: () => Promise<DriveWorkspace | null>
  publish: typeof googleDriveProjectPublish
  discover: () => Promise<DriveProjectCatalog>
  selectWorkspace: (workspaceId: string) => Promise<DriveWorkspace>
  document: (projectId: string) => Y.Doc
  revision: (projectId: string) => string
  projects: () => ResearchProjectManifest[]
  bind: (projectId: string, workspaceId: string) => void
  add: (project: ResearchProjectManifest) => void
  open: (projectId: string) => void
}

const defaultDependencies: DriveProjectActionDependencies = {
  workspace: googleDriveWorkspace,
  publish: googleDriveProjectPublish,
  discover: googleDriveProjectDiscover,
  selectWorkspace: googleDriveSelectWorkspace,
  document: getAutomationProjectDocument,
  revision: (projectId) => getAutomationEditorController(projectId).read().revision,
  projects: () => useStore.getState().projects,
  bind: (projectId, workspaceId) => useStore.getState().bindProjectToDrive(projectId, workspaceId),
  add: (project) => useStore.getState().addSharedProject(project),
  open: (projectId) => useStore.getState().openProject(projectId),
}

export async function listSharedDriveProjects(
  dependencies: DriveProjectActionDependencies = defaultDependencies,
): Promise<DriveProjectCatalog> {
  return dependencies.discover()
}

export async function shareProjectToSelectedDrive(
  project: ResearchProjectManifest,
  expectedDocumentRevision?: string,
  dependencies: DriveProjectActionDependencies = defaultDependencies,
): Promise<{ descriptor: DriveProjectDescriptor; workspace: DriveWorkspace }> {
  if (project.transport.kind !== 'local' || project.archivedAt !== undefined) {
    throw new Error('Only an active local project can be shared')
  }
  const workspace = await dependencies.workspace()
  if (!workspace) throw new Error('Link Google Drive and choose a shared folder first')
  if (expectedDocumentRevision !== undefined && dependencies.revision(project.id) !== expectedDocumentRevision) {
    throw new Error('The project changed before sharing. Read it again and retry.')
  }
  const update = Y.encodeStateAsUpdate(dependencies.document(project.id))
  const descriptor = await dependencies.publish(
    project.id,
    project.documentId,
    project.title,
    project.createdAt,
    bytesToBase64(update),
  )
  if (
    descriptor.workspaceId !== workspace.id
    || descriptor.projectId !== project.id
    || descriptor.documentId !== project.documentId
  ) {
    throw new Error('Drive returned a project identity that does not match this project')
  }
  dependencies.bind(project.id, workspace.id)
  return { descriptor, workspace }
}

export async function joinSharedDriveProject(
  identity: Pick<DriveProjectDescriptor, 'projectId' | 'documentId' | 'workspaceId'>,
  dependencies: DriveProjectActionDependencies = defaultDependencies,
): Promise<ResearchProjectManifest> {
  const catalog = await dependencies.discover()
  const descriptor = catalog.projects.find((candidate) =>
    candidate.projectId === identity.projectId
    && candidate.documentId === identity.documentId
    && candidate.workspaceId === identity.workspaceId)
  if (!descriptor) throw new Error('That exact shared project is no longer available in Drive')

  const selected = await dependencies.selectWorkspace(descriptor.workspaceId)
  if (selected.id !== descriptor.workspaceId) {
    throw new Error('Drive selected a different workspace than the shared project requires')
  }

  const existing = dependencies.projects().find((candidate) =>
    candidate.id === descriptor.projectId || candidate.documentId === descriptor.documentId)
  if (existing) {
    if (
      existing.id !== descriptor.projectId
      || existing.documentId !== descriptor.documentId
      || existing.transport.kind !== 'drive'
      || existing.transport.workspaceId !== descriptor.workspaceId
      || existing.archivedAt !== undefined
    ) {
      throw new Error('A different local project already uses this project or document identity')
    }
    dependencies.open(existing.id)
    return existing
  }

  const project: ResearchProjectManifest = {
    schemaVersion: 1,
    id: descriptor.projectId,
    documentId: descriptor.documentId,
    title: descriptor.title,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.createdAt,
    transport: { kind: 'drive', workspaceId: descriptor.workspaceId },
  }
  dependencies.add(project)
  return project
}

export type { DriveProjectActionDependencies }
