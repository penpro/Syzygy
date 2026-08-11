import { describe, expect, it } from 'vitest'
import type {
  DriveProjectTitleRepairInspection,
  DriveProjectTitleRepairResult,
} from '../tauri'
import {
  DriveTitleRepairJobRegistry,
  type DriveTitleRepairOperations,
} from './driveTitleRepairJobs'

const inspection: DriveProjectTitleRepairInspection = {
  repairRevision: 'a'.repeat(64),
  repairRequired: true,
  recoverableEventCount: 3,
  activeRecordCount: 2,
  archivedRecordCount: 4,
  quarantinedRecordCount: 0,
  quarantineCandidateCount: 1,
  archiveCandidateCount: 1,
  invalidArchivedRecordCount: 0,
  recoverableQuarantinedRecordCount: 0,
  invalidQuarantinedRecordCount: 0,
  moveCountThisRun: 2,
  remainingMoveCount: 0,
}

const repair: DriveProjectTitleRepairResult = {
  repairRevision: inspection.repairRevision,
  snapshotRevision: 'b'.repeat(64),
  recoverableEventCount: 3,
  quarantinedRecordCount: 1,
  archivedRecordCount: 1,
  failedMoveCount: 0,
  remainingMoveCount: 0,
  complete: true,
  state: {
    projectId: 'project-1',
    documentId: 'document-1',
    baseTitle: 'Secret base title',
    title: 'Secret repaired title',
    revisionGuards: ['c'.repeat(64)],
    conflict: false,
    eventCount: 3,
    activeEventCount: 0,
    snapshotCount: 1,
    tips: [{
      revision: 'c'.repeat(64),
      parentRevisions: [],
      title: 'Secret repaired title',
      participantId: 'secret-participant',
      displayName: 'Secret Author',
      timestamp: 1,
    }],
  },
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Drive title repair job registry', () => {
  it('returns immediately, then retains content-minimized inspection and repair results', async () => {
    const operations: DriveTitleRepairOperations = {
      inspect: async () => inspection,
      repair: async () => repair,
    }
    const registry = new DriveTitleRepairJobRegistry(operations, () => 10)
    const inspecting = registry.startInspection('project-1', 'document-1')
    expect(inspecting.status).toBe('running')
    await settle()
    expect(registry.inspect(inspecting.jobId)).toMatchObject({
      status: 'succeeded',
      inspection: { recoverableEventCount: 3 },
      repair: null,
    })

    const repairing = registry.startRepair('project-1', 'document-1', inspection.repairRevision)
    await settle()
    const repairedState = registry.inspect(repairing.jobId)
    expect(repairedState).toMatchObject({
      status: 'succeeded',
      inspection: null,
      repair: { complete: true, quarantinedRecordCount: 1, titleStateReady: true },
    })
    expect(JSON.stringify(repairedState)).not.toContain('Secret')
  })

  it('sanitizes terminal failures and bounds concurrent jobs', async () => {
    const resolvers: Array<(value: DriveProjectTitleRepairInspection) => void> = []
    const operations: DriveTitleRepairOperations = {
      inspect: () => new Promise((resolve) => resolvers.push(resolve)),
      repair: async () => {
        throw new Error('bad\nsecret-shaped failure')
      },
    }
    const registry = new DriveTitleRepairJobRegistry(operations)
    const active = Array.from({ length: 4 }, () => registry.startInspection('project-1', 'document-1'))
    expect(() => registry.startInspection('project-1', 'document-1')).toThrow('At most four')
    resolvers.forEach((resolve) => resolve(inspection))
    await settle()
    expect(active.every((job) => registry.inspect(job.jobId).status === 'succeeded')).toBe(true)

    const failed = registry.startRepair('project-1', 'document-1', inspection.repairRevision)
    await settle()
    const failedState = registry.inspect(failed.jobId)
    expect(failedState).toMatchObject({
      status: 'failed',
      error: 'Drive title repair job failed; review the Syzygy diagnostic log and retry',
    })
    expect(JSON.stringify(failedState)).not.toContain('secret-shaped')
  })

  it('captures a synchronous connector failure as a sanitized terminal job', async () => {
    const operations: DriveTitleRepairOperations = {
      inspect: () => {
        throw new Error('synchronous secret-shaped failure')
      },
      repair: async () => repair,
    }
    const registry = new DriveTitleRepairJobRegistry(operations)
    const started = registry.startInspection('project-1', 'document-1')
    expect(started.status).toBe('running')
    await settle()
    const failedState = registry.inspect(started.jobId)
    expect(failedState).toMatchObject({
      status: 'failed',
      error: 'Drive title repair job failed; review the Syzygy diagnostic log and retry',
    })
    expect(JSON.stringify(failedState)).not.toContain('secret-shaped')
  })
})
