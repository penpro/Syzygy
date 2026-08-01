import {
  $getRoot,
  COLLABORATION_TAG,
  SKIP_COLLAB_TAG,
  type LexicalEditor,
} from 'lexical'
import type * as Y from 'yjs'
import { migrateLocalPolicyContentDocument } from '../migrations'
import { $isPolicyBlockNode } from './nodes/PolicyBlockNode'
import { readPolicyBlockContent, replacePolicyBlockContent } from './policyContentLexical'
import {
  initializePolicyContent,
  policyContentFingerprint,
  readPolicyContent,
  readPolicyContentStatus,
  updatePolicyContent,
  updatePolicyContentStatus,
  type PolicyContentDelta,
  type StablePolicyStatus,
} from './policyContentModel'

export const POLICY_CONTENT_PROJECTION_TAG = 'syzygy-policy-content-projection'
export const MAX_POLICY_BLOCKS_PER_DOCUMENT = 10_000

export interface PolicyContentBridgeState {
  healthy: boolean
  error: string | null
  stablePolicyCount: number
  legacyPolicyIds: string[]
}

export interface PolicyContentBridgeOptions {
  bootstrapExisting: boolean
  onState?: (state: PolicyContentBridgeState) => void
}

interface EditorPolicyRecord {
  policyId: string
  status: StablePolicyStatus
  delta: PolicyContentDelta
}

function editorPolicyRecords(editor: LexicalEditor): EditorPolicyRecord[] {
  return editor.getEditorState().read(() => {
    const nodes = $getRoot().getChildren().filter($isPolicyBlockNode)
    if (nodes.length > MAX_POLICY_BLOCKS_PER_DOCUMENT) throw new Error('Policy block count exceeds the safety limit')
    const seen = new Set<string>()
    return nodes.map((node) => {
      const policyId = node.getPolicyId()
      if (seen.has(policyId)) throw new Error('Policy document contains a duplicate policyId')
      seen.add(policyId)
      return { policyId, status: node.getStatus(), delta: readPolicyBlockContent(node) }
    })
  })
}

export function registerPolicyContentBridge(
  editor: LexicalEditor,
  doc: Y.Doc,
  options: PolicyContentBridgeOptions,
): () => void {
  const origin = { kind: 'syzygy-policy-content-bridge', editor }
  const initial = editorPolicyRecords(editor)
  const initialIds = new Set(initial.map(({ policyId }) => policyId))
  let active = true
  let failed = false
  let projectionQueued = false

  if (options.bootstrapExisting) {
    migrateLocalPolicyContentDocument(doc, initial.map(({ policyId, status, delta }) => ({ policyId, status, delta })))
  }

  const state = (error: string | null = null): PolicyContentBridgeState => {
    const records = editorPolicyRecords(editor)
    const legacyPolicyIds = records.filter(({ policyId }) => readPolicyContent(doc, policyId) === null).map(({ policyId }) => policyId)
    return {
      healthy: error === null,
      error,
      stablePolicyCount: records.length - legacyPolicyIds.length,
      legacyPolicyIds,
    }
  }

  const emitState = (error: string | null = null) => options.onState?.(state(error))

  const fail = (value: unknown) => {
    failed = true
    const message = value instanceof Error ? value.message : String(value)
    try { emitState(message) } catch { options.onState?.({ healthy: false, error: message, stablePolicyCount: 0, legacyPolicyIds: [] }) }
  }

  const projectStableContent = () => {
    if (!active || failed) return
    try {
      const stable = new Map<string, { delta: PolicyContentDelta; status: StablePolicyStatus }>()
      for (const { policyId } of editorPolicyRecords(editor)) {
        const delta = readPolicyContent(doc, policyId)
        const status = readPolicyContentStatus(doc, policyId)
        if (delta && status) stable.set(policyId, { delta, status })
      }
      editor.update(() => {
        const nodes = $getRoot().getChildren().filter($isPolicyBlockNode)
        for (const node of nodes) {
          const record = stable.get(node.getPolicyId())
          if (!record) continue
          if (policyContentFingerprint(readPolicyBlockContent(node)) !== policyContentFingerprint(record.delta) ||
            node.getStatus() !== record.status) {
            replacePolicyBlockContent(node, record.delta, record.status)
          }
        }
      }, { discrete: true, tag: [POLICY_CONTENT_PROJECTION_TAG, SKIP_COLLAB_TAG] })
      emitState()
    } catch (error) {
      fail(error)
    }
  }

  const scheduleProjection = () => {
    if (!active || failed || projectionQueued) return
    projectionQueued = true
    queueMicrotask(() => {
      projectionQueued = false
      projectStableContent()
    })
  }

  const syncLocalContent = () => {
    if (!active || failed) return
    try {
      for (const record of editorPolicyRecords(editor)) {
        const current = readPolicyContent(doc, record.policyId)
        if (!current) {
          if (options.bootstrapExisting || !initialIds.has(record.policyId)) {
            initializePolicyContent(doc, record.policyId, record.delta, { status: record.status, origin })
          }
          continue
        }
        if (policyContentFingerprint(current) !== policyContentFingerprint(record.delta)) {
          updatePolicyContent(doc, record.policyId, record.delta, origin)
        }
        if (readPolicyContentStatus(doc, record.policyId) !== record.status) {
          updatePolicyContentStatus(doc, record.policyId, record.status, origin)
        }
      }
      emitState()
    } catch (error) {
      fail(error)
    }
  }

  const removeEditorUpdate = editor.registerUpdateListener(({ tags }) => {
    if (tags.has(POLICY_CONTENT_PROJECTION_TAG)) return
    if (tags.has(COLLABORATION_TAG)) scheduleProjection()
    else syncLocalContent()
  })
  const onDocumentTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== origin) scheduleProjection()
  }
  doc.on('afterTransaction', onDocumentTransaction)
  projectStableContent()

  return () => {
    active = false
    removeEditorUpdate()
    doc.off('afterTransaction', onDocumentTransaction)
  }
}
