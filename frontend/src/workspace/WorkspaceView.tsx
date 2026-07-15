import { useStore } from '../store'
import { ResearchEditor } from './ResearchEditor'
import { RemoteResearchReview } from './RemoteResearchReview'

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
        <p>Create a local project now. Shared scenarios, Drive transport, evaluations, and versions will attach to this project without changing its identity.</p>
        <button className="btn primary" type="button" onClick={() => createProject()}>Create research project</button>
      </section>
    )
  }

  return (
    <section className="workspace-shell">
      <header className="workspace-header">
        <div>
          <div className="workspace-kicker mono">Local project · schema v{project.schemaVersion}</div>
          <input
            className="workspace-title-input"
            aria-label="Project title"
            value={project.title}
            onChange={(event) => renameProject(project.id, event.target.value)}
          />
        </div>
        <div className="workspace-header-actions">
          <span className="workspace-status mono">Local persistence</span>
          <button className="btn" type="button" disabled title="Immutable project snapshots arrive in the versioning slice">Snapshot</button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="workspace-rail" aria-label="Project versions">
          <div className="workspace-panel-label mono">Versions</div>
          <div className="workspace-rail-node active"><span>Draft</span><small>Live local state</small></div>
          <div className="workspace-coming">Immutable snapshots and diffs are the next project slice.</div>
        </aside>

        <div className="workspace-editor-column">
          <ResearchEditor key={project.documentId} project={project} />
        </div>

        <aside className="workspace-evaluate" aria-label="Scenario workspace">
          <div className="workspace-panel-label mono">Scenarios</div>
          <h2>Test cases will live here</h2>
          <p>Private experimentation, shared scenario references, and evaluations will use the project’s reserved CRDT collections.</p>
          <button className="btn" type="button" disabled>Add scenario</button>
          <div className="workspace-contract mono">scenarios · heuristics · discussions</div>
          <RemoteResearchReview project={project} />
        </aside>
      </div>
    </section>
  )
}
