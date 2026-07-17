import { useStore } from '../store'
import { DriveProjectControls } from './DriveProjectControls'
import { ResearchEditor } from './ResearchEditor'
import { RemoteResearchReview } from './RemoteResearchReview'
import { PolicyVersionRail } from './PolicyVersionRail'
import { ProjectArchiveControls } from './ProjectArchiveControls'
import { ScenarioWorkspace } from './ScenarioWorkspace'

export function WorkspaceView() {
  const projects = useStore((state) => state.projects)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const createProject = useStore((state) => state.createProject)
  const renameProject = useStore((state) => state.renameProject)
  const project = projects.find((candidate) => candidate.id === activeProjectId && !candidate.archivedAt)

  if (!project) {
    return (
      <section className="workspace-empty" aria-labelledby="workspace-empty-title">
        <div className="workspace-kicker mono">Research workspace</div>
        <h1 id="workspace-empty-title">Turn evidence into a policy you can test.</h1>
        <p>Create a private local project, or join a project shared through the selected Google Drive workspace.</p>
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
          <DriveProjectControls project={project} />
          <ProjectArchiveControls project={project} />
          {!shared && <span className="workspace-status mono">Local persistence · immutable history</span>}
        </div>
      </header>

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
