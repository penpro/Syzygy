import type { ModelFile } from './tauri'

export type LocalAiStartupDecision =
  | { kind: 'disabled' }
  | { kind: 'setup' }
  | { kind: 'start'; filename: string }

const isTextModel = ([name]: ModelFile): boolean =>
  name.toLowerCase().endsWith('.gguf') && !name.toLowerCase().includes('mmproj')

const comparable = (value: string): string => value.toLowerCase().replace(/\.gguf$/, '')

/** Pure startup policy, shared by boot and the header switch so it is headlessly testable. */
export function decideLocalAiStartup(
  enabled: boolean,
  preferredModel: string,
  files: ModelFile[],
): LocalAiStartupDecision {
  if (!enabled) return { kind: 'disabled' }
  const models = files.filter(isTextModel)
  if (models.length === 0) return { kind: 'setup' }

  const preferred = comparable(preferredModel)
  const match = models.find(([name]) => comparable(name) === preferred)
  if (match) return { kind: 'start', filename: match[0] }

  const largest = [...models].sort((a, b) => b[1] - a[1])[0]
  return { kind: 'start', filename: largest[0] }
}
