import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store'
import { createProjectManifest, type ResearchProjectManifest } from './schema'

let projects: ResearchProjectManifest[]
let activeProjectId: string | null

beforeEach(() => {
  projects = useStore.getState().projects
  activeProjectId = useStore.getState().activeProjectId
  useStore.setState({ projects: [], activeProjectId: null })
})

afterEach(() => useStore.setState({ projects, activeProjectId }))

describe('self-hosted project store binding', () => {
  it('binds only a local project, normalizes its endpoint, and can leave without deleting local state', () => {
    const project = createProjectManifest({ id: 'project-a', documentId: 'document-a', timestamp: 1 })
    useStore.setState({ projects: [project], activeProjectId: project.id })
    useStore.getState().bindProjectToWebsocket(project.id, {
      endpoint: 'ws://192.168.1.20:1234/',
      roomId: 'room_' + 'a'.repeat(40),
    })
    expect(useStore.getState().projects[0].transport).toEqual({
      kind: 'websocket', endpoint: 'ws://192.168.1.20:1234', roomId: 'room_' + 'a'.repeat(40),
    })
    useStore.getState().leaveSelfHostedProject(project.id)
    expect(useStore.getState().projects[0].transport).toEqual({ kind: 'local' })
  })

  it('joins an exact invitation once and rejects identity collisions or another transport', () => {
    const shared: ResearchProjectManifest = {
      ...createProjectManifest({ id: 'shared', documentId: 'shared-doc', timestamp: 1 }),
      transport: { kind: 'websocket', endpoint: 'wss://relay.example.test', roomId: 'room_' + 'b'.repeat(40) },
    }
    useStore.getState().addSelfHostedProject(shared)
    expect(useStore.getState().projects).toEqual([shared])
    expect(useStore.getState().activeProjectId).toBe(shared.id)
    expect(() => useStore.getState().addSelfHostedProject(shared)).toThrow('already exists')
    expect(() => useStore.getState().addSelfHostedProject({ ...shared, id: 'other' })).toThrow('already exists')
    expect(() => useStore.getState().addSelfHostedProject({ ...shared, transport: { kind: 'local' } }))
      .toThrow('active WebSocket')
  })

  it('refuses rebinding Drive or already self-hosted projects', () => {
    const drive: ResearchProjectManifest = {
      ...createProjectManifest({ id: 'drive', documentId: 'drive-doc', timestamp: 1 }),
      transport: { kind: 'drive', workspaceId: 'workspace' },
    }
    useStore.setState({ projects: [drive] })
    expect(() => useStore.getState().bindProjectToWebsocket(drive.id, {
      endpoint: 'ws://127.0.0.1:1234', roomId: 'room_' + 'c'.repeat(40),
    })).toThrow('Only an active local')
  })
})
