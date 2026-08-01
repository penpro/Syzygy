import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  getPolicyContentIndex,
  getPolicyContentText,
  initializePolicyContent,
  MAX_POLICY_CONTENT_CODE_UNITS,
  normalizePolicyContentDelta,
  policyContentFingerprint,
  policyContentTypeName,
  readPolicyContent,
  readPolicyContentStatus,
  updatePolicyContent,
  updatePolicyContentStatus,
} from './policyContentModel'

const base = [
  { insert: 'Policy ', attributes: { format: 1 } },
  { insert: 'baseline' },
  { insert: { schemaVersion: 1, kind: 'lexical-node', node: { type: 'linebreak', version: 1 } } },
] as const

function exchange(left: Y.Doc, right: Y.Doc): void {
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right), 'test-exchange')
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left), 'test-exchange')
}

describe('stable policy content model', () => {
  it('uses a deterministic root shared type and initializes idempotently', () => {
    const doc = new Y.Doc({ guid: 'policy-content' })
    expect(policyContentTypeName('policy-a')).toBe('project:policy-content:v1:policy-a')
    expect(initializePolicyContent(doc, 'policy-a', base)).toEqual(base)
    expect(initializePolicyContent(doc, 'policy-a', base)).toEqual(base)
    expect(readPolicyContent(doc, 'policy-a')).toEqual(base)
    expect(readPolicyContentStatus(doc, 'policy-a')).toBe('draft')
    expect(getPolicyContentIndex(doc).get('policy-a')).toBe(1)
    expect(getPolicyContentText(doc, 'policy-a').length).toBe(16)
    expect(() => initializePolicyContent(doc, 'policy-a', [{ insert: 'different' }])).toThrow('already initialized differently')
  })

  it('preserves disconnected character edits and formatting changes in one stable identity', () => {
    const left = new Y.Doc({ guid: 'stable-policy' })
    initializePolicyContent(left, 'policy-a', [{ insert: 'alpha beta gamma' }])
    const right = new Y.Doc({ guid: 'stable-policy' })
    exchange(left, right)

    updatePolicyContent(left, 'policy-a', [
      { insert: 'ALPHA', attributes: { format: 1, style: 'color: var(--accent)' } },
      { insert: ' beta gamma' },
    ], 'left-format')
    updatePolicyContent(right, 'policy-a', [{ insert: 'alpha beta gamma!' }], 'right-edit')
    exchange(left, right)

    expect(readPolicyContent(left, 'policy-a')).toEqual(readPolicyContent(right, 'policy-a'))
    expect(getPolicyContentText(left, 'policy-a').toString()).toBe('ALPHA beta gamma!')
    expect(readPolicyContent(left, 'policy-a')?.[0]).toEqual({
      insert: 'ALPHA',
      attributes: { format: 1, style: 'color: var(--accent)' },
    })
  })

  it('keeps content unchanged when a separate placement CRDT moves the policy ID', () => {
    const left = new Y.Doc({ guid: 'stable-placement' })
    const leftOrder = left.getArray<string>('project:policy-placement:v1')
    leftOrder.push(['policy-a', 'policy-b'])
    initializePolicyContent(left, 'policy-a', [{ insert: 'keep this edit' }], { status: 'review' })
    initializePolicyContent(left, 'policy-b', [{ insert: 'other policy' }])
    const right = new Y.Doc({ guid: 'stable-placement' })
    exchange(left, right)

    leftOrder.delete(0, 1)
    leftOrder.insert(1, ['policy-a'])
    updatePolicyContentStatus(left, 'policy-a', 'approved')
    updatePolicyContent(right, 'policy-a', [{ insert: 'keep this concurrent edit' }])
    exchange(left, right)

    expect(left.getArray<string>('project:policy-placement:v1').toArray()).toEqual(['policy-b', 'policy-a'])
    expect(getPolicyContentText(left, 'policy-a').toString()).toBe('keep this concurrent edit')
    expect(readPolicyContentStatus(left, 'policy-a')).toBe('approved')
    expect(readPolicyContentStatus(right, 'policy-a')).toBe('approved')
    expect(readPolicyContent(left, 'policy-a')).toEqual(readPolicyContent(right, 'policy-a'))
  })

  it('fails closed on malformed identity, schema, attributes, embeds, and size', () => {
    const doc = new Y.Doc()
    expect(() => policyContentTypeName('../escape')).toThrow('stable policyId')
    expect(() => normalizePolicyContentDelta([{ insert: 'x', attributes: { unknown: true } }])).toThrow('attributes')
    expect(() => normalizePolicyContentDelta([{ insert: { schemaVersion: 1, kind: 'wrong', node: {} } }])).toThrow('embed')
    expect(() => normalizePolicyContentDelta([{ insert: 'x'.repeat(MAX_POLICY_CONTENT_CODE_UNITS + 1) }])).toThrow('size')
    getPolicyContentIndex(doc).set('policy-a', 99)
    expect(() => readPolicyContent(doc, 'policy-a')).toThrow('unsupported')
  })

  it('normalizes default attributes and produces deterministic fingerprints', () => {
    expect(normalizePolicyContentDelta([{ insert: 'text', attributes: { format: 0, detail: 0, mode: 'normal', style: '' } }]))
      .toEqual([{ insert: 'text' }])
    expect(policyContentFingerprint([{ insert: 'text' }])).toBe(policyContentFingerprint([{ insert: 'text', attributes: {} }]))
  })
})
