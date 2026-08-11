import Ajv2020 from 'ajv/dist/2020'
import type { ProviderToolDefinition, ProviderToolProposalValidation } from './tauri'

const MAX_SCHEMA_DEPTH = 12
const MAX_SCHEMA_NODES = 2_048
const MAX_SCHEMA_PROPERTIES = 128
const MAX_SCHEMA_ERRORS = 8
const MAX_SCHEMA_BOUND = 1_000_000

const SAFE_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minProperties',
  'maxProperties',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'enum',
  'const',
  'title',
  'description',
  'default',
  'examples',
])

const SAFE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

type ToolProposalLike = {
  name: string
  arguments: Record<string, unknown> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeIntegerBound(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_SCHEMA_BOUND
}

function safeNumberBound(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function inspectSafeSchema(schema: unknown, path: string, depth: number, state: { nodes: number }): void {
  if (!isRecord(schema)) throw new Error(`${path} must be an object`)
  if (depth > MAX_SCHEMA_DEPTH || state.nodes >= MAX_SCHEMA_NODES) {
    throw new Error(`${path} exceeds the safe schema complexity bound`)
  }
  state.nodes += 1
  for (const keyword of Object.keys(schema)) {
    if (!SAFE_SCHEMA_KEYWORDS.has(keyword)) throw new Error(`${path} uses unsupported keyword ${keyword}`)
  }
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !SAFE_TYPES.has(schema.type))) {
    throw new Error(`${path} has an unsupported type`)
  }
  for (const keyword of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[keyword] !== undefined && !safeIntegerBound(schema[keyword])) {
      throw new Error(`${path}.${keyword} must be an integer from 0 to ${MAX_SCHEMA_BOUND}`)
    }
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[keyword] !== undefined && !safeNumberBound(schema[keyword])) {
      throw new Error(`${path}.${keyword} must be a finite number`)
    }
  }
  for (const [minimum, maximum] of [
    ['minProperties', 'maxProperties'],
    ['minItems', 'maxItems'],
    ['minLength', 'maxLength'],
    ['minimum', 'maximum'],
  ]) {
    if (schema[minimum] !== undefined && schema[maximum] !== undefined && Number(schema[minimum]) > Number(schema[maximum])) {
      throw new Error(`${path}.${minimum} cannot exceed ${maximum}`)
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties must be true or false`)
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)) {
    throw new Error(`${path}.enum must contain 1â€“256 values`)
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) throw new Error(`${path}.examples must be an array`)
  if (schema.title !== undefined && typeof schema.title !== 'string') throw new Error(`${path}.title must be a string`)
  if (schema.description !== undefined && typeof schema.description !== 'string') throw new Error(`${path}.description must be a string`)

  let properties: Record<string, unknown> | null = null
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties) || Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES) {
      throw new Error(`${path}.properties must contain at most ${MAX_SCHEMA_PROPERTIES} schemas`)
    }
    properties = schema.properties
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!name || [...name].length > 128 || [...name].some((character) => character < ' ')) {
        throw new Error(`${path}.properties contains an invalid name`)
      }
      inspectSafeSchema(propertySchema, `${path}.properties.${name}`, depth + 1, state)
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length > MAX_SCHEMA_PROPERTIES) {
      throw new Error(`${path}.required must contain at most ${MAX_SCHEMA_PROPERTIES} names`)
    }
    const seen = new Set<string>()
    for (const required of schema.required) {
      if (typeof required !== 'string' || !required || seen.has(required) || !properties?.[required]) {
        throw new Error(`${path}.required must contain unique declared property names`)
      }
      seen.add(required)
    }
  }
  if (schema.items !== undefined) inspectSafeSchema(schema.items, `${path}.items`, depth + 1, state)
}

export function assertSafeProviderToolSchema(schema: Record<string, unknown>, toolName: string): void {
  inspectSafeSchema(schema, `Tool ${toolName} schema`, 0, { nodes: 0 })
  try {
    const ajv = new Ajv2020({
      allErrors: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
      validateFormats: false,
      strictSchema: true,
      strictTypes: false,
    })
    ajv.compile(schema)
  } catch (error) {
    throw new Error(`Tool ${toolName} schema is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function boundedValidationErrors(errors: Array<{ instancePath?: string; keyword?: string }> | null | undefined): string[] {
  return (errors ?? []).slice(0, MAX_SCHEMA_ERRORS).map((error) => {
    const path = (error.instancePath || '$').slice(0, 256)
    const keyword = (error.keyword || 'invalid').slice(0, 64)
    return `${path}:${keyword}`
  })
}

export function validateProviderToolProposal(
  definitions: ProviderToolDefinition[],
  proposal: ToolProposalLike,
): ProviderToolProposalValidation {
  if (proposal.arguments === null) {
    return { schemaStatus: 'pending', domainStatus: 'unreviewed', executable: false, errors: [] }
  }
  const definition = definitions.find(({ name }) => name === proposal.name)
  if (!definition) {
    return {
      schemaStatus: 'missing-definition',
      domainStatus: 'unreviewed',
      executable: false,
      errors: ['$:definition-missing'],
    }
  }
  try {
    assertSafeProviderToolSchema(definition.parameters, definition.name)
    const ajv = new Ajv2020({
      allErrors: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
      validateFormats: false,
      strictSchema: true,
      strictTypes: false,
    })
    const validate = ajv.compile(definition.parameters)
    const valid = validate(proposal.arguments)
    return {
      schemaStatus: valid ? 'valid' : 'invalid',
      domainStatus: 'unreviewed',
      executable: false,
      errors: valid ? [] : boundedValidationErrors(validate.errors),
    }
  } catch {
    return {
      schemaStatus: 'invalid',
      domainStatus: 'unreviewed',
      executable: false,
      errors: ['$:schema-unsupported'],
    }
  }
}
