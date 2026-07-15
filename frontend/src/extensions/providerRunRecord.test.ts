import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import providerRunSchema from '../../../docs/schemas/syzygy-provider-run-v1.schema.json'
import { validateProviderRunRecord, type ProviderRunRecord } from './providerRunRecord'

const validatePublicSchema = new Ajv2020({ allErrors: true, strict: true }).compile(providerRunSchema)
const sha = (digit: string) => digit.repeat(64)

const remoteRecord = (): ProviderRunRecord => ({
  recordVersion: 1,
  runId: 'adversarial-run-001',
  callId: 'candidate-call-001',
  executionMode: 'product',
  provider: {
    id: 'xai',
    transport: 'xai-responses',
    model: 'grok-fixture',
    adapterStatus: 'request-control-conformance',
    remote: true,
  },
  request: {
    taskType: 'adversarial.candidate',
    startedAt: '2026-07-15T08:00:00.000Z',
    completedAt: '2026-07-15T08:00:01.000Z',
    sourceSnapshotIds: ['source-snapshot-a'],
    inputSha256: sha('a'),
    maxOutputTokens: 1024,
    timeoutMs: 30000,
    stream: false,
  },
  disclosure: {
    required: true,
    approved: true,
    approvedAt: '2026-07-15T07:59:59.000Z',
    destination: 'https://api.x.ai/v1/responses',
    policyUrl: 'https://docs.x.ai/developers/faq/security',
    policyCheckedAt: '2026-07-15T00:00:00.000Z',
  },
  dataHandling: {
    storageRequest: 'disabled',
    zeroRetention: 'not-attested',
    attestation: { kind: 'response-header', name: 'x-zero-data-retention', value: false },
  },
  result: { status: 'completed', outputSha256: sha('b'), errorCode: null },
  usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0.002 },
})

describe('provider run record', () => {
  it('publishes a strict schema aligned with a content-free remote fixture', () => {
    const fixture = remoteRecord()
    expect(validatePublicSchema(fixture), JSON.stringify(validatePublicSchema.errors)).toBe(true)
    expect(validateProviderRunRecord(fixture)).toEqual([])
  })

  it('records local execution without pretending a remote disclosure or retention policy applies', () => {
    const fixture = remoteRecord()
    fixture.provider = {
      id: 'local',
      transport: 'local-openai-compatible',
      model: 'local-fixture',
      adapterStatus: 'available',
      remote: false,
    }
    fixture.disclosure = {
      required: false,
      approved: false,
      approvedAt: null,
      destination: 'http://127.0.0.1:11435/v1',
      policyUrl: null,
      policyCheckedAt: null,
    }
    fixture.dataHandling = { storageRequest: 'local-only', zeroRetention: 'not-applicable', attestation: null }
    fixture.usage.costUsd = 0
    expect(validatePublicSchema(fixture), JSON.stringify(validatePublicSchema.errors)).toBe(true)
    expect(validateProviderRunRecord(fixture)).toEqual([])
  })

  it('rejects undisclosed remote transmission, insecure destinations, and false retention claims', () => {
    const fixture = remoteRecord()
    fixture.disclosure.approved = false
    fixture.disclosure.approvedAt = null
    fixture.disclosure.destination = 'http://api.x.ai/v1/responses'
    fixture.dataHandling.zeroRetention = 'attested'
    expect(validateProviderRunRecord(fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('disclosure approval'),
        expect.stringContaining('HTTPS'),
        expect.stringContaining('true typed attestation'),
      ]),
    )
  })

  it('allows an honestly marked literal-loopback adapter conformance record only', () => {
    const fixture = remoteRecord()
    fixture.executionMode = 'loopback-conformance'
    fixture.disclosure.destination = 'http://127.0.0.1:43123/v1/responses'
    expect(validatePublicSchema(fixture), JSON.stringify(validatePublicSchema.errors)).toBe(true)
    expect(validateProviderRunRecord(fixture)).toEqual([])
    fixture.disclosure.destination = 'http://localhost:43123/v1/responses'
    expect(validateProviderRunRecord(fixture)).toContain(
      'loopback conformance destination must use literal loopback',
    )
  })

  it('rejects raw research content and credentials even when injected outside the public type', () => {
    const fixture = remoteRecord() as ProviderRunRecord & { prompt?: string; apiKey?: string }
    fixture.prompt = 'raw research prompt'
    fixture.apiKey = 'secret'
    expect(validatePublicSchema(fixture)).toBe(false)
    expect(validateProviderRunRecord(fixture)).toContain(
      'provider run records must not contain prompts, outputs, credentials, or raw payloads',
    )
  })

  it('rejects contradictory terminal state, accounting, timestamps, and duplicate sources', () => {
    const fixture = remoteRecord()
    fixture.result = { status: 'timeout', outputSha256: sha('c'), errorCode: null }
    fixture.usage.totalTokens = 139
    fixture.request.completedAt = '2026-07-15T07:00:00.000Z'
    fixture.request.sourceSnapshotIds.push('source-snapshot-a')
    expect(validateProviderRunRecord(fixture)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sourceSnapshotIds'),
        expect.stringContaining('chronological order'),
        expect.stringContaining('non-completed execution'),
        expect.stringContaining('totalTokens'),
      ]),
    )
  })
})
