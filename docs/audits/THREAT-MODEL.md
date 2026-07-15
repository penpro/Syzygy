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
6. Local IndexedDB provider ↔ Yjs/domain state.
7. Future Drive/WebSocket collaboration provider ↔ local Yjs/domain state.
8. Local MCP process ↔ authenticated loopback bridge ↔ live webview state.

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
| Corrupt or future local project state loads as trusted content | Manifest parser rejects malformed/unknown schema versions; migrations are idempotent | Fuzz Yjs payloads, archive bombs, unknown node types, and interrupted IndexedDB writes |
| Local provider is mistaken for real-time collaboration | UI says local persistence; Drive/presence controls remain disabled | Two-editor and two-install provider-contract gates must pass before collaboration claims |
| Path traversal through Drive filename | Direct reads are in memory; mirror joins remote names | Sanitize/reject separators before mirror writes |
| OAuth token stolen from app data | OS user boundary; no webview exposure | OS credential vault/encryption evaluation needed |
| Malicious update | Tauri updater signature and separate Syzygy key | Protect/back up signing key; clean-machine update tests |
| Diagnostics leak research/token | Typed invoke logger records command/error only | Automated canary/redaction tests needed |
| LAN or website pilots the live app | Ephemeral IPv4 loopback bind, random 256-bit bearer, browser-origin rejection, bounded HTTP parser | Verify OS firewall/listener state and hostile browser preflight on each platform |
| MCP overwrites a collaborator's newer draft | Every document write requires the exact revision from a prior live read | Revision is editor-state optimistic concurrency, not yet an attributed review/approval workflow |
| Stale MCP descriptor targets the wrong process | Descriptor includes schema/PID/version; connection and per-process token fail closed; normal shutdown removes it | Abrupt termination leaves a harmless stale descriptor until the next GUI launch; add PID liveness cleanup |
| Same-user malware steals the MCP token | User-local temp ACL (and `0600` on Unix); token rotates every GUI process | Not a same-user sandbox; evaluate OS named pipes/peer credentials before exposing higher-risk tools |
| Generated MCP instructions point to the wrong binary | UI and `syzygy_installation` share Rust `current_exe` discovery; JSON/TOML path-with-spaces tests run against the real binary | Reinstall/move can invalidate configuration; the guide tells users to regenerate it from the running app |

## Release blockers

- A path traversal or selected-workspace escape is high severity.
- Returning Drive tokens to the webview is high severity.
- Any AI action that mutates shared state without human acceptance is high severity.
- Any MCP addition that bypasses semantic domain/editor contracts or grants ambient Drive/filesystem/model authority is high severity.
- Claiming S-01 verified before the live Drive→local-model harness passes is a documentation defect.
