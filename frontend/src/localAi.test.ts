import { describe, expect, it } from 'vitest'
import { decideLocalAiStartup } from './localAi'
import type { ModelFile } from './tauri'

const files: ModelFile[] = [
  ['small.gguf', 2_000, false],
  ['large.gguf', 8_000, false],
  ['large-mmproj.gguf', 10_000, false],
]

describe('local AI startup policy', () => {
  it('does not select or load a model when local AI is disabled', () => {
    expect(decideLocalAiStartup(false, 'large.gguf', files)).toEqual({ kind: 'disabled' })
  })

  it('requests setup only when local AI is enabled without a downloaded text model', () => {
    expect(decideLocalAiStartup(true, 'missing', [['vision-mmproj.gguf', 10_000, false]])).toEqual({ kind: 'setup' })
  })

  it('selects the saved model and tolerates a saved id without the GGUF suffix', () => {
    expect(decideLocalAiStartup(true, 'small', files)).toEqual({ kind: 'start', filename: 'small.gguf' })
  })

  it('falls back to the largest text model, never a projector', () => {
    expect(decideLocalAiStartup(true, 'missing', files)).toEqual({ kind: 'start', filename: 'large.gguf' })
  })
})
