import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_DESCRIPTORS, validateProviderDescriptor } from './providerContract'

describe('model provider contract', () => {
  it('keeps local inference available and every remote adapter explicitly planned', () => {
    const local = BUILTIN_PROVIDER_DESCRIPTORS.find(({ id }) => id === 'local')
    expect(local?.implementation).toBe('available')
    expect(local?.dataPolicy.remote).toBe(false)

    const remote = BUILTIN_PROVIDER_DESCRIPTORS.filter(({ dataPolicy }) => dataPolicy.remote)
    expect(remote.map(({ id }) => id)).toEqual(['openai', 'anthropic', 'gemini', 'xai'])
    expect(remote.every(({ implementation }) => implementation === 'planned')).toBe(true)
    expect(remote.every(({ dataPolicy }) => dataPolicy.disclosureRequired && dataPolicy.policyUrl)).toBe(true)
  })

  it('validates every built-in descriptor', () => {
    expect(BUILTIN_PROVIDER_DESCRIPTORS.map(validateProviderDescriptor)).toEqual([[], [], [], [], []])
  })

  it('rejects insecure remote endpoints and undisclosed transmission', () => {
    const candidate = structuredClone(BUILTIN_PROVIDER_DESCRIPTORS[1])
    candidate.defaultBaseUrl = 'http://api.example.test/v1'
    candidate.dataPolicy.disclosureRequired = false
    expect(validateProviderDescriptor(candidate)).toEqual([
      'remote providers must require disclosure and local providers must not',
      'remote defaultBaseUrl must use HTTPS',
    ])
  })
})
