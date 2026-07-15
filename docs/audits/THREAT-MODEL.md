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
9. Future Rust provider adapters ↔ remote model APIs and OS credential storage.
10. Future WASI/native-MCP plugin runtimes ↔ permission broker ↔ project/Drive/model services.

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
| Contract scaffolding is mistaken for a working feature | MCP returns explicit per-runtime `contract-only` status; tests assert it | Update status only with end-to-end adapter/runner/loader evidence |
| Remote provider key leaks into webview/project/log/MCP | Rust-only unwired transport uses a redacted, zeroizing secret wrapper; OS-vault trait tests and a Windows live create/read/delete/absence canary pass | macOS/Linux live canaries, product UI integration, webview/log/export canary scans, and crash-memory review remain release gates |
| Remote provider silently stores research or transmits to an unsafe endpoint | OpenAI request fixture forces `store:false`, requires matching content disclosure, and accepts only HTTPS or literal loopback HTTP | Streaming/tools and every additional adapter need equivalent wire inspection; provider policy must be rechecked at release |
| Remote provider retains or trains on unexpected data | Provider profile separates state/training/ZDR and task disclosure is required | Policies change; re-check primary terms at adapter release and record policy date |
| Multi-model panel creates false confidence | Blind proposals, evidence pass, reversed judge order, minority report, compute-matched baseline | Protocol execution and domain benchmark are not implemented; no quality claim yet |
| Plugin manifest grants itself authority | Manifests are requests; broker grants and rechecks permissions | Runtime broker not implemented; hostile permission suite required |
| Native plugin escapes product controls | Native MCP is labeled an advanced unsandboxed process; WASI is preferred | Same-user native code retains OS authority; hashes/signatures do not make it a sandbox |
| Plugin overwrites newer or unreviewed work | Plugin mutations use bounded revision-guarded proposals plus human acceptance | Drive-specific proposal schemas and runtime acceptance UI remain open |
| A collaboration test mistakes internal node-map enumeration for visible document order | Policy-block convergence assertions traverse ordered root children; the false-positive failure and corrected oracle are recorded in run evidence | Add pointer/keyboard interaction, randomized ordering, and concurrent move-vs-edit partition cases before claiming P-10 |

## Release blockers

- A path traversal or selected-workspace escape is high severity.
- Returning Drive tokens to the webview is high severity.
- Any AI action that mutates shared state without human acceptance is high severity.
- Any MCP addition that bypasses semantic domain/editor contracts or grants ambient Drive/filesystem/model authority is high severity.
- Any remote adapter that exposes a key to the webview or transmits before disclosure is high severity.
- Any plugin path that directly mutates project/Drive state or gains undeclared network/model authority is high severity.
- Claiming S-01 verified before the live Drive→local-model harness passes is a documentation defect.
