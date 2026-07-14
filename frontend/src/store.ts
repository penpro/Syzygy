import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ChatMessage, Settings, AppView, Expert, Ask } from './types'
import { uid, now } from './util'
import { safeStorage } from './storage'
import { mergePersisted } from './migrations'
import { defaultSettings, defaultExperts } from './seed'

interface AppState {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void

  // live engine state (runtime-only, not persisted)
  loadedModel: string | null
  setLoadedModel: (m: string | null) => void
  engineMode: 'text' | 'image' // which model the engine currently serves — single source of truth
  setEngineMode: (m: 'text' | 'image') => void

  // view / navigation
  view: AppView
  setView: (v: AppView) => void

  // experts (rule sets for the Ask view)
  experts: Expert[]
  addExpert: (e: Pick<Expert, 'name' | 'emoji' | 'systemPrompt'>) => Expert
  updateExpert: (id: string, patch: Partial<Expert>) => void
  deleteExpert: (id: string) => void

  // asks (multi-turn expert Q&A)
  asks: Ask[]
  activeAskId: string | null
  createAsk: () => string
  updateAsk: (id: string, patch: Partial<Ask>) => void
  deleteAsk: (id: string) => void
  openAsk: (id: string) => void
  addAskMessage: (askId: string, msg: Omit<ChatMessage, 'id' | 'createdAt'>) => string
  appendToAskMessage: (askId: string, msgId: string, patch: { content?: string; reasoning?: string }) => void
  updateAskMessage: (askId: string, msgId: string, patch: Partial<ChatMessage>) => void
  clearAskThread: (askId: string) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      loadedModel: null,
      setLoadedModel: (m) => set({ loadedModel: m }),
      engineMode: 'text',
      setEngineMode: (m) => set({ engineMode: m }),

      view: 'ask',
      setView: (v) => set({ view: v }),

      // ---- experts (rule sets for the Ask view) ----
      experts: defaultExperts,
      addExpert: (e) => {
        const created: Expert = { ...e, id: uid(), createdAt: now() }
        set((s) => ({ experts: [...s.experts, created] }))
        return created
      },
      updateExpert: (id, patch) =>
        set((s) => ({ experts: s.experts.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      deleteExpert: (id) =>
        set((s) => ({
          experts: s.experts.filter((e) => e.id !== id),
          asks: s.asks.map((a) => (a.expertId === id ? { ...a, expertId: null } : a)),
        })),

      // ---- asks (multi-turn expert Q&A) ----
      asks: [],
      activeAskId: null,
      createAsk: () => {
        const id = uid()
        const expertId = get().experts[0]?.id ?? null
        const ask: Ask = { id, title: '', expertId, messages: [], think: false, createdAt: now(), updatedAt: now() }
        set((s) => ({ asks: [ask, ...s.asks], activeAskId: id, view: 'ask' }))
        return id
      },
      updateAsk: (id, patch) =>
        set((s) => ({ asks: s.asks.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: now() } : a)) })),
      deleteAsk: (id) =>
        set((s) => {
          const asks = s.asks.filter((a) => a.id !== id)
          return { asks, activeAskId: s.activeAskId === id ? (asks[0]?.id ?? null) : s.activeAskId }
        }),
      openAsk: (id) => set({ activeAskId: id, view: 'ask' }),
      addAskMessage: (askId, msg) => {
        const id = uid()
        set((s) => ({
          asks: s.asks.map((a) =>
            a.id !== askId ? a : { ...a, messages: [...a.messages, { ...msg, id, createdAt: now() }], updatedAt: now() },
          ),
        }))
        return id
      },
      appendToAskMessage: (askId, msgId, patch) =>
        set((s) => ({
          asks: s.asks.map((a) =>
            a.id !== askId
              ? a
              : {
                  ...a,
                  messages: a.messages.map((m) =>
                    m.id !== msgId
                      ? m
                      : {
                          ...m,
                          content: m.content + (patch.content ?? ''),
                          reasoning: (m.reasoning ?? '') + (patch.reasoning ?? ''),
                        },
                  ),
                  updatedAt: now(),
                },
          ),
        })),
      updateAskMessage: (askId, msgId, patch) =>
        set((s) => ({
          asks: s.asks.map((a) =>
            a.id !== askId
              ? a
              : { ...a, messages: a.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)), updatedAt: now() },
          ),
        })),
      clearAskThread: (askId) =>
        set((s) => ({ asks: s.asks.map((a) => (a.id === askId ? { ...a, messages: [], title: '', updatedAt: now() } : a)) })),
    }),
    {
      name: 'syzygy',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      partialize: (s) => ({
        settings: s.settings,
        view: s.view,
        experts: s.experts,
        asks: s.asks,
        activeAskId: s.activeAskId,
      }),
      // All save-format backfills/migrations live in migrations.ts — one place to read
      // (and test) when the persisted shape changes.
      merge: (persisted, current) => mergePersisted(persisted, current),
    },
  ),
)
