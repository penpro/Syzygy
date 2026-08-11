import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import schemaText from '../../../docs/schemas/syzygy-scenario-pack-v1.schema.json?raw'
import schemaV2Text from '../../../docs/schemas/syzygy-scenario-pack-v2.schema.json?raw'
import sampleText from '../../../docs/samples/source-review.syzygy-scenarios.json?raw'
import { createScenarioPack, decodeScenarioPack } from './scenarioPack'

const schema = JSON.parse(schemaText)

describe('public scenario pack schema and sample', () => {
  it('validates the committed sample structurally and semantically', async () => {
    const validate = new Ajv2020({ strict: true }).compile(schema)
    const parsed = JSON.parse(sampleText)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    const decoded = await decodeScenarioPack(sampleText)
    expect(decoded).toMatchObject({ packId: 'sample-source-review-v1', license: 'CC0-1.0' })
    expect(decoded.scenarios[0].schemaVersion).toBe(2)
    expect(decoded.scenarios[0].turns[0].revisions).toHaveLength(2)
    expect(decoded.scenarios[0].turns[0]).toMatchObject({
      headEditId: 'refine-independence-question', tipEditIds: ['refine-independence-question'],
    })
    expect(decoded.scenarios[0].turns[0].revisions[1]).toMatchObject({
      parentEditIds: ['create-independence-question'], source: 'migration-v1',
    })
  })

  it('emits a closed v2 pack with durable heads and revision parents', async () => {
    const legacy = await decodeScenarioPack(sampleText)
    const text = await createScenarioPack({
      packId: 'sample-source-review-v2', title: legacy.title, description: legacy.description,
      license: legacy.license, source: legacy.source, scenarios: legacy.scenarios,
    })
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(schemaV2Text))
    const parsed = JSON.parse(text)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.scenarios[0].turns[0]).toMatchObject({
      headEditId: 'refine-independence-question', tipEditIds: ['refine-independence-question'],
    })
    await expect(decodeScenarioPack(text)).resolves.toMatchObject({ schemaVersion: 2 })
  })

  it('keeps every object boundary closed to undeclared authority', () => {
    const validate = new Ajv2020({ strict: true }).compile(schema)
    const injected = JSON.parse(sampleText)
    injected.scenarios[0].turns[0].network = { url: 'https://example.invalid' }
    expect(validate(injected)).toBe(false)
    expect(validate.errors?.some((error) => error.keyword === 'additionalProperties')).toBe(true)
  })
})
