import { useStore } from '../store'
import { GoogleDriveButton } from '../components/GoogleDriveButton'
import { DriveProjectControls } from './DriveProjectControls'
import { ResearchEditor } from './ResearchEditor'
import { RemoteResearchReview } from './RemoteResearchReview'
import { PolicyVersionRail } from './PolicyVersionRail'
import { ProjectArchiveControls } from './ProjectArchiveControls'
import { ScenarioWorkspace } from './ScenarioWorkspace'
import type { ResearchProjectManifest } from './schema'

export function LocalProjectSharingPanel({ project }: { project: ResearchProjectManifest }) {
  return (
    <section className="local-project-sharing" aria-label="Share or transfer this local project">
      <div className="project-sharing-copy">
        <div className="workspace-panel-label mono">Project sharing</div>
        <strong>This project is private on this computer.</strong>
        <p>
          Share it through Drive for ongoing collaboration, or export an offline copy that another
          person can import independently. Offline copies do not keep syncing.
        </p>
      </div>
      <div className="project-sharing-actions">
        <GoogleDriveButton />
        <DriveProjectControls project={project} />
        <ProjectArchiveControls project={project} />
      </div>
    </section>
  )
}

export function WorkspaceView() {
  const projects = useStore((state) => state.projects)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const createProject = useStore((state) => state.createProject)
  const renameProject = useStore((state) => state.renameProject)
  const project = projects.find((candidate) => candidate.id === activeProjectId && !candidate.archivedAt)

  if (!project) {
    return (
      <section className="workspace-empty" aria-labelledby="workspace-empty-title">
        <div className="workspace-kicker mono">Research workspace · collaboration</div>
        <h1 id="workspace-empty-title">Create locally. Share when you're ready.</h1>
        <p>
          Projects begin private on this computer. Connect Drive here to share one for live
          collaboration or to join a project someone else shared.
        </p>
        <div className="workspace-connection-card" aria-label="Google Drive collaboration connection">
          <div>
            <div className="workspace-panel-label mono">Google Drive connection</div>
            <p>
              Direct folder access is used for collaboration. A local mirror is created only when you choose Sync.
            </p>
          </div>
          <GoogleDriveButton />
        </div>
        <div className="workspace-empty-actions">
          <button className="btn primary" type="button" onClick={() => createProject()}>Create research project</button>
          <ProjectArchiveControls />
        </div>
        <DriveProjectControls />
      </section>
    )
  }

  const shared = project.transport.kind === 'drive'
  const editorKey = project.transport.kind === 'drive' ? project.documentId + ':drive:' + project.transport.workspaceId : project.documentId + ':local'

  return (
    <section className="workspace-shell">
      <header className="workspace-header">
        <div>
          <div className="workspace-kicker mono">{shared ? 'Drive shared project' : 'Local project'} · schema v{project.schemaVersion}</div>
          <input
            className="workspace-title-input"
            aria-label="Project title"
            value={project.title}
            readOnly={shared}
            title={shared ? 'Shared project titles are fixed in this transport version.' : undefined}
            onChange={(event) => renameProject(project.id, event.target.value)}
          />
        </div>
        <div className="workspace-header-actions">
          {shared ? (
            <>
              <DriveProjectControls project={project} />
              <ProjectArchiveControls project={project} />
            </>
          ) : (
            <span className="workspace-status mono">Private local project · immutable history</span>
          )}
        </div>
      </header>

      {!shared && <LocalProjectSharingPanel project={project} />}

      <div className="workspace-grid">
        <PolicyVersionRail project={project} />

        <div className="workspace-editor-column">
          <ResearchEditor key={editorKey} project={project} />
        </div>

        <aside className="workspace-evaluate" aria-label="Scenario workspace">
          <ScenarioWorkspace project={project} />
          <RemoteResearchReview project={project} />
        </aside>
      </div>
    </section>
  )
}
