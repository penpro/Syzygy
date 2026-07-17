import { useState } from 'react'
import { useStore } from '../store'
import type { AppView } from '../types'
import type { ResearchProjectManifest } from '../workspace/schema'
import { DownloadIndicator } from './DownloadIndicator'
import { TipRotator } from './TipRotator'
import { useConfirm } from './ConfirmDialog'
import { UI_ICONS } from '../uiIcons'
import { cx, timeAgo } from '../util'

export function ProjectList({
  projects,
  activeProjectId,
  view,
  createProject,
  openProject,
  browseSharedProjects,
}: {
  projects: ResearchProjectManifest[]
  activeProjectId: string | null
  view: AppView
  createProject: () => string
  openProject: (id: string) => void
  browseSharedProjects: () => void
}) {
  const activeProjects = projects.filter((project) => !project.archivedAt)
  return (
    <div className="project-list">
      <button className="sidebar-empty-action" type="button" onClick={browseSharedProjects}>
        Drive & shared projects
      </button>
      {activeProjects.length === 0 && (
        <button className="sidebar-empty-action" type="button" onClick={createProject}>
          Create your first project
        </button>
      )}
      {activeProjects.map((project) => (
        <button
          type="button"
          key={project.id}
          className={cx('project-row', view === 'workspace' && project.id === activeProjectId && 'active')}
          onClick={() => openProject(project.id)}
        >
          <span className="project-row-mark" aria-hidden="true">§</span>
          <span>{project.title.trim() || 'Untitled research project'}</span>
        </button>
      ))}
    </div>
  )
}

export function Sidebar({
  collapsed,
  onOpenSettings,
  onOpenTutorial,
  onOpenWelcome,
}: {
  collapsed?: boolean
  onOpenSettings: () => void
  onOpenTutorial: () => void
  onOpenWelcome: () => void
}) {
  const confirm = useConfirm()
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const createProject = useStore((s) => s.createProject)
  const openProject = useStore((s) => s.openProject)
  const browseSharedProjects = useStore((s) => s.browseSharedProjects)
  const asks = useStore((s) => s.asks)
  const activeAskId = useStore((s) => s.activeAskId)
  const createAsk = useStore((s) => s.createAsk)
  const openAsk = useStore((s) => s.openAsk)
  const updateAsk = useStore((s) => s.updateAsk)
  const deleteAsk = useStore((s) => s.deleteAsk)
  // Inline rename: which ask row is being edited, and its in-progress text.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const commitRename = () => {
    if (renamingId && renameText.trim()) updateAsk(renamingId, { title: renameText.trim() })
    setRenamingId(null)
  }

  const sortedAsks = [...asks].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className={cx('sidebar', collapsed && 'is-docked')}>
      <div className="side-section project-section">
        <div className="side-head">
          <span>Research projects</span>
          <button className="icon-btn" title="New research project" onClick={() => createProject()}>
            ＋
          </button>
        </div>
        <ProjectList
          projects={projects}
          activeProjectId={activeProjectId}
          view={view}
          createProject={createProject}
          openProject={openProject}
          browseSharedProjects={browseSharedProjects}
        />
      </div>
      <div className="side-section grow">
        <div className="side-head">
          <span>Asks</span>
          <button className="icon-btn" title="New ask" onClick={() => createAsk()}>
            ＋
          </button>
        </div>
        <div className="chat-list">
          {sortedAsks.length === 0 && <div className="muted sm pad">No asks yet.</div>}
          {sortedAsks.map((a) => (
            <div key={a.id} className={cx('chat-row', view === 'ask' && a.id === activeAskId && 'active')} onClick={() => openAsk(a.id)}>
              <div className="msg-avatar sm" style={{ background: 'var(--accent)' }}>
                🪄
              </div>
              <div className="chat-row-main">
                {renamingId === a.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    style={{ width: '100%', font: 'inherit' }}
                  />
                ) : (
                  <div className="chat-row-title">{a.title?.trim() ? a.title.trim().slice(0, 44) : a.messages?.[0]?.content?.trim().slice(0, 44) || 'New ask'}</div>
                )}
                <div className="muted xs">{timeAgo(a.updatedAt)}</div>
              </div>
              <button
                className="icon-btn sm row-action"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(a.id)
                  setRenameText(a.title?.trim() || a.messages?.[0]?.content?.trim().slice(0, 44) || '')
                }}
              >
                ✎
              </button>
              <button
                className="icon-btn sm row-action"
                title="Delete"
                onClick={async (e) => {
                  e.stopPropagation()
                  if (await confirm({ title: 'Delete thread?', message: 'This Ask thread will be permanently deleted.', confirmLabel: 'Delete' }))
                    deleteAsk(a.id)
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>

      <TipRotator />

      <div className="side-foot">
        <DownloadIndicator />
        <div className="foot-row">
          <button className="foot-icon" title="Drive collaboration and shared projects" onClick={browseSharedProjects}>
            <span className="foot-text-icon" aria-hidden="true">☁</span>
            <span>Drive</span>
          </button>
          <button className="foot-icon" title="Open Ask" onClick={() => setView('ask')}>
            <span className="foot-text-icon" aria-hidden="true">?</span>
            <span>Ask</span>
          </button>
          <button className="foot-icon" title="Quick tour — replay the feature tour" onClick={onOpenWelcome}>
            <img src={UI_ICONS.how} alt="" aria-hidden="true" />
            <span>Tour</span>
          </button>
          <button className="foot-icon" title="How it works — the architecture, in plain terms" onClick={onOpenTutorial}>
            <img src={UI_ICONS.how} alt="" aria-hidden="true" />
            <span>How</span>
          </button>
          <button className="foot-icon" title="Settings" onClick={onOpenSettings}>
            <img src={UI_ICONS.settings} alt="" aria-hidden="true" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
