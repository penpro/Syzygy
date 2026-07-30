import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationEditorSnapshot } from '../workspace/editorAutomationRegistry'
import type { NativeAdversarialPanelOutcome } from './adversarialNativeExecutor'
import {
  buildAdversarialAutomationRequest,
  cancelAdversarialAutomationJob,
  inspectAdversarialAutomationJob,
  resetAdversarialAutomationJobsForTests,
  startAdversarialAutomationJob,
} from './adversarialAutomation'

const document = (): AutomationEditorSnapshot => ({
  projectId: 'project-001',
  revision: 'lexical-session-1-deadbeef',
  text: '# Evidence\nSupported fact.\n\nConflicting fact.',
  blocks: [
    { kind: 'heading1', text: 'Evidence' },
    { kind: 'paragraph', text: 'Supported fact.' },
    { kind: 'paragraph', text: '' },
    { kind: 'quote', text: 'Conflicting fact.' },
  ],
  scenarioIds: [],
})

const params = () => ({
  expectedDocumentRevision: document().revision,
  runId: 'automation-run-001',
  question: 'Which conclusion is supported?',
  seed: 'automation-seed',
  sourceBlockIndexes: [1, 3],
  participants: [
    { slotId: 'candidate-a', providerId: 'openai', modelId: 'model-a' },
    { slotId: 'candidate-b', providerId: 'anthropic', modelId: 'model-b' },
  ],
  judge: { slotId: 'judge', providerId: 'gemini', modelId: 'judge-model' },
  baseline: { slotId: 'baseline', providerId: 'xai', modelId: 'baseline-model' },
})

afterEach(() => {
  resetAdversarialAutomationJobsForTests()
  vi.useRealTimers()
})

describe('adversarial automation jobs', () => {
  it('derives disclosure sources only from exact revision-guarded live document blocks', () => {
    const request = buildAdversarialAutomationRequest(params(), document())
    expect(request.sources.map(({ excerpt }) => excerpt)).toEqual(['Supported fact.', 'Conflicting fact.'])
    expect(request.sources.every(({ snapshotId }) => /^block-[24]-[0-9a-f]{8}$/.test(snapshotId))).toBe(true)
    expect(request.input.participants.map(({ providerId }) => providerId)).toEqual(['openai', 'anthropic'])

    expect(() =>
      buildAdversarialAutomationRequest({ ...params(), expectedDocumentRevision: 'stale' }, document()),
    ).toThrow('Revision conflict')
    expect(() =>
      buildAdversarialAutomationRequest({ ...params(), sourceBlockIndexes: [2] }, document()),
    ).toThrow('has no text')
    expect(() =>
      buildAdversarialAutomationRequest({ ...params(), sourceBlockIndexes: [1, 1] }, document()),
    ).toThrow('must be unique')
  })

  it('returns immediately, exposes bounded polling state, and retains no shared mutation authority', async () => {
    let resolve!: (value: NativeAdversarialPanelOutcome) => void
    const run = vi.fn(() => new Promise<NativeAdversarialPanelOutcome>((next) => { resolve = next }))
    const started = startAdversarialAutomationJob(params(), document(), run, 1_000)
    expect(started.status).toBe('running')
    expect(started.totalRemoteCalls).toBe(14)
    expect(started.outcome).toBeNull()
    expect(run).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    const completed = {
      record: {
        humanDecision: { status: 'pending' },
        sharedMutation: { applied: false },
      },
    } as unknown as NativeAdversarialPanelOutcome
    resolve(completed)
    await vi.waitFor(() => expect(inspectAdversarialAutomationJob(started.jobId).status).toBe('completed'))
    const inspected = inspectAdversarialAutomationJob(started.jobId)
    expect(inspected.outcome?.record.humanDecision.status).toBe('pending')
    expect(inspected.outcome?.record.sharedMutation.applied).toBe(false)
  })

  it('cancels through the shared abort signal and sanitizes the terminal job state', async () => {
    const run = vi.fn((_request, signal?: AbortSignal) => new Promise<NativeAdversarialPanelOutcome>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('provider-secret-canary'), { code: 'cancelled' })))
    }))
    const started = startAdversarialAutomationJob(params(), document(), run)
    await Promise.resolve()
    cancelAdversarialAutomationJob(started.jobId)
    await vi.waitFor(() => expect(inspectAdversarialAutomationJob(started.jobId).status).toBe('cancelled'))
    const inspected = inspectAdversarialAutomationJob(started.jobId)
    expect(inspected.errorCode).toBe('cancelled')
    expect(JSON.stringify(inspected)).not.toContain('provider-secret-canary')
  })

  it('checks running jobs every 30 seconds and aborts at the absolute fifteen-minute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    let aborted = false
    const run = vi.fn((_request, signal?: AbortSignal) => new Promise<NativeAdversarialPanelOutcome>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('deadline'), { code: 'cancelled' }))
      })
    }))
    const started = startAdversarialAutomationJob(params(), document(), run, Date.now())
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(aborted).toBe(true)
    expect(inspectAdversarialAutomationJob(started.jobId).status).toBe('cancelled')
  })
})
