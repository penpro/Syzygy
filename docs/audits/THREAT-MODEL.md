# Threat model

**Baseline:** 2026-07-14. This is a living Phase 0 inventory, not a completed security claim.

## Assets

Local research, prompts/responses, Drive refresh token, selected workspace content, downloaded
models, collaborative state, participant identity, updater signing trust, and future immutable
versions/evaluation evidence.

## Trust boundaries

1. React webview ↔ typed Tauri commands.
2. Rust core ↔ local filesystem.
3. Webview ↔ loopback llama.cpp.
4. Rust core ↔ Google OAuth/Drive over TLS.
5. Updater ↔ GitHub signed release metadata.
6. Future collaboration provider ↔ local Yjs/domain state.

## Current threats and controls

| Threat | Current control | Residual risk / next test |
|---|---|---|
| Webview reads arbitrary local path | Canonical `Granted` allowlist | Junction/symlink race tests needed |
| Webview obtains OAuth token | Token/access exchange remains Rust-only; command removed | Audit every new Drive wrapper |
| Broad Drive token reads outside workspace | Descendant enumeration and selected-folder config | Application boundary can regress; add hostile-ID tests |
| Legacy scope yields empty evidence and model hallucinates | Collaboration access gate; Shared Ask fails closed | Live re-link harness outstanding |
| Malicious Drive text prompt-injects model | Text is labeled evidence; model has no ambient commands | Injection fixture and proposal-only AI contract needed |
| Oversized/nested Drive workspace exhausts resources | 2,000-file and 12-level direct-read bounds | Measure bytes/API calls and add attachment limits |
| Transcript leaks a local conversation | Shared toggle is explicit and UI copy names logging | Per-message inclusion controls are future work |
| Mirror conflict loses edits | Current LWW mirror documented as optional | Never use LWW for CRDT state; Phase 4 convergence tests |
| Path traversal through Drive filename | Direct reads are in memory; mirror joins remote names | Sanitize/reject separators before mirror writes |
| OAuth token stolen from app data | OS user boundary; no webview exposure | OS credential vault/encryption evaluation needed |
| Malicious update | Tauri updater signature and separate Syzygy key | Protect/back up signing key; clean-machine update tests |
| Diagnostics leak research/token | Typed invoke logger records command/error only | Automated canary/redaction tests needed |

## Release blockers

- A path traversal or selected-workspace escape is high severity.
- Returning Drive tokens to the webview is high severity.
- Any AI action that mutates shared state without human acceptance is high severity.
- Claiming S-01 verified before the live Drive→local-model harness passes is a documentation defect.
