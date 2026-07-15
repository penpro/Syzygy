# Data-flow inventory

**Baseline:** 2026-07-14

| Flow | Trigger | Source → destination | Data | Persistence | Guard |
|---|---|---|---|---|---|
| Local generation | User sends Ask | Webview → loopback llama.cpp | Prompt, selected local/Drive passages, history | Thread in localStorage | Loopback endpoint only |
| Local folder context | User grants folder and asks | Granted path → Rust → model prompt | Relevant text chunks | Knowledge cache in memory | Canonical `Granted` allowlist |
| Local research project | User creates/edits project | Lexical editor ↔ Yjs document ↔ IndexedDB | Rich editor updates and reserved project collections | `syzygy-project-v1:<projectId>` IndexedDB | Schema-versioned manifest; fail-closed migration; no network provider attached |
| Drive link | User clicks Link/Re-link and consents | System browser ↔ Google; Rust ↔ token endpoint | OAuth code, refresh/access token, account email | `google_auth.json` in app data | PKCE, state, loopback listener; token never returned to webview |
| Drive direct research | Shared mode + Ask | Selected Drive tree → Rust exports → model prompt | Supported relevant text; file labels | No mirror; request memory only | Collaboration scope + persisted folder ID + descendant checks |
| Drive transcript | Shared mode after response | Completed exchange → selected Drive folder | Prompt and model response | Drive file | Explicit per-thread Shared toggle |
| Drive mirror | User clicks Sync | Selected Drive folder ↔ `Documents/Syzygy` | Supported files; Google-native text/CSV snapshots | Local mirror + Drive | Explicit action; exported snapshots are not re-uploaded |
| Model download | User selects model | Publisher URL → app model directory | GGUF/model metadata | App data | Explicit UI action and expected hash/size metadata where available |
| Update check/install | User confirms check/install | GitHub release endpoint → updater | Version metadata, signed installer | Installer/update cache | Explicit disclosure; updater signature |
| Diagnostic log | Runtime errors/milestones | Frontend/Rust error boundary → local ring | Command/tag/error only | localStorage, newest 500 entries | No prompt, file content, token, or credential logging |
| Live MCP read/control | MCP host starts `Syzygy --mcp` and calls a tool | MCP stdio → token-authenticated ephemeral loopback → Rust event → live webview | Semantic method/parameters; project content only for explicit read/write tools | No MCP copy; live Zustand/Yjs owners persist normally | Loopback only, 256-bit per-process bearer, browser-origin rejection, bounded request, timeout |
| MCP setup/self-description | User opens Settings guide or connected host calls `syzygy_installation` | Running Rust process → webview or MCP stdio | Executable path, parent install folder, app/protocol versions, generated config/prompts | None | Local process metadata only; no OAuth token, model secret, or research content |
| Extension contract inspection | Connected host calls `syzygy_platform_contracts` or CI loads validators | Embedded schemas/status → MCP stdio/test process | Provider transports, adversarial phases, plugin permissions/schemas, implementation states | None | Static public contract data; unimplemented runtimes say `contract-only`; no project/key/account data |

## Planned flows that are not yet runtime claims

| Flow | Trigger | Source → destination | Required guard |
|---|---|---|---|
| Remote model call | User accepts a task disclosure | Selected research context → Rust provider adapter → provider HTTPS API | OS credential store, non-storage default where supported, provider/content disclosure, normalized bounded response |
| Adversarial panel | User starts a configured panel | Evidence snapshot → several provider adapters → blinded review record | compute-matched baseline, order swap, source audit, minority retention, no automatic shared mutation |
| Research plugin | User installs/enables and invokes a contribution | Bounded snapshot → WASI or trusted MCP runtime → typed proposal | declared and granted permissions, no ambient authority, revision guard, diff plus human acceptance |

## Drive boundary nuance

Google's token has wider technical authority than the selected workspace. Syzygy narrows product
operations by folder ID and descendant enumeration. This is an application control, not a Google
permission boundary; see ADR-0001. Any new Drive command must prove that it cannot operate outside
the selected tree or must receive a separate explicit review.

## Evidence still required

- sanitized per-feature network traces (S-06);
- Windows/macOS/Linux app-data permission checks;
- crash-dump inspection for prompt/token leakage;
- two-account Drive harness evidence after restricted-scope reauthorization; and
- packaged Windows/macOS/Linux MCP launch and same-user temp-descriptor permission checks.
