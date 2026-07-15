import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import adapterSchema from '../../../docs/schemas/syzygy-model-adapter-v1.schema.json'
import {
  evaluateModelAdapterEndpoint,
  validateModelAdapterProfile,
  type ModelAdapterProfile,
} from './modelAdapterProfile'

const validatePublicSchema = new Ajv2020({ allErrors: true, strict: true }).compile(adapterSchema)
const localProfile = (): ModelAdapterProfile => ({
  schemaVersion: 1,
  id: 'lab-vllm',
  name: 'Lab vLLM',
  version: '1.0.0',
  description: 'A researcher-managed literal-loopback vLLM endpoint.',
  protocol: 'openai-responses',
  endpoint: {
    baseUrl: 'http://127.0.0.1:8000',
    path: '/v1/responses',
    locality: 'literal-loopback',
    authentication: 'bearer-api-key',
  },
  capabilities: { streaming: true, toolCalls: false, structuredOutputs: true, imageInput: false, usage: true },
  dataPolicy: {
    storageControl: 'local-only',
    trainingUse: 'never',
    zeroRetention: 'not-applicable',
    policyUrl: null,
    policyCheckedAt: null,
  },
  limitations: ['Model-specific tool support has not been certified.'],
})

describe('custom model adapter profile', () => {
  it('accepts a strict literal-loopback compatible endpoint profile', () => {
    const profile = localProfile()
    expect(validatePublicSchema(profile), JSON.stringify(validatePublicSchema.errors)).toBe(true)
    expect(validateModelAdapterProfile(profile)).toEqual([])
    expect(evaluateModelAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/responses')).toBe('allow')
  })

  it('rejects compatibility drift, built-in shadowing, and non-loopback local endpoints', () => {
    const profile = localProfile()
    profile.id = 'openai'
    profile.endpoint.path = '/v1/chat/completions'
    profile.endpoint.baseUrl = 'http://localhost:8000'
    expect(validateModelAdapterProfile(profile)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('shadow'),
        expect.stringContaining('compatibility protocol'),
        expect.stringContaining('literal loopback'),
      ]),
    )
  })

  it('requires remote TLS, authentication, dated policy evidence, and honest storage', () => {
    const profile = localProfile()
    profile.endpoint = { ...profile.endpoint, baseUrl: 'http://models.example.test', locality: 'remote', authentication: 'none' }
    profile.dataPolicy.storageControl = 'local-only'
    expect(validateModelAdapterProfile(profile)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HTTPS'),
        expect.stringContaining('credential authentication'),
        expect.stringContaining('dated provider policy'),
        expect.stringContaining('cannot claim local-only'),
      ]),
    )
  })

  it('pins calls to the declared origin and route', () => {
    const profile = localProfile()
    expect(evaluateModelAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/chat/completions')).toBe('deny')
    expect(evaluateModelAdapterEndpoint(profile, 'http://127.0.0.1:8001/v1/responses')).toBe('deny')
    expect(evaluateModelAdapterEndpoint(profile, 'http://127.0.0.1:8000/v1/responses?redirect=https://evil.test')).toBe('deny')
    expect(evaluateModelAdapterEndpoint(profile, 'http://user:pass@127.0.0.1:8000/v1/responses')).toBe('deny')
  })
})
