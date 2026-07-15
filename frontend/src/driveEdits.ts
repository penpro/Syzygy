import { extractJSON } from './json'
import type { DriveContextReport, DriveEditableFile } from './tauri'

export interface DriveSheetProposal {
  target: DriveEditableFile
  startCell: string
  values: string[][]
  summary: string
}

export type DriveSheetPlan =
  | { kind: 'proposal'; proposal: DriveSheetProposal }
  | { kind: 'clarify'; question: string }

/** Ask the local model for data, never authority. The selected file id is resolved only after the
 * model's index and rectangular values pass deterministic validation. */
export function buildDriveSheetPlanPrompt(
  request: string,
  transcript: string,
  report: DriveContextReport,
): string {
  const targets = report.editableFiles.map((file, index) => `${index}: ${file.path}`).join('\n')
  return [
    'You prepare a PROPOSAL for a Google Sheets edit. You do not perform the edit and must not claim success.',
    'Return ONLY one JSON object, with no prose or code fence:',
    '{"targetIndex":0,"startCell":"A1","values":[["cell"]],"summary":"short description","clarify":""}',
    '',
    'Rules:',
    '- Choose targetIndex only from the numbered spreadsheet list below.',
    '- Use the evidence and conversation to resolve references such as “the sheet with the second word”.',
    '- startCell must be one cell such as A1 or C4. Use A1 when the user does not specify a location.',
    '- values must be a rectangular array with 1–200 rows, 1–50 columns, at most 10,000 cells.',
    '- Every cell must be a string. Preserve leading zeros. Do not emit formulas; values are written literally.',
    '- Include exactly the content requested. If essential content or the target cannot be determined, set values to [] and put one short question in clarify.',
    '',
    'Editable spreadsheets:',
    targets || '(none)',
    '',
    'Relevant Drive evidence (read-only):',
    report.context.slice(0, 8_000) || '(no matching passages)',
    '',
    'Recent conversation:',
    transcript.slice(-8_000) || '(none)',
    '',
    `Current request: ${request}`,
    'JSON:',
  ].join('\n')
}

const START_CELL_RE = /^[A-Z]{1,3}[1-9]\d{0,6}$/

export function parseDriveSheetPlan(raw: string, targets: DriveEditableFile[]): DriveSheetPlan | null {
  const obj = extractJSON(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  const clarify = typeof rec.clarify === 'string' ? rec.clarify.trim() : ''
  if (clarify) return { kind: 'clarify', question: clarify.slice(0, 240) }

  const targetIndex = Number(rec.targetIndex)
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= targets.length) return null
  const startCell = typeof rec.startCell === 'string' ? rec.startCell.trim().toUpperCase() : 'A1'
  if (!START_CELL_RE.test(startCell)) return null
  if (!Array.isArray(rec.values) || rec.values.length === 0 || rec.values.length > 200) return null

  const values: string[][] = []
  let columns = 0
  let characters = 0
  for (const rawRow of rec.values) {
    if (!Array.isArray(rawRow) || rawRow.length === 0 || rawRow.length > 50) return null
    if (!columns) columns = rawRow.length
    if (rawRow.length !== columns) return null
    const row: string[] = []
    for (const cell of rawRow) {
      if (typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean') return null
      const value = String(cell)
      if (value.startsWith('=')) return null
      characters += value.length
      row.push(value)
    }
    values.push(row)
  }
  if (values.length * columns > 10_000 || characters > 100_000) return null
  const summary = typeof rec.summary === 'string' && rec.summary.trim()
    ? rec.summary.trim().slice(0, 240)
    : `Write ${values.length} × ${columns} cells`
  return {
    kind: 'proposal',
    proposal: { target: targets[targetIndex], startCell, values, summary },
  }
}
