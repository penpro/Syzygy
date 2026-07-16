import type { PolicyBlockStatus } from './nodes/PolicyBlockNode'

export type AutomationBlockKind = 'heading1' | 'heading2' | 'quote' | 'paragraph' | 'policy'

export interface AutomationDocumentBlock {
  kind: AutomationBlockKind
  text: string
  policyId?: string
  status?: PolicyBlockStatus
}

export interface AutomationEditorSnapshot {
  projectId: string
  revision: string
  text: string
  blocks: AutomationDocumentBlock[]
}

export interface AutomationEditorController {
  projectId: string
  read: () => AutomationEditorSnapshot
  replace: (expectedRevision: string, content: string) => AutomationEditorSnapshot
  replaceBlocks: (expectedRevision: string, blocks: AutomationDocumentBlock[]) => AutomationEditorSnapshot
  append: (expectedRevision: string, content: string) => AutomationEditorSnapshot
}

let activeController: AutomationEditorController | null = null

export function registerAutomationEditorController(controller: AutomationEditorController): () => void {
  activeController = controller
  return () => {
    if (activeController === controller) activeController = null
  }
}

export function automationEditorReady(projectId?: string): boolean {
  return !!activeController && (!projectId || activeController.projectId === projectId)
}

export function getAutomationEditorController(projectId?: string): AutomationEditorController {
  if (!activeController) throw new Error('The live research editor is not ready; open a project and retry')
  if (projectId && activeController.projectId !== projectId) {
    throw new Error(`Project ${projectId} is not the active live editor`)
  }
  return activeController
}
