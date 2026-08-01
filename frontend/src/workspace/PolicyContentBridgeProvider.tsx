import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ResearchProjectManifest } from './schema'
import {
  registerPolicyContentBridge,
  type PolicyContentBridgeState,
} from './policyContentBridge'
import { subscribeAutomationProjectDocument } from './workspaceAutomationRegistry'

const PolicyContentBridgeContext = createContext<PolicyContentBridgeState | null>(null)

export function usePolicyContentBridgeState(): PolicyContentBridgeState | null {
  return useContext(PolicyContentBridgeContext)
}

export function PolicyContentBridgeProvider({
  project,
  children,
}: {
  project: ResearchProjectManifest
  children: ReactNode
}) {
  const [editor] = useLexicalComposerContext()
  const [state, setState] = useState<PolicyContentBridgeState | null>(null)

  useEffect(() => {
    let unregisterBridge = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeAutomationProjectDocument(project.id, (doc) => {
      unregisterBridge()
      unregisterBridge = () => {}
      if (timer) clearTimeout(timer)
      timer = null
      setState(null)
      if (!doc) return
      // The provider publishes its document immediately before Lexical's sync/bootstrap event.
      // Defer one task so the editor root, not an empty pre-bootstrap snapshot, is authoritative.
      timer = setTimeout(() => {
        timer = null
        try {
          unregisterBridge = registerPolicyContentBridge(editor, doc, {
            bootstrapExisting: project.transport.kind === 'local',
            onState: setState,
          })
        } catch (value) {
          setState({
            healthy: false,
            error: value instanceof Error ? value.message : String(value),
            stablePolicyCount: 0,
            legacyPolicyIds: [],
          })
        }
      }, 0)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
      unregisterBridge()
    }
  }, [editor, project.id, project.transport.kind])

  return <PolicyContentBridgeContext.Provider value={state}>{children}</PolicyContentBridgeContext.Provider>
}

export function PolicyContentBridgeNotice({ state }: { state: PolicyContentBridgeState | null }) {
  if (!state) return null
  if (!state.healthy) {
    return (
      <div className="research-policy-content-notice" data-state="error" role="alert">
        Stable policy content is unavailable. Shared reordering stays paused. {state.error}
      </div>
    )
  }
  if (state.legacyPolicyIds.length) {
    return (
      <div className="research-policy-content-notice" data-state="legacy" role="status">
        {state.legacyPolicyIds.length} legacy policy {state.legacyPolicyIds.length === 1 ? 'block still uses' : 'blocks still use'} the original shared tree. Reordering stays paused until one stable baseline is coordinated.
      </div>
    )
  }
  return null
}

export function ConnectedPolicyContentBridgeNotice() {
  return <PolicyContentBridgeNotice state={usePolicyContentBridgeState()} />
}
