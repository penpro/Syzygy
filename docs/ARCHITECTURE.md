# Syzygy Architecture

> The one-page mental model. If you read nothing else, read this.

## What Syzygy is

A **local-first AI document workspace**: a Tauri v2 desktop app pairing a fully-local LLM
(bundled llama.cpp engine on the user's GPU) with real file/folder access and optional
Google Drive collaboration. Forked from **Aphelion** (`penpro/Aphelion`), Penumbra's
local-AI studio; the roleplay surface was removed and the document/collaboration surface
is being built in its place. The long-term goal is a free, local-first collaborative
document editor — the fully-free rework of the ideas in
[PolicyPad](https://github.com/kjfeng/policypad) (CHI 2026).

## The three sibling folders (on the dev machine)

| Folder | Role |
|---|---|
| `D:\PolicyPad\policypad` | Pristine clone of upstream PolicyPad. Reference only — never build here. |
| `D:\PolicyPad\syzygy-web` | The Next.js fork holding the **Tiptap-v3 collaborative editor** + pluggable AI backend. Porting source for the future workspace view — not shipped. |
| `D:\PolicyPad\syzygy` | **This repo.** The shipping desktop app. |

## The Aphelion model (no server, ever)

There is no backend server. The app is a static **Vite React SPA** rendered in a Tauri
webview, plus a **Rust core**. Anything "backend" is one of two calls:

1. **AI** → direct `fetch` from the webview to the bundled llama.cpp server on
   `http://127.0.0.1:11435/v1` (OpenAI-compatible; hidden process; loopback only).
2. **OS / files / network** → `invoke('command')` into the Rust core.

```
 you ──▶ webview (React) ──▶ 127.0.0.1:11435 llama.cpp ──▶ GGUF on GPU
              │
              └─ invoke() ──▶ Rust core ── files, engine mgmt, Google APIs
```

## Rust core modules (`frontend/src-tauri/src/`)

| Module | Owns |
|---|---|
| `lib.rs` | Wiring: managed state, engine auto-start, command registration. |
| `engine.rs` | Spawning/stopping llama.cpp (Vulkan), model files, VRAM detection. |
| `documents.rs` | Typst compile, document save/read, path granting (`Granted` allowlist). |
| `knowledge.rs` | Folder knowledge: chunking granted folders, relevance retrieval. |
| `google_auth.rs` | OAuth loopback + PKCE, token storage/refresh, cancel. See `GOOGLE-DRIVE.md`. |
| `google_drive.rs` | Drive file ops + the **folder mirror sync**. See `GOOGLE-DRIVE.md`. |
| `downloads.rs` | Resumable model downloads. |
| `updates.rs` | App version for the in-app updater. |
| `state.rs` | Shared state types (`Engine`, `Granted`, `KnowledgeCache`, …). |
| `vision.rs` | Optional vision-model engine swap (image describe/search). |

**Security posture:** the model only ever sees text; the webview never sees OAuth
credentials/tokens (they live in Rust + app-data); file access is allowlisted via
`Granted` (folders the user explicitly picked or the app created).

## Frontend layout (`frontend/src/`)

- `App.tsx` — state-driven views (no router). Today a single **Ask** surface; the
  collaborative document workspace will mount as a sibling view.
- `store.ts` — one zustand store, persisted to localStorage under key **`syzygy`**
  (`storage.ts` wraps quota/corruption; `migrations.ts` is the only place save-shape
  changes are reconciled). Slices: `settings`, engine runtime, `experts`, `asks`.
- `tauri.ts` — **the single typed boundary** to the Rust core. Every command has a wrapper
  here; components never import `invoke` directly. The wrapper auto-logs every backend
  failure to the diagnostic log (`log.ts`).
- `api/ollama.ts` — streaming chat to the local engine; `api/classifiers.ts` — one-shot
  intent/vision classifiers.
- `components/` — Ask surface (`AskView`, `ExpertPicker/Editor`, `MessageInput`,
  `DocumentModal`, `FolderGrant`, `ImageFinderModal`), shell (`TitleBar`, `Sidebar`,
  `SettingsPanel`, `SetupWizard`, `SplashScreen`, `UpdateCheck`, `ModelsModal`,
  `LogModal`), Drive (`GoogleDriveButton`), brand (`SyzygyMark`).

## Persistence map

| What | Where |
|---|---|
| Settings, experts, ask threads | localStorage key `syzygy` (webview) |
| Google refresh token + client info | `<app-data>/google_auth.json` (Rust-only) |
| Models (GGUF) | `<app-data>/models/` |
| Drive mirror folder | `<Documents>/Syzygy` (synced to Drive folder "Syzygy") |

## Key invariants

- **The AI loop is 100% local.** Never write copy claiming the whole app is offline —
  see `DESIGN.md → Voice`. Internet is touched only by explicitly invoked features:
  model downloads, update checks, Google Drive.
- **`tauri.ts` is the only invoke boundary** (logging + typing chokepoint).
- **`migrations.ts` is the only save-migration site.**
- **Removed features come back from Aphelion** (`D:\LocalLLM`), not from git archaeology.
