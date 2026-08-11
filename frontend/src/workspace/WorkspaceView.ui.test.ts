import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { LocalProjectSharingPanel, WorkspaceView } from './WorkspaceView'
import { SelfHostedProjectControls } from './SelfHostedProjectControls'
import {
  editSharedProjectTitleDraft,
  SharedProjectTitleControl,
  syncSharedProjectTitleDraft,
} from './SharedProjectTitleControl'

const localProject: ResearchProjectManifest = {
  schemaVersion: 1,
  id: 'workspace-sharing-project',
  documentId: 'workspace-sharing-document',
  title: 'Local collaboration draft',
  createdAt: 1,
  updatedAt: 1,
  transport: { kind: 'local' },
}
const driveProject: ResearchProjectManifest = {
  ...localProject,
  id: 'workspace-shared-project',
  documentId: 'workspace-shared-document',
  title: 'Shared collaboration draft',
  transport: { kind: 'drive', workspaceId: 'workspace-drive' },
}
const websocketProject: ResearchProjectManifest = {
  ...localProject,
  id: 'workspace-self-hosted-project',
  documentId: 'workspace-self-hosted-document',
  title: 'Self-hosted collaboration draft',
  transport: {
    kind: 'websocket',
    endpoint: 'ws://192.168.1.20:1234',
    roomId: 'room_' + 'a'.repeat(40),
  },
}
const managedWebsocketProject: ResearchProjectManifest = {
  ...websocketProject,
  id: 'workspace-managed-relay-project',
  documentId: 'workspace-managed-relay-document',
  transport: {
    kind: 'websocket',
    endpoint: 'ws://192.168.1.20:1234',
    roomId: 'room_' + 'a'.repeat(40),
    access: {
      schemaVersion: 1,
      memberId: 'member_' + 'b'.repeat(24),
      capability: 'c'.repeat(43),
      role: 'viewer',
    },
  },
}

let previousProjects: ResearchProjectManifest[]
let previousActiveProjectId: string | null

beforeEach(() => {
  const state = useStore.getState()
  previousProjects = state.projects
  previousActiveProjectId = state.activeProjectId
  useStore.setState({ projects: [], activeProjectId: null })
})

afterEach(() => {
  useStore.setState({
    projects: previousProjects,
    activeProjectId: previousActiveProjectId,
  })
})

describe('workspace collaboration entry points', () => {
  it('offers Drive setup outside Ask even when no project is open', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceView))

    expect(html).toContain('Google Drive connection')
    expect(html).toContain('Link Drive')
    expect(html).toContain('Create research project')
    expect(html).toContain('Import offline copy')
    expect(html).toContain('Shared Drive projects')
    expect(html).toContain('Join a self-hosted project (advanced)')
    expect(html).toContain('bearer invitation')
  })

  it('distinguishes live Drive sharing from an independent offline copy', () => {
    const html = renderToStaticMarkup(createElement(LocalProjectSharingPanel, { project: localProject }))

    expect(html).toContain('This project is private on this computer')
    expect(html).toContain('ongoing collaboration')
    expect(html).toContain('Offline copies do not keep syncing')
    expect(html).toContain('Share this project')
    expect(html).toContain('Export offline copy')
    expect(html).toContain('advanced self-hosted relay')
  })

  it('makes the self-hosted relay an explicit acknowledged product action', () => {
    const localHtml = renderToStaticMarkup(createElement(SelfHostedProjectControls, { project: localProject }))
    expect(localHtml).toContain('Self-hosted relay (advanced)')
    expect(localHtml).toContain('The relay is not a backup')
    expect(localHtml).toContain('managed invitations enforce their assigned role')
    expect(localHtml).toContain('Create invitation and connect')

    const sharedHtml = renderToStaticMarkup(createElement(SelfHostedProjectControls, { project: websocketProject }))
    expect(sharedHtml).toContain('Anyone with this legacy invitation can read and edit')
    expect(sharedHtml).toContain('Leave relay · keep local copy')
    expect(sharedHtml).toContain('Local IndexedDB remains the durable copy')
  })

  it('makes a Drive-shared title an explicit synchronized action instead of a read-only field', () => {
    const html = renderToStaticMarkup(createElement(SharedProjectTitleControl, { project: driveProject }))

    expect(html).toContain('aria-label="Shared project title"')
    expect(html).toContain('Rename shared project')
    expect(html).toContain('Loading shared title')
    expect(html).toContain('Check title recovery')
    expect(html).toContain('without returning titles, authors, file names, or Drive file IDs')
    expect(html).not.toContain('Shared project titles are fixed')
  })

  it('offers the app-managed relay with role and legacy bearer disclosure', () => {
    const html = renderToStaticMarkup(createElement(SelfHostedProjectControls, {
      project: localProject,
      managedRelayEndpoint: 'ws://192.168.1.20:37665',
    }))
    expect(html).toContain('Use this app’s relay · ws://192.168.1.20:37665')
    expect(html).toContain('adds member roles and revocation')
    expect(html).toContain('legacy invitations grant read and edit')

    const viewer = renderToStaticMarkup(createElement(SelfHostedProjectControls, {
      project: managedWebsocketProject,
    }))
    expect(viewer).toContain('Member access')
    expect(viewer).toContain('viewer')
    expect(viewer).toContain('Viewer document updates are rejected by the relay')
    expect(viewer).not.toContain('Legacy read/edit bearer invitation')
  })

  it('retains the exact revision guards captured when a shared-title draft became dirty', () => {
    const original = {
      schemaVersion: 1 as const,
      projectId: driveProject.id,
      documentId: driveProject.documentId,
      baseTitle: driveProject.title,
      title: driveProject.title,
      revisionGuards: ['a'.repeat(64)],
      conflict: false,
      eventCount: 0,
      activeEventCount: 0,
      snapshotCount: 0,
      tips: [],
    }
    const changed = editSharedProjectTitleDraft(
      { title: original.title, revisionGuards: original.revisionGuards, dirty: false },
      'Offline draft title',
      original,
    )
    const peerUpdate = {
      ...original,
      title: 'Peer title',
      revisionGuards: ['b'.repeat(64)],
      eventCount: 1,
    }

    expect(syncSharedProjectTitleDraft(changed, peerUpdate)).toEqual(changed)
    expect(changed.revisionGuards).toEqual(original.revisionGuards)
    expect(changed.revisionGuards).not.toEqual(peerUpdate.revisionGuards)
  })
})
