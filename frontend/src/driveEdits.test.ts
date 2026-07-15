import { describe, expect, it } from 'vitest'
import { buildDriveSheetPlanPrompt, parseDriveSheetPlan } from './driveEdits'
import type { DriveContextReport, DriveEditableFile } from './tauri'

const targets: DriveEditableFile[] = [
  { id: 'sheet-1', path: 'research/Shared results', kind: 'spreadsheet' },
]

describe('Drive Sheet edit proposals', () => {
  it('keeps file ids out of the local-model planning prompt', () => {
    const report: DriveContextReport = {
      context: '[research/Shared results]\nsecond secret word is narwhal',
      workspace: { id: 'folder-1', name: 'Research' },
      visibleFiles: 1,
      supportedFiles: 1,
      nativeFiles: 1,
      sources: ['research/Shared results'],
      editableFiles: targets,
    }
    const prompt = buildDriveSheetPlanPrompt('write the grid there', 'prior grid', report)
    expect(prompt).toContain('0: research/Shared results')
    expect(prompt).toContain('second secret word is narwhal')
    expect(prompt).not.toContain('sheet-1')
  })

  it('accepts a bounded rectangular proposal and binds its validated target', () => {
    const plan = parseDriveSheetPlan(
      '{"targetIndex":0,"startCell":"a1","values":[[1,2],[3,4]],"summary":"Write grid","clarify":""}',
      targets,
    )
    expect(plan).toEqual({
      kind: 'proposal',
      proposal: {
        target: targets[0],
        startCell: 'A1',
        values: [['1', '2'], ['3', '4']],
        summary: 'Write grid',
      },
    })
  })

  it('fails closed on formulas, ragged rows, unknown targets, and malformed output', () => {
    expect(parseDriveSheetPlan('{"targetIndex":0,"startCell":"A1","values":[["=IMPORTXML(1)"]]}', targets)).toBeNull()
    expect(parseDriveSheetPlan('{"targetIndex":0,"startCell":"A1","values":[[1,2],[3]]}', targets)).toBeNull()
    expect(parseDriveSheetPlan('{"targetIndex":4,"startCell":"A1","values":[[1]]}', targets)).toBeNull()
    expect(parseDriveSheetPlan('I changed the sheet', targets)).toBeNull()
  })

  it('returns a clarification without authorizing a write', () => {
    expect(parseDriveSheetPlan('{"values":[],"clarify":"Which spreadsheet?"}', targets)).toEqual({
      kind: 'clarify',
      question: 'Which spreadsheet?',
    })
  })
})
