import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $setBlocksType } from '@lexical/selection'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from 'lexical'
import { $createHeadingNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { useEffect, useMemo, useState } from 'react'
import type { ResearchProjectManifest } from './schema'
import { createLocalProviderFactory } from './localProvider'
import { registerAutomationEditor } from './editorAutomation'
import { $createPolicyBlockNode, PolicyBlockNode } from './nodes/PolicyBlockNode'

const editorTheme = {
  heading: {
    h1: 'research-editor-h1',
    h2: 'research-editor-h2',
  },
  paragraph: 'research-editor-paragraph',
  quote: 'research-editor-quote',
  text: {
    bold: 'research-editor-bold',
    italic: 'research-editor-italic',
    underline: 'research-editor-underline',
  },
}

function Toolbar() {
  const [editor] = useLexicalComposerContext()
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    const removeUndo = editor.registerCommand(CAN_UNDO_COMMAND, (value) => (setCanUndo(value), false), COMMAND_PRIORITY_LOW)
    const removeRedo = editor.registerCommand(CAN_REDO_COMMAND, (value) => (setCanRedo(value), false), COMMAND_PRIORITY_LOW)
    const removeSelection = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => false, COMMAND_PRIORITY_LOW)
    return () => {
      removeUndo()
      removeRedo()
      removeSelection()
    }
  }, [editor])

  const setBlock = (kind: 'paragraph' | 'h1' | 'h2') => {
    editor.update(() => {
      const selection = $getSelection()
      if (!selection) return
      $setBlocksType(selection, () => (kind === 'paragraph' ? $createParagraphNode() : $createHeadingNode(kind)))
    })
  }

  return (
    <div className="research-toolbar" role="toolbar" aria-label="Policy formatting">
      <button type="button" onClick={() => setBlock('paragraph')}>Body</button>
      <button type="button" onClick={() => setBlock('h1')}>Heading 1</button>
      <button type="button" onClick={() => setBlock('h2')}>Heading 2</button>
      <button
        type="button"
        onClick={() => {
          const policyId = `policy-${crypto.randomUUID()}`
          editor.update(() => {
            $getRoot().append($createPolicyBlockNode(policyId).append($createTextNode('New policy statement')))
          })
        }}
      >
        Policy block
      </button>
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button type="button" aria-label="Bold" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}><b>B</b></button>
      <button type="button" aria-label="Italic" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}><i>I</i></button>
      <button type="button" aria-label="Underline" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}><u>U</u></button>
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button type="button" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>Undo</button>
      <button type="button" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>Redo</button>
      <span className="research-save-state mono">Local changes persist automatically</span>
    </div>
  )
}

function AutomationEditorRegistration({ projectId }: { projectId: string }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerAutomationEditor(projectId, editor), [editor, projectId])
  return null
}

export function ResearchEditor({ project }: { project: ResearchProjectManifest }) {
  const providerFactory = useMemo(() => createLocalProviderFactory(project), [project.documentId])
  const initialConfig = useMemo(
    () => ({
      namespace: `syzygy-project-${project.documentId}`,
      nodes: [HeadingNode, QuoteNode, PolicyBlockNode],
      editorState: null,
      theme: editorTheme,
      onError(error: Error) {
        throw error
      },
    }),
    [project.documentId],
  )

  return (
    <LexicalCollaboration>
      <LexicalComposer initialConfig={initialConfig}>
        <AutomationEditorRegistration projectId={project.id} />
        <Toolbar />
        <div className="research-paper">
          <RichTextPlugin
            contentEditable={<ContentEditable className="research-editor" aria-label="Collaborative policy document" />}
            placeholder={<div className="research-editor-placeholder">Write the first policy statement…</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <CollaborationPlugin
            id={project.documentId}
            providerFactory={providerFactory}
            shouldBootstrap
            username="Local researcher"
            cursorColor="var(--accent)"
            initialEditorState={() => {
              const root = $getRoot()
              root.append(
                $createHeadingNode('h1').append($createTextNode(project.title)),
                $createParagraphNode().append(
                  $createTextNode('Start with the behavior the model should follow. This draft is stored locally and structured for collaboration.'),
                ),
              )
            }}
          />
        </div>
      </LexicalComposer>
    </LexicalCollaboration>
  )
}
