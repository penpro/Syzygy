import { describe, expect, it } from 'vitest'
import type { ProviderNormalizedResponse, ProviderToolDefinition } from './tauri'
import { validateProviderToolProposal } from './providerToolValidation'

const serialized = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env?.SYZYGY_PROVIDER_TOOL_VALIDATION

const definitions: ProviderToolDefinition[] = [{
  name: 'lookup_source',
  description: 'Propose a bounded source lookup.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['query'],
    additionalProperties: false,
  },
}]

describe('Rust and TypeScript provider tool validation interoperability', () => {
  it.skipIf(!serialized)('agrees on valid, invalid, and missing-definition status without execution authority', () => {
    const response = JSON.parse(serialized ?? '') as ProviderNormalizedResponse
    expect(response.toolProposals.map(({ validation }) => validation.schemaStatus)).toEqual([
      'valid',
      'invalid',
      'missing-definition',
    ])
    for (const proposal of response.toolProposals) {
      const frontend = validateProviderToolProposal(definitions, proposal)
      expect(proposal.validation.schemaStatus).toBe(frontend.schemaStatus)
      expect(proposal.validation.domainStatus).toBe('unreviewed')
      expect(proposal.validation.executable).toBe(false)
      expect(proposal.validation.errors.length).toBeLessThanOrEqual(8)
      expect(JSON.stringify(proposal.validation.errors)).not.toContain('budget')
      expect(JSON.stringify(proposal.validation.errors)).not.toContain('C:\\private')
      expect(JSON.stringify(proposal.validation.errors)).not.toContain('whoami')
    }
  })
})
