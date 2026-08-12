# Model provider API

**Contract version:** 1. **Runtime status:** local inference remains available; OpenAI Responses,
Anthropic Messages, Gemini Interactions, and xAI Responses request, stream, and non-executing custom
tool proposal controls are at `request-stream-and-schema-validated-tool-proposal-conformance`.
Each built-in adapter also has fake-server conformance for one separately authorized, bounded native
exact-source locator continuation. Ordinary remote review and content-bound adversarial execution
use registered Rust commands, OS-vault credentials, fixed built-in endpoints, native disclosure,
bounded timeout/cancellation, normalized results, and content-free run records. Tests use
loopback providers only; no live-provider compatibility or quality claim is made. Custom remote
adapters remain contract-only.

The adversarial path uses one native batch decision. Its request contains the exact research
question, frozen source objects, complete call graph, provider/model routes, dependencies,
presentation order, per-call execution limits, route ceilings, and total ceiling. Rust validates
the compute-matched protocol and hashes the exact research bytes before displaying route/count/
retention information. Approval creates a random 30-minute process-memory capability; denial
stores nothing.

Each call is atomically consumed before vault/network access. Rust rechecks the run, exact research
digest, planned call, dependencies, route, and remaining budgets. Dependency outputs must match
the SHA-256 recorded from successful earlier calls. Rust derives phase prompts, uses only built-in
provider endpoints, and accepts only strict phase-specific JSON without private-reasoning fields.
Failures and malformed outputs remain consumed; only successful validated output becomes a
dependency. Status is content-free and revocation is explicit.

The frontend product executor exposes this path through a deterministic blinded runner and
resumable MCP jobs. MCP source selection is restricted to exact indexes from the current live
document revision, start returns immediately, heartbeats occur every 30 seconds, the absolute
deadline is 15 minutes, and cancellation reaches the native provider registry. Results remain
pending human review and never modify shared state automatically.

Conformance evidence is recorded in
`docs/audits/runs/ADVERSARIAL-NATIVE-EXECUTION-2026-07-29.json`. Earlier authorization and
reservation artifacts remain useful historical checkpoints but their “no executor” limitations
are superseded.

The callable command takes `ProviderResearchTaskRequest`, not a raw provider request. Its fields are
run/call/task identity, provider/model/bounds, an optional developer instruction, a research
question, zero or more `{ snapshotId, label, excerpt }` sources, and an optional bounded list of
custom function definitions. Rust JSON-serializes the research payload into the normalized provider
input and derives `task instructions`, `research question`, and `selected source excerpts and labels`
categories only when the corresponding content exists. When function definitions exist it also
derives `tool names, descriptions, and argument schemas`; the webview cannot hide that outbound
content from the native disclosure.
Source IDs in the run record come only from those source objects and must be unique. The frontend
cannot attach unrelated provenance or downgrade the native disclosure description.

The canonical TypeScript contract is `frontend/src/extensions/providerContract.ts`. It prevents
research workflows from depending on a vendor response shape and keeps provider availability
separate from provider capability.

Every native invocation must also produce the content-free public record defined by
`docs/schemas/syzygy-provider-run-v1.schema.json` and
`frontend/src/extensions/providerRunRecord.ts`. The record links a call to frozen source snapshot
IDs and input/output hashes without embedding prompts, outputs, provider errors, or credentials.
It records adapter status, task type, bounds, destination, disclosure approval, policy review,
storage request, typed zero-retention attestation, terminal state, token usage, and cost. The
semantic validator rejects cross-field lies that JSON Schema cannot express, including an
undisclosed remote call, HTTP remote endpoint, false ZDR claim, output attached to a failed call,
or inconsistent token total. Native source-locator runs additionally record a paired continuation
turn (`0` through `4`) and a content-free thread hash; both fields are optional so older v1 records
remain valid, while half-formed or streamed continuation metadata fails validation. MCP publishes
the exact schema and truthful validator status.

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

## Custom proposals and the native source locator

Remote research requests may include at most 32 custom function definitions. Names are unique,
1–64 ASCII letters/numbers/underscore/hyphen; descriptions are printable and at most 4,096
characters; each parameter schema is a JSON object rooted at `type: "object"`, at most 64 KiB,
with a 256 KiB aggregate schema ceiling. OpenAI/xAI receive Responses function objects, Anthropic
receives `input_schema`, and Gemini Interactions receives `type: "function"` objects. Tool choice
is automatic; no built-in/server-side tools are enabled by this surface.

Provider output becomes the same `tool-call-start`, `tool-call-delta`, and `tool-call-complete`
lifecycle. OpenAI arguments are assembled from documented deltas; Anthropic `partial_json` is
assembled and parsed only at block stop; Gemini's complete function-call step and xAI's documented
whole-call chunk are represented as one bounded delta. Calls are capped at 32, arguments at 256
KiB each and 1 MiB total, IDs/names must match across events, final JSON must be an object and must
equal the accumulated fragments, and unfinished/orphan/duplicate/malformed calls fail closed.

Custom definitions are deliberately proposal-only. Syzygy displays the function name, call ID, and
arguments in a transient **inspect only · not executed** panel. They have no tool-result loop and grant no MCP,
Drive, filesystem, plugin, editor, network, or shared-project mutation authority. Tool bodies are
present in the transient result but remain absent from content-free run records; the record's
`outputSha256` nevertheless commits to both normalized text, proposal bodies, and their validation
state.

Definitions are accepted only from a bounded non-executable JSON Schema subset: single string
`type`; `properties`/`required`; boolean `additionalProperties`; one `items` schema; bounded
object/array/string lengths; numeric minimum/maximum; `enum`/`const`; and inert annotation keywords.
Schemas are capped at depth 12, 2,048 nodes, 128 properties per object, 256 enum values, and the byte
ceilings above. `$ref`, remote references, patterns/formats, conditionals, combinators, unevaluated
keywords, schema-valued `additionalProperties`, and unknown keywords are rejected before native
disclosure or transmission. This deliberately excludes regex denial-of-service and reference/
branch expansion from the current surface.

After complete argument assembly, Rust validates the exact normalized object against the matching
definition and authors `schemaStatus` as `valid`, `invalid`, or `missing-definition`, with at most
eight bounded path/keyword diagnostics. The frontend independently preflights definitions with the
pinned AJV 2020 implementation and validates completed streaming proposals for immediate display.
`pending` is display-only while a call is incomplete. Every custom result separately reports
`domainStatus: unreviewed` and `executable: false`: schema success is structural evidence, not a
semantic judgment, permission grant, or execution capability.

The only executable provider tool is host-owned
`syzygy_locate_exact_source_text`. A researcher must opt in separately; a custom definition cannot
shadow its reserved name. It performs a case-sensitive literal search over only the exact
`{ snapshotId, label, excerpt }` objects already frozen into and disclosed for that request. The
model supplies printable exact text of 1–256 characters and may request 1–10 matches. Results retain
at most 240 Unicode characters of context on each side and 32 KiB total. The tool cannot fetch a
new Drive object or use the filesystem, MCP, plugins, editor, network, or shared mutation APIs.

Tool-enabled requests use the one-shot path. Rust retains provider output/reasoning carriers only in
native process memory, binds every result to the provider-issued call ID, and replays the full
provider-specific conversation with storage disabled instead of trusting server-side response or
interaction IDs. Pending state is limited to 32 threads, expires after ten minutes, disappears on
restart, stops after four continuation turns, and rejects replay above 8 MiB or 256 items before it
can enter pending state. A fresh native **Send results once** disclosure is
required for every result transmission; state is consumed before network dispatch. Source mismatch,
invalid arguments, unreviewed custom calls, mixed executable/non-executable proposals, reserved-name
spoofing, expiry, stale pending-generation replacement, and replay-shape mismatch fail closed. A
cancelled result disclosure keeps the reviewed proposal available until that exact pending turn
expires. Fake servers prove the OpenAI/xAI
`function_call_output`, Anthropic `tool_result`, and Gemini `function_result` carriers and exact call
binding. Packaged native-dialog behavior and opt-in live-provider compatibility remain unverified.

Primary contracts: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic tool handling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls),
[Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling),
[Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview), and
[xAI function calling](https://docs.x.ai/developers/tools/function-calling).
Schema semantics and frontend settings were checked against
[JSON Schema Draft 2020-12 validation](https://json-schema.org/draft/2020-12/json-schema-validation.html)
and the [AJV options contract](https://ajv.js.org/options); the product intentionally implements
only the narrower subset above.
Adversarial fixtures, exact limits, implementation anchors, and non-claims are recorded in
`docs/audits/runs/PROVIDER-TOOL-PROPOSALS-2026-08-11.json`.
Cross-language schema-validation fixtures and the remaining domain/authority gap are recorded in
`docs/audits/runs/PROVIDER-TOOL-SCHEMA-VALIDATION-2026-08-11.json`.
The native continuation wire fixtures, hostile authority cases, limits, and non-claims are recorded
in `docs/audits/runs/PROVIDER-SOURCE-LOCATOR-CONTINUATION-2026-08-11.json`.

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
- An adversarial batch authorization binds exact research bytes, the complete call graph,
  built-in provider/model routes, dependencies, judge order, execution limits, route budgets, and
  total budget for a fixed expiration. Atomic reservation consumes a call before vault/network
  access; prior output bytes must match recorded SHA-256 values; failures cannot be replayed.
- The resumable MCP surface derives sources only from an exact live-document revision and selected
  block indexes. It grants no arbitrary prompt, endpoint, credential, Drive, filesystem, or shared
  mutation authority.
- The native source locator searches only already-disclosed frozen excerpts, uses provider-issued
  call IDs, retains replay only in process memory, and requires a fresh native disclosure per turn.
  It grants no general custom-tool or external-resource authority.
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
events, distinguishes sanitized provider failure, and cancels between events. The product
runtime now routes that stream through one ordered per-call Tauri channel, accumulates the same
bounded normalized response in Rust, removes the cancellation registration on every terminal path,
and marks the authoritative content-free run record as streamed. The workspace renders OpenAI,
Anthropic, Gemini, or xAI text, usage, warnings, and custom proposal calls incrementally as a
transient review. The separately enabled native exact-source locator uses one-shot continuation;
neither path applies a response to the shared draft automatically.
No live service has been contacted. `syzygy_platform_contracts` reports aggregate status as
`native-disclosure-openai-anthropic-gemini-xai-stream-schema-validated-custom-tool-review-bounded-source-locator-continuation-no-live-proof`.

The incremental OpenAI SSE decoder accepts arbitrary byte fragmentation, including split Unicode;
joins multiline `data:` fields; ignores keepalives; validates optional SSE event labels against
the JSON event type; emits normalized start, text, usage, finish, error, and end events; preserves
unknown future types as warnings; strips provider error messages; and bounds pending frames to one
MiB. Malformed JSON, label mismatch, partial usage, oversized frames, and truncated streams fail
closed. Function-call item start, fragmented argument delta, completion, duplicate confirmation,
JSON/body bounds, and incomplete lifecycle are normalized fail-closed. The bounded native exact-source
locator has fake-server-only one-shot `function_call`/`function_call_output` continuation evidence;
arbitrary/custom execution, streamed continuation, retry semantics, slow-consumer stress, and reconnect
remain open. Cancellation covers the complete one-shot request/body future and the fake-network stream
through normalized event dispatch. Product wiring preserves that boundary through a scoped ordered
channel; slow-consumer/backpressure stress, reconnect, retries, and duplicate-event policy remain open.

The credential-vault boundary uses `keyring` 3.6.3 (MIT/Apache-2.0; MSRV 1.75) with native Windows,
macOS, and persistent Linux backends. Provider secret strings zeroize on drop. The ordinary suite
uses an in-memory trait implementation; `npm run test:credentials:live` creates a random canary in
the current OS credential store, reads it back, deletes it, and verifies absence without printing
the canary. Credential-only Tauri commands and `tauri.ts` wrappers now set, report presence, or
delete the default provider key without returning it. A collapsed Settings surface supports all
four providers with a password field that is never placed in React/store state and is cleared
before the asynchronous write completes. Saving does not transmit research. macOS/Linux live
evidence, transient DOM/heap leak tests, and live provider workflow proof remain open. Dependency provenance is
recorded in `docs/audits/EXTENSION-PROVENANCE.md`.

The Anthropic Messages slice is Rust-owned and fake-server-only. One-shot evidence proves the exact
`/v1/messages` endpoint, `x-api-key`, `anthropic-version: 2023-06-01`, content type, separate system
text blocks, user messages, `max_tokens`, and `stream:false`. The native SSE path sends
`stream:true`, requires `text/event-stream`, bounds aggregate bytes, and normalizes
`message_start`, text deltas, cumulative usage, stop reason, warnings, sanitized errors, and
`message_stop` through the same ordered runtime channel used by the product review. Ping and
content-stop events are harmless; unknown event types remain visible warnings. Thinking and signature
bodies are never copied into normalized events or run records. Tool input fragments are copied only
into the bounded transient proposal lifecycle and remain absent from run records. The decoder rejects
label/type mismatch, decreasing cumulative usage, malformed/truncated lifecycle, and missing
terminal events. The normalizer computes overflow-safe total usage, maps refusal to a sanitized
marker, and shares the disclosure, timeout, cancellation, TLS/loopback, and error-redaction gates.
Arbitrary/custom tool execution, streamed tool continuation, beta headers, upstream request IDs
beyond the message ID, live policy validation, packaged native-dialog interaction, and opt-in live
proof remain open. The bounded native exact-source locator has fake-server-only one-shot
`tool_use`/`tool_result` continuation evidence.

The Gemini slice targets the stable `/v1/interactions` API rather than silently following an SDK's
preview default. One-shot fake-server evidence proves `x-goog-api-key`, content type, model, joined
local system/user text, `generation_config.max_output_tokens`, `thinking_summaries:none`,
`stream:false`, `background:false`, and `store:false`. The SSE path sends `stream:true` plus
`Accept:text/event-stream` while retaining the same storage/background/thought-summary controls.
It normalizes `interaction.created`, indexed `step.start/delta/stop` model-output text, final usage,
terminal status, sanitized errors/warnings, and `[DONE]` through the ordered product channel.
Initial text in `step.start` and later text deltas are both retained. Step indexes are unique and
bounded to 1,024; orphan/duplicate steps, mismatched interaction identity, malformed totals,
label/type mismatch, unfinished steps, missing terminal events, and oversized streams fail closed.
Thought summaries/signatures remain content-free warning types only. Complete `function_call` steps
become bounded proposal lifecycles; the one-shot normalizer retains text and function proposals and accepts
usage only when total tokens cover input plus output. The endpoint, disclosure, byte bound,
redaction, timeout, and cancellation gates match the other remote slices. Arbitrary/custom tool
execution, streamed continuation, structured output, stored state, live terms validation, packaged
dialog interaction, and opt-in live proof remain open. The bounded native exact-source locator has
fake-server-only one-shot `function_call`/`function_result` continuation evidence, with the exact
provider-issued call ID and raw required step carriers retained only in native memory.

The xAI slice deliberately reuses only the compatible Responses event grammar, not OpenAI privacy
assumptions. One-shot and SSE requests send bearer auth to `/v1/responses`, force `store:false`, and
omit `previous_response_id`, `prompt_cache_key`, and conversation-routing headers. SSE additionally
sends `stream:true` plus `Accept:text/event-stream`, shares the 32 MiB aggregate ceiling and complete
timeout/cancellation future, and reports xAI as the normalized provider. Every successful response
must include xAI's boolean `x-zero-data-retention` header; streaming validates it before dispatching
the first event, and the typed outcome/content-free run record expose whether enterprise ZDR was
actually active instead of treating `store:false` as ZDR. Text, usage, terminal status, sanitized
errors, and `[DONE]` use the provider-neutral Responses normalizer. Documented whole custom-function
calls become one bounded start/delta/complete proposal; unsupported built-in/reasoning events surface
only their type as a warning and reasoning bodies are omitted from normalized output and run
records. xAI's primary streaming, function, and security documentation was rechecked on 2026-08-11.
The bounded native exact-source locator retains the opaque raw one-shot response only in native
memory and replays it with exact call binding and `store:false`. Arbitrary/custom tool execution,
streamed continuation, WebSocket mode, slow-consumer/retry semantics, cost ticks, packaged dialog
interaction, and opt-in live proof remain open.

Primary xAI sources: <https://docs.x.ai/developers/model-capabilities/text/streaming>,
<https://docs.x.ai/developers/tools/overview>,
<https://docs.x.ai/developers/tools/function-calling>, and
<https://docs.x.ai/developers/faq/security>.

The review UI defaults are editable convenience values, not capability guarantees: `gpt-5.2`,
`claude-sonnet-5`, `gemini-3.5-flash`, and `grok-4.5`. They were checked against each provider's
official model documentation on 2026-07-15. Researchers can replace them with another model ID
available to their account; provider-side availability is still validated only by the request:

- <https://platform.openai.com/docs/api-reference/models/object>
- <https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions>
- <https://ai.google.dev/gemini-api/docs/models>
- <https://docs.x.ai/developers/models/grok-4.5>

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
