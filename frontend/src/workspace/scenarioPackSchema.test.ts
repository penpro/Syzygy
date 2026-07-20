import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import schemaText from '../../../docs/schemas/syzygy-scenario-pack-v1.schema.json?raw'
import sampleText from '../../../docs/samples/source-review.syzygy-scenarios.json?raw'
import { decodeScenarioPack } from './scenarioPack'

const schema = JSON.parse(schemaText)

describe('public scenario pack schema and sample', () => {
  it('validates the committed sample structurally and semantically', async () => {
    const validate = new Ajv2020({ strict: true }).compile(schema)
    const parsed = JSON.parse(sampleText)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    const decoded = await decodeScenarioPack(sampleText)
    expect(decoded).toMatchObject({ packId: 'sample-source-review-v1', license: 'CC0-1.0' })
    expect(decoded.scenarios[0].turns[0].revisions).toHaveLength(2)
  })

  it('keeps every object boundary closed to undeclared authority', () => {
    const validate = new Ajv2020({ strict: true }).compile(schema)
    const injected = JSON.parse(sampleText)
    injected.scenarios[0].turns[0].network = { url: 'https://example.invalid' }
    expect(validate(injected)).toBe(false)
    expect(validate.errors?.some((error) => error.keyword === 'additionalProperties')).toBe(true)
  })
})
