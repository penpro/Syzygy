import { describe, expect, it } from 'vitest'
import { buildDriveSystemPrompt } from './driveContext'
import type { DriveContextReport } from './tauri'

const report = (context: string): DriveContextReport => ({
  context,
  workspace: { id: 'folder-1', name: 'Research workspace' },
  visibleFiles: 4,
  supportedFiles: 4,
  nativeFiles: 1,
  sources: ['test file for syzygy'],
  editableFiles: [],
})

describe('buildDriveSystemPrompt', () => {
  it('puts exported Google Doc evidence and its file label in the model system message', () => {
    const prompt = buildDriveSystemPrompt(
      'Answer directly.',
      report('[test file for syzygy]\nThe secret word is hippo\n'),
    )
    expect(prompt).toContain('[test file for syzygy]')
    expect(prompt).toContain('The secret word is hippo')
    expect(prompt).toContain('Never ask for a public link')
    expect(prompt).toContain('never claim a Drive write succeeded')
  })

  it('records a successful folder check even when no passage matches', () => {
    const prompt = buildDriveSystemPrompt('Answer directly.', report(''))
    expect(prompt).toContain('4 files were visible')
    expect(prompt).toContain('no passages matched')
    expect(prompt).toContain('Never claim a Drive write succeeded')
  })

  it('refuses to send a silently empty workspace to the model', () => {
    const empty = { ...report(''), visibleFiles: 0, supportedFiles: 0 }
    expect(() => buildDriveSystemPrompt('Answer directly.', empty)).toThrow('contains no visible files')
  })
})
