# Data-flow inventory

**Baseline:** 2026-07-14

| Flow | Trigger | Source → destination | Data | Persistence | Guard |
|---|---|---|---|---|---|
| Local generation | User sends Ask | Webview → loopback llama.cpp | Prompt, selected local/Drive passages, history | Thread in localStorage | Loopback endpoint only |
| Local folder context | User grants folder and asks | Granted path → Rust → model prompt | Relevant text chunks | Knowledge cache in memory | Canonical `Granted` allowlist |
| Drive link | User clicks Link/Re-link and consents | System browser ↔ Google; Rust ↔ token endpoint | OAuth code, refresh/access token, account email | `google_auth.json` in app data | PKCE, state, loopback listener; token never returned to webview |
| Drive direct research | Shared mode + Ask | Selected Drive tree → Rust exports → model prompt | Supported relevant text; file labels | No mirror; request memory only | Collaboration scope + persisted folder ID + descendant checks |
| Drive transcript | Shared mode after response | Completed exchange → selected Drive folder | Prompt and model response | Drive file | Explicit per-thread Shared toggle |
| Drive mirror | User clicks Sync | Selected Drive folder ↔ `Documents/Syzygy` | Supported files; Google-native text/CSV snapshots | Local mirror + Drive | Explicit action; exported snapshots are not re-uploaded |
| Model download | User selects model | Publisher URL → app model directory | GGUF/model metadata | App data | Explicit UI action and expected hash/size metadata where available |
| Update check/install | User confirms check/install | GitHub release endpoint → updater | Version metadata, signed installer | Installer/update cache | Explicit disclosure; updater signature |
| Diagnostic log | Runtime errors/milestones | Frontend/Rust error boundary → in-memory ring | Command/tag/error only | Memory until copied | No prompt, file content, token, or credential logging |

## Drive boundary nuance

Google's token has wider technical authority than the selected workspace. Syzygy narrows product
operations by folder ID and descendant enumeration. This is an application control, not a Google
permission boundary; see ADR-0001. Any new Drive command must prove that it cannot operate outside
the selected tree or must receive a separate explicit review.

## Evidence still required

- sanitized per-feature network traces (S-06);
- Windows/macOS/Linux app-data permission checks;
- crash-dump inspection for prompt/token leakage; and
- two-account Drive harness evidence after restricted-scope reauthorization.
