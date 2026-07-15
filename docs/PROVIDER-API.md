# Model provider API

**Contract version:** 1. **Runtime status:** local adapter available; OpenAI Responses request,
bounded timeout/cancellation, and incremental stream normalization are at
`request-stream-parser-control-conformance` and intentionally not product-callable; Anthropic,
Gemini, xAI, and custom remote adapters are contract-only.

The canonical TypeScript contract is `frontend/src/extensions/providerContract.ts`. It prevents
research workflows from depending on a vendor response shape and keeps provider availability
separate from provider capability.

## Required adapter behavior

An adapter eventually implements model discovery, one-shot and streaming generation, cancellation,
tool-call normalization, structured-output validation, usage/cost normalization, and a connection
self-test. It declares capabilities rather than letting callers infer them from a provider name.

Normalized stream events must cover message start, text delta, tool-call start/delta/complete,
usage, finish, provider warning, and error. Parsers must tolerate fragmented frames and unknown
future event types. Tool arguments and structured output are untrusted until schema validation and
domain semantic validation both pass.

## Security boundary

- Local inference remains the default and works without an account or paid key.
- API keys live in Rust and the OS credential facility, never the webview, localStorage, project
  data, diagnostics, MCP output, or exports.
- The webview sends a typed request to Rust; Rust performs remote HTTPS calls and returns normalized
  events. `frontend/src/tauri.ts` remains the only invoke boundary.
- Remote requests default to provider-supported non-storage mode. A feature that requires stored
  provider state must say so and request separate acceptance.
- A task disclosure names provider, content categories, retention/training profile, and estimated
  call count before first transmission. Changing provider or expanding content invalidates it.
- Custom endpoints are visibly unverified and require HTTPS unless the user explicitly selects a
  loopback development endpoint.

## Planned adapter mappings

| Contract transport | Upstream surface | Important normalization |
|---|---|---|
| `local-openai-compatible` | bundled llama.cpp `/v1/chat/completions` | local-only; current streaming path; capabilities measured, not assumed |
| `openai-responses` | OpenAI Responses | set `store:false` by default; strict tool schemas; normalize response items and remote-MCP events |
| `anthropic-messages` | Anthropic Messages | application-managed history; typed SSE; accumulate partial tool JSON; tolerate new events |
| `gemini-interactions` | Gemini Interactions | `store=false` default; preserve required thought signatures and function-call IDs; surface incompatible stateful features |
| `xai-responses` | xAI Responses | explicit storage/ZDR mode; normalize parallel function calls and long-running transport behavior |
| `custom` | plugin/registered adapter | no assumed capabilities; certification fixture required |

The first OpenAI Responses slice lives in Rust and proves the exact `/v1/responses` request against
a loopback fake server: bearer authentication, `store:false`, bounded response collection,
disclosure matching, literal-loopback-or-HTTPS endpoint policy, normalized output/usage, malformed
response rejection, secret/error-body redaction, request and stalled-body timeout, and idempotent
in-flight cancellation. Invalid or overlong timeout controls fail before transport. It does not yet
wire saved keys into requests, dispatch live SSE events, handle streamed tools, expose a frontend
command, or contact the live service. `syzygy_platform_contracts` reports this narrower status
without changing the aggregate remote runtime from `contract-only`.

The incremental OpenAI SSE decoder accepts arbitrary byte fragmentation, including split Unicode;
joins multiline `data:` fields; ignores keepalives; validates optional SSE event labels against
the JSON event type; emits normalized start, text, usage, finish, error, and end events; preserves
unknown future types as warnings; strips provider error messages; and bounds pending frames to one
MiB. Malformed JSON, label mismatch, partial usage, oversized frames, and truncated streams fail
closed. Function-call events, live network SSE dispatch, retry/duplicate semantics, and backpressure
remain open. Cancellation currently covers the complete one-shot request/body future; the same
control must wrap live event dispatch before streaming is product-callable.

The credential-vault boundary uses `keyring` 3.6.3 (MIT/Apache-2.0; MSRV 1.75) with native Windows,
macOS, and persistent Linux backends. Provider secret strings zeroize on drop. The ordinary suite
uses an in-memory trait implementation; `npm run test:credentials:live` creates a random canary in
the current OS credential store, reads it back, deletes it, and verifies absence without printing
the canary. The Windows proof passes, but macOS/Linux live evidence and product-facing key setup are
still open. Dependency provenance is recorded in `docs/audits/EXTENSION-PROVENANCE.md`.

## Certification suite

Every adapter runs the same fake-server and live opt-in tests:

1. connection failure, invalid key, rate limit, timeout, cancellation, and retry-after;
2. fragmented/multi-line/unknown streaming events and malformed JSON;
3. Unicode, long context, empty output, refusal, tool calls, and invalid structured output;
4. parallel calls, duplicate IDs, partial arguments, and unsupported capability requests;
5. storage-off request inspection and sanitized network trace;
6. key canaries across webview state, logs, crash artifacts, MCP, and exports;
7. usage/cost accounting reconciliation; and
8. provider policy URL and review date present.

Passing the contract suite establishes protocol behavior for a named adapter version; it does not
establish model quality or a provider's legal/privacy suitability for a particular study.

Run the currently executable Rust provider slice with `npm run test:providers`.
Run its incremental streaming parser with `npm run test:provider-streams`.
