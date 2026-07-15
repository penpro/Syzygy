import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import providerRunSchema from '../../../docs/schemas/syzygy-provider-run-v1.schema.json'
import { validateProviderRunRecord, type ProviderRunRecord } from './providerRunRecord'

const serialized = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env?.SYZYGY_PROVIDER_RUN_RECORD

describe('Rust provider runtime record interoperability', () => {
  it.skipIf(!serialized)('passes the public structural and semantic validators without leaking fixture content', () => {
    expect(serialized).not.toContain('interop-secret-canary')
    expect(serialized).not.toContain('interop prompt canary')
    const record = JSON.parse(serialized ?? '') as ProviderRunRecord
    const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(providerRunSchema)
    expect(validateSchema(record), JSON.stringify(validateSchema.errors)).toBe(true)
    expect(validateProviderRunRecord(record)).toEqual([])
    expect(record.executionMode).toBe('loopback-conformance')
    expect(record.result.status).toBe('completed')
  })
})
