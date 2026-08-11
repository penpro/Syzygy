import {
  googleDriveProjectTitleRepair,
  googleDriveProjectTitleRepairInspect,
  type DriveProjectTitleRepairInspection,
  type DriveProjectTitleRepairResult,
} from '../tauri'

const MAX_ACTIVE_JOBS = 4
const MAX_RETAINED_JOBS = 32
const TERMINAL_RETENTION_MS = 60 * 60 * 1000
const HEARTBEAT_MS = 30 * 1000

type DriveTitleRepairJobStatus = 'running' | 'succeeded' | 'failed'
type DriveTitleRepairJobKind = 'inspection' | 'repair'

export interface DriveTitleRepairJob {
  jobId: string
  kind: DriveTitleRepairJobKind
  status: DriveTitleRepairJobStatus
  startedAt: number
  updatedAt: number
  heartbeatAt: number
  inspection: DriveProjectTitleRepairInspection | null
  repair: DriveTitleRepairJobResult | null
  error: string | null
}

export interface DriveTitleRepairJobResult {
  repairRevision: string
  snapshotRevision: string | null
  recoverableEventCount: number
  quarantinedRecordCount: number
  archivedRecordCount: number
  failedMoveCount: number
  remainingMoveCount: number
  complete: boolean
  titleStateReady: boolean
}

export interface DriveTitleRepairOperations {
  inspect(projectId: string, documentId: string): Promise<DriveProjectTitleRepairInspection>
  repair(
    projectId: string,
    documentId: string,
    expectedRepairRevision: string,
  ): Promise<DriveProjectTitleRepairResult>
}

const tauriOperations: DriveTitleRepairOperations = {
  inspect: googleDriveProjectTitleRepairInspect,
  repair: googleDriveProjectTitleRepair,
}

function sanitizeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/inventory changed|changed while/i.test(message)) {
    return 'Drive title repair inventory changed; run a new inspection before retrying'
  }
  return 'Drive title repair job failed; review the Syzygy diagnostic log and retry'
}

function cloneJob(job: DriveTitleRepairJob): DriveTitleRepairJob {
  return {
    ...job,
    inspection: job.inspection ? { ...job.inspection } : null,
    repair: job.repair ? { ...job.repair } : null,
  }
}

export class DriveTitleRepairJobRegistry {
  private readonly jobs = new Map<string, DriveTitleRepairJob>()
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private readonly operations: DriveTitleRepairOperations = tauriOperations,
    private readonly now: () => number = Date.now,
  ) {}

  startInspection(projectId: string, documentId: string): DriveTitleRepairJob {
    return this.start('inspection', () => this.operations.inspect(projectId, documentId))
  }

  startRepair(
    projectId: string,
    documentId: string,
    expectedRepairRevision: string,
  ): DriveTitleRepairJob {
    return this.start(
      'repair',
      () => this.operations.repair(projectId, documentId, expectedRepairRevision),
    )
  }

  inspect(jobId: string): DriveTitleRepairJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Drive title repair job was not found or has expired')
    return cloneJob(job)
  }

  private start(
    kind: DriveTitleRepairJobKind,
    operation: () => Promise<DriveProjectTitleRepairInspection | DriveProjectTitleRepairResult>,
  ): DriveTitleRepairJob {
    this.prune()
    const active = [...this.jobs.values()].filter((job) => job.status === 'running').length
    if (active >= MAX_ACTIVE_JOBS) {
      throw new Error('At most four Drive title repair jobs may run at once')
    }
    const timestamp = this.now()
    const job: DriveTitleRepairJob = {
      jobId: crypto.randomUUID(),
      kind,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      heartbeatAt: timestamp,
      inspection: null,
      repair: null,
      error: null,
    }
    this.jobs.set(job.jobId, job)
    const heartbeat = setInterval(() => {
      const current = this.jobs.get(job.jobId)
      if (!current || current.status !== 'running') return
      current.heartbeatAt = this.now()
      current.updatedAt = current.heartbeatAt
    }, HEARTBEAT_MS)
    this.heartbeats.set(job.jobId, heartbeat)

    let operationPromise: Promise<DriveProjectTitleRepairInspection | DriveProjectTitleRepairResult>
    try {
      operationPromise = operation()
    } catch (cause) {
      operationPromise = Promise.reject(cause)
    }
    void operationPromise.then((result) => {
      const current = this.jobs.get(job.jobId)
      if (!current || current.status !== 'running') return
      if (kind === 'inspection') {
        current.inspection = result as DriveProjectTitleRepairInspection
      } else {
        const repair = result as DriveProjectTitleRepairResult
        current.repair = {
          repairRevision: repair.repairRevision,
          snapshotRevision: repair.snapshotRevision,
          recoverableEventCount: repair.recoverableEventCount,
          quarantinedRecordCount: repair.quarantinedRecordCount,
          archivedRecordCount: repair.archivedRecordCount,
          failedMoveCount: repair.failedMoveCount,
          remainingMoveCount: repair.remainingMoveCount,
          complete: repair.complete,
          titleStateReady: repair.state !== null,
        }
      }
      current.status = 'succeeded'
      current.updatedAt = this.now()
      current.heartbeatAt = current.updatedAt
      this.stopHeartbeat(job.jobId)
    }).catch((cause) => {
      const current = this.jobs.get(job.jobId)
      if (!current || current.status !== 'running') return
      current.status = 'failed'
      current.error = sanitizeError(cause)
      current.updatedAt = this.now()
      current.heartbeatAt = current.updatedAt
      this.stopHeartbeat(job.jobId)
    })
    return cloneJob(job)
  }

  private stopHeartbeat(jobId: string): void {
    const heartbeat = this.heartbeats.get(jobId)
    if (heartbeat) clearInterval(heartbeat)
    this.heartbeats.delete(jobId)
  }

  private prune(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS
    for (const [jobId, job] of this.jobs) {
      if (job.status !== 'running' && job.updatedAt < cutoff) {
        this.stopHeartbeat(jobId)
        this.jobs.delete(jobId)
      }
    }
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    while (this.jobs.size >= MAX_RETAINED_JOBS && terminal.length > 0) {
      const oldest = terminal.shift()!
      this.jobs.delete(oldest.jobId)
    }
  }
}

export const driveTitleRepairJobs = new DriveTitleRepairJobRegistry()
