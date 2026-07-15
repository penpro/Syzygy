# ADR-0002: Remote model providers stay behind the Rust credential and normalization boundary

- **Status:** accepted for implementation
- **Date:** 2026-07-14

## Context

Syzygy is local-first and must work with its bundled local model, but researchers may opt into
OpenAI, Anthropic, Gemini, xAI, or custom providers for comparison and adversarial review. Provider
APIs differ in streaming, tools, state, retention, training terms, and credential handling. A
webview adapter would expose secrets to browser state and encourage vendor shapes throughout the
research domain.

## Decision

Provider descriptors and normalized research contracts are vendor-neutral TypeScript. Remote HTTPS
and credentials are Rust-owned. Keys use an OS credential facility and never enter webview state,
project data, logs, MCP, or exports. Local remains the default. Remote tasks require content- and
provider-specific disclosure, default to non-storage where supported, and record the provider
policy profile used at run time. Provider claims are capability flags, not provider-name branches.

Adversarial execution stores inspectable outputs and judgments, not hidden chain-of-thought. Any
shared-state mutation remains a revision-guarded proposal requiring human acceptance.

## Consequences

- More Rust adapter work and normalized-event tests are required.
- Browser-only provider SDK conveniences are rejected.
- Provider policy drift becomes an explicit release/test concern.
- The same research workflow can compare local and remote models without importing vendor response
  types into project schemas.

## Rejected alternatives

- **Keys in localStorage or frontend environment:** too easy to expose through webview compromise,
  diagnostics, or exports.
- **One OpenAI-compatible abstraction for every provider:** hides meaningful streaming, state,
  tool, and retention differences.
- **Remote-first default:** conflicts with local-first access and creates an account/paywall gate.
