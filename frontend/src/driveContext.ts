import type { DriveContextReport } from './tauri'

/** Build the exact system message used for a Shared-folder Ask turn. Keeping this pure makes the
 * final Drive-to-model boundary testable without a webview or a real model process. */
export function buildDriveSystemPrompt(basePrompt: string, report: DriveContextReport): string {
  if (report.visibleFiles === 0) {
    throw new Error(`The selected Drive workspace “${report.workspace.name}” contains no visible files.`)
  }
  if (report.context.trim()) {
    return `${basePrompt}\n\n# Reference material read directly from the shared Google Drive workspace “${report.workspace.name}”\nUse it to answer accurately and cite file names when relevant; if it doesn't cover the question, say so. Never ask for a public link when this material is present.\n\n${report.context}`
  }
  return `${basePrompt}\n\n# Shared Google Drive check\nSyzygy successfully checked “${report.workspace.name}”: ${report.visibleFiles} files were visible and ${report.supportedFiles} were readable, but no passages matched this question. Say that the connected workspace did not contain matching evidence; do not ask the user to paste a public link.`
}
