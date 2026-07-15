# Model provider API

**Contract version:** 1. **Runtime status:** local adapter available; OpenAI Responses request,
bounded timeout/cancellation, and fake-network incremental stream dispatch are at
`request-and-stream-control-conformance`; Anthropic
Messages, Gemini Interactions, and xAI Responses one-shot requests are at
`request-control-conformance`. A Rust one-shot task bridge is fake-network certified and registered
with typed generation/cancellation commands. Each call obtains one-use approval from a native
dialog before vault or network access; the request cannot provide its own approval. Credential
set/status/delete are also typed commands and a collapsed Settings surface calls them without
persisting keys in app state. No product generation workflow exists yet. Custom remote adapters
are contract-only.

The canonical TypeScript contract is `frontend/src/extensions/providerContract.ts`. It prevents
research workflows from depending on a vendor response shape and keeps provider availability
separate from provider capability.

Every eventual invocation must also produce the content-free public record defined by
`docs/schemas/syzygy-provider-run-v1.schema.json` and
`frontend/src/extensions/providerRunRecord.ts`. The record links a call to frozen source snapshot
IDs and input/output hashes without embedding prompts, outputs, provider errors, or credentials.
It records adapter status, task type, bounds, destination, disclosure approval, policy review,
storage request, typed zero-retention attestation, terminal state, token usage, and cost. The
semantic validator rejects cross-field lies that JSON Schema cannot express, including an
undisclosed remote call, HTTP remote endpoint, false ZDR claim, output attached to a failed call,
or inconsistent token total. MCP publishes the exact schema and truthful validator status.

This record is an interchange and audit boundary, not proof that a provider honored its policy.
The transport's fake/live evidence and the dated policy source remain separate artifacts.
The internal Rust task bridge now creates the record for completed, failed, cancelled, and timed-out
attempts. Its loopback harness passes the serialized Rust record directly through the public
TypeScript schema and semantic validator. A `loopback-conformance` marker permits only an actual
literal-loopback destination; omitted/`product` records still require remote HTTPS. The registered
command and native disclosure are an internal product boundary, not proof of a live provider or a
user-accessible remote-model workflow.

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
| `custom` | declarative compatible profile or future sandboxed plugin | no assumed capabilities; certification fixture required |

The first OpenAI Responses slice lives in Rust and proves the exact `/v1/responses` request against
a loopback fake server: bearer authentication, `store:false`, bounded response collection,
disclosure matching, literal-loopback-or-HTTPS endpoint policy, normalized output/usage, malformed
response rejection, secret/error-body redaction, request and stalled-body timeout, and idempotent
in-flight cancellation. Invalid or overlong timeout controls fail before transport. The network
stream path verifies the SSE media type, feeds real HTTP byte chunks through the same decoder,
enforces start/finish/end order and a 32 MiB aggregate ceiling, serially dispatches normalized
events, distinguishes sanitized provider failure, and cancels between events. The internal one-shot
task bridge now retrieves saved keys and authors provenance behind a typed native-disclosure
command, but no product workflow calls it and no live service has been contacted. It does not
handle streamed tools. `syzygy_platform_contracts` reports aggregate status as
`native-disclosure-command-no-product-ui`.

The incremental OpenAI SSE decoder accepts arbitrary byte fragmentation, including split Unicode;
joins multiline `data:` fields; ignores keepalives; validates optional SSE event labels against
the JSON event type; emits normalized start, text, usage, finish, error, and end events; preserves
unknown future types as warnings; strips provider error messages; and bounds pending frames to one
MiB. Malformed JSON, label mismatch, partial usage, oversized frames, and truncated streams fail
closed. Function-call events, retry/duplicate semantics, slow-consumer stress, and reconnect remain
open. Cancellation covers the complete one-shot request/body future and the fake-network stream
through normalized event dispatch; product wiring must preserve the same control boundary.

The credential-vault boundary uses `keyring` 3.6.3 (MIT/Apache-2.0; MSRV 1.75) with native Windows,
macOS, and persistent Linux backends. Provider secret strings zeroize on drop. The ordinary suite
uses an in-memory trait implementation; `npm run test:credentials:live` creates a random canary in
the current OS credential store, reads it back, deletes it, and verifies absence without printing
the canary. Credential-only Tauri commands and `tauri.ts` wrappers now set, report presence, or
delete the default provider key without returning it. A collapsed Settings surface supports all
four providers with a password field that is never placed in React/store state and is cleared
before the asynchronous write completes. Saving does not transmit research. macOS/Linux live
evidence, transient DOM/heap leak tests, and product generation workflow UI remain open. Dependency provenance is
recorded in `docs/audits/EXTENSION-PROVENANCE.md`.

The first Anthropic Messages slice is also Rust-owned and fake-server-only. It proves the exact
`/v1/messages` endpoint, `x-api-key`, `anthropic-version: 2023-06-01`, content type, separate system
text blocks, user messages, `max_tokens`, and `stream:false`. The normalizer requires a complete
assistant message, retains text blocks, reports other block types without storing their contents,
computes overflow-safe total usage, maps refusal to a sanitized marker, bounds response bytes, and
shares the disclosure, timeout, cancellation, TLS/loopback, and error-redaction gates. Anthropic
streaming, tool blocks, beta headers, request IDs, live policy validation, UI, and opt-in live proof
remain open.

The Gemini slice targets the stable `/v1/interactions` API rather than silently following an SDK's
preview default. Its Rust fake server proves `x-goog-api-key`, content type, model, joined local
system/user text, `generation_config.max_output_tokens`, `thinking_summaries:none`, `stream:false`,
`background:false`, and `store:false`. The normalizer requires an Interaction identity/status,
retains only text in `model_output` steps, reports thought and non-text types without retaining
their contents, and accepts usage only when total tokens cover input plus output. The endpoint,
disclosure, byte bound, redaction, timeout, and cancellation gates match the other remote slices.
Streaming lifecycle events, tools, thought-signature continuation, structured output, stored state,
live terms validation, UI, and opt-in live proof remain open.

The xAI slice deliberately reuses only the compatible Responses wire shape, not OpenAI privacy
assumptions. It sends bearer auth to `/v1/responses`, forces `store:false`, and omits
`previous_response_id`, `prompt_cache_key`, and conversation-routing headers. Every successful
response must include xAI's boolean `x-zero-data-retention` header; the typed result exposes whether
enterprise ZDR was actually active instead of treating `store:false` as ZDR. Output and usage use
the provider-neutral Responses normalizer and the common disclosure, endpoint, size, redaction,
timeout, and cancellation gates. Streaming/WebSocket mode, tools, encrypted reasoning continuity,
cost ticks, UI, and opt-in live proof remain open.

## Custom compatible adapters

The first open adapter API is deliberately declarative: a package supplies
`syzygy-model-adapter.json`, `syzygy-certification.json`, documentation, license, one valid and one
hostile profile fixture, and exact endpoint allow/deny probes. The profile can target Responses,
Chat Completions, or Anthropic Messages compatibility. It declares capabilities and limitations;
it cannot inject raw headers, request templates, JavaScript, secrets, redirects, query strings, or
arbitrary routes. Built-in provider IDs cannot be shadowed. Local profiles are pinned to literal
loopback and local-only data handling; remote profiles require HTTPS, authentication, and a dated
policy reference.

Run `npm run test:model-adapter-sdk` or `npm run certify:model-adapter -- <folder>`. A passing report
is only `contract-certified`: no code executes, no endpoint is contacted, no credential is stored,
and no capability claim is live-tested. The interface-only vLLM example is in
`examples/model-adapters/local-vllm`. Arbitrary protocols remain a future capability-sandboxed
WASI tier rather than a reason to execute third-party code in the webview.

The initial compatibility use cases are grounded in current primary documentation: vLLM exposes
OpenAI-compatible Responses/Chat endpoints, llama.cpp exposes compatible Responses, Chat, and
Anthropic Messages routes while warning that compatibility can be partial, and LiteLLM routes many
providers through a common OpenAI-shaped proxy. These differences are why profiles must declare
exact route and limitations instead of claiming generic “OpenAI compatible” behavior:

- <https://docs.vllm.ai/en/stable/serving/openai_compatible_server/>
- <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
- <https://docs.litellm.ai/>

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
9. a schema-valid provider-run record passes semantic validation without raw research content.
10. custom profiles pass hostile package and exact endpoint-probe certification without execution.

Passing the contract suite establishes protocol behavior for a named adapter version; it does not
establish model quality or a provider's legal/privacy suitability for a particular study.

Run the currently executable Rust provider slice with `npm run test:providers`.
Run the internal vault/task/provenance bridge with `npm run test:provider-runtime`.
Run its Rust-to-TypeScript record proof with `npm run test:provider-runtime-interop`.
Run its incremental streaming parser with `npm run test:provider-streams`.
