# Research extension dependency provenance

**Baseline:** 2026-07-15. This ledger covers dependencies introduced for remote model and plugin
boundaries. It is not a substitute for the generated release SBOM.

| Dependency / source | Version | License | Purpose and review note |
|---|---:|---|---|
| `keyring` | 3.6.3 exact | MIT OR Apache-2.0 | Cross-platform OS credential API. This is the newest reviewed line compatible with Syzygy's Rust 1.77.2 floor; upstream declares MSRV 1.75. Platform features are selected explicitly: Windows native, Apple native, and Linux keyutils plus persistent Secret Service with Rust crypto. |
| `zeroize` | 1.9.0 locked (`^1.8.1`) | MIT OR Apache-2.0 | Clears provider secret string storage on drop. It was already compatible with the dependency graph; Syzygy declares it directly because memory cleanup is a product invariant. |
| `ajv` | 8.20.0 exact | MIT | Draft 2020-12 validation for the non-executing plugin package certifier. Exact package-lock version; no remote schemas or generated plugin code are executed. |
| `frontend/src-tauri/src/credential_vault.rs` | repository commit | Penumbra original / repository MIT | Narrow identifiers, sanitized error mapping, provider-neutral trait, native OS implementation, and memory contract tests. |
| `frontend/src-tauri/src/bin/credential-harness.rs` | repository commit | Penumbra original / repository MIT | Opt-in live canary that verifies create/read/delete/absence and never prints the secret. |
| `frontend/src-tauri/src/model_provider.rs` | repository commit | Penumbra original / repository MIT | Disclosure-gated OpenAI Responses request/stream construction, provider-neutral HTTP event dispatch, bounded deadlines/bytes, and caller-controlled cancellation. |
| `scripts/plugin-certifier.mjs`, its tests, and `examples/plugins/citation-auditor` | repository commit | Penumbra original / repository MIT | Bounded schema validation, real-path containment, proposal fixtures, authority probes, and interface-only example. |
| `frontend/src/extensions/adversarialRunRecord.ts` and tests | repository commit | Penumbra original / repository MIT | Synthetic evidence-record validation and metrics; no external prompts, schemas, or product fixtures copied. |

Primary dependency sources checked on 2026-07-15:

- <https://docs.rs/crate/keyring/3.6.3/source/Cargo.toml>
- <https://docs.rs/crate/keyring/3.6.3/source/README.md>
- <https://docs.rs/zeroize/>
- <https://github.com/ajv-validator/ajv>

Adversarial checks still required: release SBOM/license scan on all targets, macOS/Linux native
build and live-store canaries, Linux locked/unavailable Secret Service behavior, Windows credential
length limits, crash-dump/memory inspection, and proof that no frontend command can return a key.
