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
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical'
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ResearchProjectManifest } from './schema'
import { createLocalProviderFactory } from './localProvider'
import { createDriveProviderFactory } from './driveProjectProvider'
import { createWebsocketProviderFactory } from './websocketProjectProvider'
import { registerAutomationEditor } from './editorAutomation'
import { getAutomationEditorController } from './editorAutomationRegistry'
import {
  MOVE_POLICY_BLOCK_COMMAND,
  policyReorderSafety,
  readPolicyMoveAvailability,
  registerPolicyReorderCommands,
} from './editorStructure'
import { $createPolicyBlockNode, PolicyBlockNode } from './nodes/PolicyBlockNode'
import { $createScenarioReferenceNode, ScenarioReferenceNode } from './nodes/ScenarioReferenceNode'
import { $createScenarioSpotlightNode, ScenarioSpotlightNode } from './nodes/ScenarioSpotlightNode'
import { $createSuggestionNode, SuggestionNode } from './nodes/SuggestionNode'
import { ResearchTableOfContents } from './ResearchTableOfContents'
import { ResearchPresence } from './ResearchPresence'
import {
  ConnectedPolicyContentBridgeNotice,
  PolicyContentBridgeProvider,
  usePolicyContentBridgeState,
} from './PolicyContentBridgeProvider'
import { ScenarioReferenceProvider, useScenarioReferenceState } from './ScenarioReferenceContext'
import { SuggestionProvider, useSuggestionState } from './SuggestionContext'
import { suggestionSourceRevision } from './suggestionApplication'

const editorTheme = {
  collaboration: {
    cursor: 'research-collab-cursor',
    cursorName: 'research-collab-cursor-name',
    selection: 'research-collab-selection',
    selectionBg: 'research-collab-selection-bg',
  },
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

function Toolbar({ sharedMode }: { sharedMode: 'drive' | 'websocket' | null }) {
  const shared = sharedMode !== null
  const [editor] = useLexicalComposerContext()
  const policyContentState = usePolicyContentBridgeState()
  const reorderSafety = policyReorderSafety(shared ? 'drive' : 'local', policyContentState
    ? { healthy: policyContentState.healthy, legacyPolicyCount: policyContentState.legacyPolicyIds.length }
    : undefined)
  const { ready: scenariosReady, scenarios } = useScenarioReferenceState()
  const { projectId, ready: suggestionsReady, healthy: suggestionsHealthy, createHumanSuggestion } = useSuggestionState()
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [moveAvailability, setMoveAvailability] = useState({ up: false, down: false })
  const [scenarioId, setScenarioId] = useState('')
  const [suggestionText, setSuggestionText] = useState('')
  const [suggestionError, setSuggestionError] = useState<string | null>(null)

  useEffect(() => {
    if (scenarios.some((scenario) => scenario.id === scenarioId)) return
    setScenarioId(scenarios[0]?.id ?? '')
  }, [scenarioId, scenarios])

  useEffect(() => {
    const removeUndo = editor.registerCommand(CAN_UNDO_COMMAND, (value) => (setCanUndo(value), false), COMMAND_PRIORITY_LOW)
    const removeRedo = editor.registerCommand(CAN_REDO_COMMAND, (value) => (setCanRedo(value), false), COMMAND_PRIORITY_LOW)
    return () => {
      removeUndo()
      removeRedo()
    }
  }, [editor])

  useEffect(() => {
    const update = (editorState = editor.getEditorState()) => setMoveAvailability(
      reorderSafety.allowed ? readPolicyMoveAvailability(editorState) : { up: false, down: false },
    )
    const removeUpdate = editor.registerUpdateListener(({ editorState }) => update(editorState))
    const removeCommands = reorderSafety.allowed ? registerPolicyReorderCommands(editor) : () => {}
    update()
    return () => { removeUpdate(); removeCommands() }
  }, [editor, reorderSafety.allowed])

  const setBlock = (kind: 'paragraph' | 'h1' | 'h2' | 'quote') => {
    editor.update(() => {
      const selection = $getSelection()
      if (!selection) return
      $setBlocksType(selection, () => {
        if (kind === 'paragraph') return $createParagraphNode()
        if (kind === 'quote') return $createQuoteNode()
        return $createHeadingNode(kind)
      })
    })
  }

  return (
    <div className="research-toolbar" role="toolbar" aria-label="Policy formatting">
      <button type="button" onClick={() => setBlock('paragraph')}>Body</button>
      <button type="button" onClick={() => setBlock('h1')}>Heading 1</button>
      <button type="button" onClick={() => setBlock('h2')}>Heading 2</button>
      <button type="button" onClick={() => setBlock('quote')}>Quote</button>
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
      <span className="scenario-reference-control">
        <select
          aria-label="Scenario to reference"
          value={scenarioId}
          disabled={!scenariosReady || scenarios.length === 0}
          onChange={(event) => setScenarioId(event.target.value)}
        >
          {scenarios.length === 0 ? (
            <option value="">{scenariosReady ? 'Create a scenario first' : 'Loading scenarios…'}</option>
          ) : scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>{scenario.title}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!scenarioId}
          onClick={() => {
            editor.update(() => {
              const reference = $createScenarioReferenceNode(scenarioId)
              const selection = $getSelection()
              if ($isRangeSelection(selection)) selection.insertNodes([reference, $createTextNode(' ')])
              else $getRoot().append($createParagraphNode().append(reference))
            })
          }}
        >
          Insert scenario link
        </button>
        <button
          type="button"
          disabled={!scenarioId}
          onClick={() => {
            editor.update(
              () => $getRoot().append($createScenarioSpotlightNode(scenarioId)),
              { tag: 'syzygy-scenario-embed' },
            )
          }}
        >
          Spotlight scenario
        </button>
      </span>
      <span className="suggestion-compose-control">
        <input
          aria-label="Proposed policy text"
          value={suggestionText}
          maxLength={500_000}
          disabled={!suggestionsReady || !suggestionsHealthy}
          placeholder="Propose text without changing the draft"
          onChange={(event) => setSuggestionText(event.target.value)}
        />
        <button
          type="button"
          disabled={!suggestionsReady || !suggestionsHealthy || !suggestionText.trim()}
          onClick={() => {
            setSuggestionError(null)
            try {
              const snapshot = getAutomationEditorController(projectId).read()
              const suggestion = createHumanSuggestion(suggestionText.trim(), suggestionSourceRevision(snapshot.blocks))
              editor.update(
                () => $getRoot().append($createSuggestionNode(suggestion.id)),
                { tag: 'syzygy-suggestion-propose' },
              )
              setSuggestionText('')
            } catch (value) {
              setSuggestionError(value instanceof Error ? value.message : String(value))
            }
          }}
        >
          Add suggestion
        </button>
        {suggestionError ? <span className="suggestion-compose-error" role="alert">{suggestionError}</span> : null}
      </span>
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button type="button" aria-label="Bold" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}><b>B</b></button>
      <button type="button" aria-label="Italic" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}><i>I</i></button>
      <button type="button" aria-label="Underline" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}><u>U</u></button>
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button type="button" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>Undo</button>
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button
        type="button"
        aria-label="Move selected policy block up"
        title={reorderSafety.reason ?? 'Move selected policy block up (Alt+Shift+Up)'}
        disabled={!reorderSafety.allowed || !moveAvailability.up}
        onClick={() => editor.dispatchCommand(MOVE_POLICY_BLOCK_COMMAND, 'up')}
      >Move ↑</button>
      <button
        type="button"
        aria-label="Move selected policy block down"
        title={reorderSafety.reason ?? 'Move selected policy block down (Alt+Shift+Down)'}
        disabled={!reorderSafety.allowed || !moveAvailability.down}
        onClick={() => editor.dispatchCommand(MOVE_POLICY_BLOCK_COMMAND, 'down')}
      >Move ↓</button>
      {!reorderSafety.allowed ? <span className="research-reorder-note">{reorderSafety.reason}</span> : null}
      <span className="research-toolbar-rule" aria-hidden="true" />
      <button type="button" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>Redo</button>
      <span className="research-save-state mono">{
        sharedMode === 'drive'
          ? 'Drive shared · local copy persists'
          : sharedMode === 'websocket'
            ? 'Self-hosted live · local copy persists'
            : 'Local changes persist automatically'
      }</span>
    </div>
  )
}

function AutomationEditorRegistration({ projectId }: { projectId: string }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerAutomationEditor(projectId, editor), [editor, projectId])
  return null
}

export function ResearchEditor({ project }: { project: ResearchProjectManifest }) {
  const researcherId = useStore((state) => state.settings.researcherId)
  const researcherName = useStore((state) => state.settings.researcherName)
  const presenceName = researcherName.trim() || 'Unnamed researcher'
  const awarenessData = useMemo(() => ({
    syzygy: { schemaVersion: 1, participantId: researcherId },
  }), [researcherId])
  const transportKey = project.transport.kind === 'drive'
    ? `drive:${project.transport.workspaceId}`
    : project.transport.kind === 'websocket'
      ? `websocket:${project.transport.endpoint}:${project.transport.roomId}`
      : 'local'
  const providerFactory = useMemo(
    () => project.transport.kind === 'drive'
      ? createDriveProviderFactory(project)
      : project.transport.kind === 'websocket'
        ? createWebsocketProviderFactory(project, project.transport)
        : createLocalProviderFactory(project),
    [project.documentId, project.id, transportKey],
  )
  const initialConfig = useMemo(
    () => ({
      namespace: `syzygy-project-${project.documentId}`,
      nodes: [HeadingNode, QuoteNode, PolicyBlockNode, ScenarioReferenceNode, ScenarioSpotlightNode, SuggestionNode],
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
        <PolicyContentBridgeProvider project={project}>
        <ScenarioReferenceProvider projectId={project.id}>
          <SuggestionProvider projectId={project.id}>
          <AutomationEditorRegistration projectId={project.id} />
          <Toolbar sharedMode={project.transport.kind === 'local' ? null : project.transport.kind} />
          <ResearchPresence
            projectId={project.id}
            documentId={project.documentId}
            participantId={researcherId}
          />
          <ResearchTableOfContents />
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
            username={presenceName}
            awarenessData={awarenessData}
            cursorColor="var(--accent)"
            selectionHighlight
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
          <ConnectedPolicyContentBridgeNotice />
          </div>
          </SuggestionProvider>
        </ScenarioReferenceProvider>
        </PolicyContentBridgeProvider>
      </LexicalComposer>
    </LexicalCollaboration>
  )
}
