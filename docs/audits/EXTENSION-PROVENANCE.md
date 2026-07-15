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
| `frontend/src-tauri/src/model_provider.rs` | repository commit | Penumbra original / repository MIT | Disclosure-gated OpenAI Responses request/stream plus Anthropic Messages, Gemini Interactions, and xAI Responses one-shot construction, provider-neutral normalization, ZDR attestation, bounded deadlines/bytes, and caller-controlled cancellation. |
| `frontend/src-tauri/src/provider_runtime.rs` | repository commit | Penumbra original / repository MIT | Structured research-task envelope with Rust-derived disclosure/provenance, fixed built-in endpoint dispatch, OS-vault lookup, cancellation registry, sanitized outcome, content-free provider-run record, and native per-send disclosure. No PolicyPad/Tiptap/provider SDK code or prompt was used. |
| `frontend/src/components/RemoteProviderSettings.tsx` | repository commit | Penumbra original / repository MIT | Original collapsed OS-vault settings UI for four built-in providers. No provider SDK, copied UI, or external product source is used. |
| `scripts/plugin-certifier.mjs`, its tests, and `examples/plugins/citation-auditor` | repository commit | Penumbra original / repository MIT | Bounded schema validation, real-path containment, proposal fixtures, authority probes, and interface-only example. |
| `frontend/src/extensions/adversarialRunRecord.ts` and tests | repository commit | Penumbra original / repository MIT | Synthetic evidence-record validation and metrics; no external prompts, schemas, or product fixtures copied. |
| `frontend/src/extensions/adversarialRunner.ts` and tests | repository commit | Penumbra original / repository MIT | Injected adversarial phase orchestration, bounded/sanitized synthetic executor tests, blinded judge payloads, equal-call baseline, and non-mutating output. No PolicyPad/Tiptap code, prompts, schemas, fixtures, or provider SDK code was used. |
| `docs/schemas/syzygy-adversarial-run-v1.schema.json` | repository commit | Penumbra original / repository MIT | Public strict interchange shape derived from Syzygy's original typed record; structural validation only. |
| `frontend/src/extensions/providerRunRecord.ts`, tests, and `docs/schemas/syzygy-provider-run-v1.schema.json` | repository commit | Penumbra original / repository MIT | Content-free model-call provenance, strict public shape, and cross-field disclosure/retention/accounting validation; no external product schema or fixture copied. |
| `frontend/src/extensions/modelAdapterProfile.ts`, `scripts/model-adapter-certifier.mjs`, schemas, tests, and `examples/model-adapters/local-vllm` | repository commit | Penumbra original / repository MIT | Declarative compatible-endpoint contract, non-executing package/endpoint-probe certifier, and original interface-only fixture. Public vLLM/llama.cpp/LiteLLM docs informed use cases, not copied implementation. |

Primary dependency sources checked on 2026-07-15:

- <https://docs.rs/crate/keyring/3.6.3/source/Cargo.toml>
- <https://docs.rs/crate/keyring/3.6.3/source/README.md>
- <https://docs.rs/zeroize/>
- <https://github.com/ajv-validator/ajv>

Adversarial checks still required: release SBOM/license scan on all targets, macOS/Linux native
build and live-store canaries, Linux locked/unavailable Secret Service behavior, Windows credential
length limits, crash-dump/memory inspection, and proof that no frontend command can return a key.
