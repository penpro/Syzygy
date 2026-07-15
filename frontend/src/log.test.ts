import { afterEach, describe, expect, it } from 'vitest'
import { addLog, clearLog, normalizeStoredLog } from './log'

afterEach(() => {
  clearLog()
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('persistent diagnostic log validation', () => {
  it('keeps safe entries and repairs invalid repeat counts', () => {
    expect(
      normalizeStoredLog([
        { ts: 10, level: 'info', tag: 'drive', message: 'Linked', count: 2 },
        { ts: 11, level: 'error', tag: 'backend', message: 'workspace traversal failed', count: 0 },
      ]),
    ).toEqual([
      { ts: 10, level: 'info', tag: 'drive', message: 'Linked', count: 2 },
      { ts: 11, level: 'error', tag: 'backend', message: 'workspace traversal failed', count: 1 },
    ])
  })

  it('drops malformed persisted values instead of breaking startup', () => {
    expect(normalizeStoredLog('not an array')).toEqual([])
    expect(
      normalizeStoredLog([
        null,
        { ts: 'yesterday', level: 'error', tag: 'drive', message: 'bad timestamp' },
        { ts: 12, level: 'debug', tag: 'drive', message: 'unsupported level' },
      ]),
    ).toEqual([])
  })

  it('retains only the newest 500 entries', () => {
    const stored = Array.from({ length: 510 }, (_, index) => ({
      ts: index,
      level: 'info',
      tag: 'test',
      message: String(index),
      count: 1,
    }))
    const normalized = normalizeStoredLog(stored)
    expect(normalized).toHaveLength(500)
    expect(normalized[0].message).toBe('10')
    expect(normalized[normalized.length - 1]?.message).toBe('509')
  })

  it('writes new diagnostics to local storage and clears them explicitly', () => {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })

    clearLog()
    addLog('info', 'drive', 'Connection restored')
    expect([...values.values()].join('')).toContain('Connection restored')
    clearLog()
    expect(values.size).toBe(0)
  })
})
