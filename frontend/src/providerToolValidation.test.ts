import { describe, expect, it } from 'vitest'
import type { ProviderToolDefinition } from './tauri'
import { assertSafeProviderToolSchema, validateProviderToolProposal } from './providerToolValidation'

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

describe('provider tool proposal validation', () => {
  it('distinguishes schema validity from domain review and execution authority', () => {
    expect(validateProviderToolProposal(definitions, {
      name: 'lookup_source',
      arguments: { query: 'budget evidence', limit: 5 },
    })).toEqual({
      schemaStatus: 'valid',
      domainStatus: 'unreviewed',
      executable: false,
      errors: [],
    })

    const invalid = validateProviderToolProposal(definitions, {
      name: 'lookup_source',
      arguments: { query: 42, ambientPath: 'C:\\private' },
    })
    expect(invalid.schemaStatus).toBe('invalid')
    expect(invalid.domainStatus).toBe('unreviewed')
    expect(invalid.executable).toBe(false)
    expect(invalid.errors.length).toBeGreaterThan(0)

    expect(validateProviderToolProposal(definitions, {
      name: 'ambient_shell',
      arguments: { command: 'whoami' },
    })).toEqual({
      schemaStatus: 'missing-definition',
      domainStatus: 'unreviewed',
      executable: false,
      errors: ['$:definition-missing'],
    })
  })

  it('rejects unbounded or executable schema features before provider transmission', () => {
    expect(() => assertSafeProviderToolSchema({
      type: 'object',
      properties: { query: { type: 'string', pattern: '(a+)+$' } },
    }, 'hostile_pattern')).toThrow('unsupported keyword pattern')
    expect(() => assertSafeProviderToolSchema({
      type: 'object',
      properties: { query: { $ref: 'https://attacker.invalid/schema' } },
    }, 'remote_ref')).toThrow('unsupported keyword $ref')
    expect(() => assertSafeProviderToolSchema({
      type: 'object',
      properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    }, 'branch_bomb')).toThrow('unsupported keyword oneOf')
  })
})
