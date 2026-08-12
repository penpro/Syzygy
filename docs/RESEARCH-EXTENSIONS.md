# Adversarial research and extension evidence

**Status:** native content-bound adversarial execution, resumable MCP orchestration, explicit
collaborative archival, and immutable human decision history are implemented with loopback/Yjs
conformance evidence; bounded zero-import component execution plus explicit session loading and
shared proposal review, persistent signed-package lifecycle, and explicit attributed Apply are
implemented, while capability-bearing hosts remain unimplemented.
**Research date:** 2026-07-14; implementation evidence updated 2026-08-11. This document records
the evidence and falsifiers so another person or model can challenge both the design and claims.

## Claim under test

Using several models can expose errors and blind spots that a single answer misses, but merely
adding agents or debate rounds does not establish higher quality. Syzygy should make disagreement,
evidence, cost, and failure visible and should preserve a compute-matched single-model baseline.

## Literature findings and counterevidence

| Finding | Evidence | Design consequence | Falsifier |
|---|---|---|---|
| Multi-agent debate can improve factuality and reasoning on some tasks. | Du et al., [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325) | Support independent proposals and critique. | A representative Syzygy benchmark shows no gain over a matched baseline. |
| Debate often fails to beat Chain-of-Thought or self-consistency after accounting for inference compute; model heterogeneity is more consistently useful. | Zhang et al., [Stop Overvaluing Multi-Agent Debate](https://arxiv.org/abs/2502.08788) | Prefer different provider/model families, disclose homogeneity, and run an equal-call baseline. | Heterogeneous panels repeatedly underperform a homogeneous or single-model baseline on held-out tasks. |
| Evidence-focused role separation can improve faithfulness of fact-check explanations. | Kim et al., [Faithful Explainable Fact-Checking via Multi-Agent Debate](https://arxiv.org/abs/2402.07401) | Give evidence audit a separate phase and retain unsupported-claim labels. | Human source checking finds the evidence-audit pass increases unsupported claims. |
| LLM judges exhibit position, verbosity, and self-enhancement bias. | Zheng et al., [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685); Shi et al., [Judging the Judges](https://arxiv.org/abs/2406.07791) | Blind provider identity, reverse candidate order, record both judgments, and escalate unstable rankings to humans. | Swap tests show no measurable bias across the supported benchmark, allowing the extra pass to become optional. |

The papers above are not proof that the proposed protocol works for policy research. They motivate
tests. Every release must distinguish benchmark results from product claims.

## Protocol v1

The pure planner in `frontend/src/extensions/adversarialProtocol.ts` emits:

1. independent proposals that cannot see one another;
2. cross-critiques;
3. a source/evidence audit;
4. two blinded judge passes with reversed candidate order;
5. a minority report that synthesis cannot discard silently;
6. explicit human acceptance before shared-state mutation; and
7. a single-agent/self-consistency baseline with the same model-call budget.

The combined run evidence separates provider/model/endpoint/disclosure/retention/usage provenance
from blinded research artifacts. It retains protocol version, source snapshot identities, every
candidate and judgment, disagreement/minority disposition, compute-matched baseline, and the human
decision; sampler and seed fields are recorded only when the provider exposes trustworthy values.
Hidden chain-of-thought is neither requested nor stored; concise provider-visible reasoning belongs
only in an allowed public result field.

The public interchange shape is `docs/schemas/syzygy-adversarial-run-v1.schema.json` (Draft
2020-12, strict unknown-field rejection) and is embedded in the headless
`syzygy_platform_contracts` MCP result. The typed validator in
`frontend/src/extensions/adversarialRunRecord.ts` makes the core record
gates executable against synthetic fixtures. It requires exact blinded candidate coverage, one
cross-critique per candidate, evidence audit coverage for every claim, source-snapshot identity,
the two planned reversed judge orders, equal actual call budgets, explicit minority disposition,
retention of supported minority findings, finite token/cost accounting, and revision-guarded human
acceptance before shared mutation. It rejects provider/model/slot identity in candidate or judge
artifacts and rejects hidden-chain-of-thought fields. Metrics report support rate, position
stability, minority retention, budget matching, and mutation authorization; they do not score
answer quality. Schema tests prove the typed valid fixture remains portable and reject identity
fields, hidden-reasoning fields, unsafe numeric accounting, and unguarded mutation. Plan-relative
coverage, source membership, equal compute, and minority-retention checks remain semantic-validator
responsibilities and cannot be inferred from schema success. See `ADVERSARIAL-API.md`.

The runner executes this phase graph through a native product executor while keeping routing
outside judge-visible artifacts. Before one disclosure, TypeScript freezes the full call graph,
compute-matched baseline, routes, dependencies, judge order, timeout, and output ceilings. Rust
binds the exact question/source bytes, atomically consumes each planned call, verifies upstream
output hashes, derives phase prompts, reads the OS vault, uses a fixed built-in endpoint, rejects
malformed/private-reasoning output, and records content-free provenance. Loopback tests—not paid
provider calls—prove this boundary.

The MCP surface starts a revision-guarded job from selected live document blocks, returns
immediately, supports bounded inspection and cancellation, heartbeats every 30 seconds, and aborts
after 15 minutes. It never applies the result to shared work. A completed job becomes durable only
through an explicit exact-revision save that stores its full canonical archive in the collaborative
Yjs project; a separate exact-parent event records accepted/rejected human judgment. Routine
inspection returns only content-minimized metadata and integrity. The product now uses the same
registry and ledger for exact source/route configuration, bounded progress and cancellation,
separate full-content sharing, complete evidence inspection, conflict visibility, and immutable
accept/reject history with no draft mutation. Authenticated identity, physical two-install product
interaction, public benchmark corpus, live-provider evidence, scalable worst-case archive rendering,
quality statistics, and any superiority claim remain unimplemented or unproved.

The researcher-plugin side publishes `syzygy:research/plugin@1.0.0` as a zero-import WIT world.
It receives only a bounded optional project snapshot and returns only no-change or typed
revision-guarded proposals. The same envelope is validated in TypeScript and the WIT source is
embedded in the MCP platform contract. Rust now rejects every top-level component import and runs
that exact world with an empty Wasmtime linker, bounded binary/envelope/linear-memory/fuel/time
resources, exact output revalidation, and no WASI dependency. Each run lives in a fresh hidden
child process under a five-second kill-and-reap parent deadline. The Windows hostile-fuel fixture
terminates only that worker and a clean successor still succeeds. This establishes the portable
no-authority execution baseline; package discovery, publisher identity/reputation/revocation,
capability-bearing interfaces, and independently authored third-party behavior remain open. The
signed first-party citation-auditor now supplies useful-but-deliberately-simple executable reference
behavior: it emits a human-review proposal with the invocation's exact project/revision identity,
and a headless gate installs the same package in two isolated local catalogs. Apply is a
separate product/automation action after shared acceptance; it is not a component host capability.
The product now renders declared contribution inventory and the selected title/description through
fixed Syzygy kind labels and plain React text. Hostile markup/URL-shaped fixture text remains inert;
installed-package MCP inspection omits contribution descriptions. Contribution-specific inputs,
package-controlled layout/icons, and importer/exporter file authority remain open.

Machine-readable runtime limits, commands, results, proved claims, and explicit non-claims are in
`docs/audits/runs/PLUGIN-ZERO-AUTHORITY-RUNTIME-2026-08-11.json`.

The product composition now requires a user-selected manifest and exact named component, computes
and rechecks its SHA-256, and keeps active bytes in a bounded current-session registry. Unsigned
packages remain session-only. Durable local installation additionally requires a strict Ed25519
publisher-package signature. A serialized 32-version/128-MiB IndexedDB store retains prior versions,
requires the current publisher key for normal increasing-version upgrades, and accepts a key change
only through the next plugin/version-bound certificate signed by both the established and new keys.
The separate bounded rotation store upgrades legacy databases in place, re-verifies the complete
chain, and maps every version to its key epoch. The package and new certificate commit atomically,
and the lifecycle rechecks exact
manifest/component/signature state before startup activation, enable, upgrade, or rollback. The
checked-in non-executing signer and rotation generator can explicitly create external Ed25519 keys,
matching public proofs, and a dual-signed transition without copying private material into the
package. The fingerprint and rotation chain prove locally observed package continuity, not publisher
identity, reputation, revocation, recovery, or quality. Only requested project
read/propose authority reaches the zero-import run. Returned proposals are published as one
preflighted batch into a shared Yjs ledger with exact component provenance; disconnected decisions
converge and opposite decisions become visible conflicts. Each retained proposal and decision is
then exact-body hashed and best-effort signed by the participant's unconflicted registered
installation; cross-author claims or later body changes fail verification, while unavailable
signing remains explicit and never rolls back history. A separate accepted-review application service
requires exact proposal, decision, research, and document revisions plus an operation-matched full-
replacement confirmation. Append retains the current
blocks and adds one linked review-policy block; replace uses the same final editor guard to create
exactly one linked block. The product requires a second confirmation for full-draft replacement,
and MCP exposes the same content-minimized guarded mutation. The plugin itself never receives Apply
authority. A successful editor write is followed by one exact application event binding its proposal,
accepted decision, document revisions, operation, linked policy, and configured researcher; the event
receives registered-device attribution or explicit unsigned fallback. MCP can inspect content-minimized installed, active, and review state and run only an
already-active package against exact document/research revisions. It cannot change package lifecycle,
load component bytes, or decide a review. Cross-store atomic apply/event commit and proposal editing
remain open. Evidence and falsifiers are in
`docs/audits/runs/PLUGIN-SHARED-REVIEW-2026-08-11.json` and
`docs/audits/runs/SIGNED-PLUGIN-REVIEW-EVENTS-2026-08-11.json`, plus the lifecycle proof in
`docs/audits/runs/PLUGIN-SIGNED-INSTALL-LIFECYCLE-2026-08-11.json`, the rotation proof in
`docs/audits/runs/PLUGIN-PUBLISHER-KEY-ROTATION-2026-08-11.json`, and
the executable signed reference proof in
`docs/audits/runs/PLUGIN-EXECUTABLE-REFERENCE-2026-08-11.json`, plus
the text-only contribution rendering proof in
`docs/audits/runs/PLUGIN-DECLARATIVE-CONTRIBUTIONS-2026-08-11.json`, plus
`docs/audits/runs/PLUGIN-ACCEPTED-APPLY-2026-08-11.json`, and the application-attribution increment in
`docs/audits/runs/SIGNED-PLUGIN-APPLICATION-EVENTS-2026-08-11.json`.

## Benchmark before product claims

Build a versioned fixture corpus with public/licensed source packets and answer keys where
possible:

- claim verification and citation entailment;
- policy option comparison with conflicting evidence;
- quantitative extraction and unit consistency;
- stakeholder and distributional-impact omissions;
- counterargument and red-team generation;
- prompt injection inside a cited document;
- outdated evidence and source supersession;
- ambiguous questions where abstention is correct; and
- long-context distractors.

Score factual support, citation precision/recall, calibrated abstention, material omission,
position-swap stability, minority retention, human preference, elapsed time, tokens, and monetary
cost. Compare local-only, strongest single model, self-consistency, homogeneous panel, and
heterogeneous panel. Report confidence intervals and failures, not one aggregate leaderboard.

## Provider and privacy findings

- OpenAI recommends the Responses API for new work; Responses can use tools and remote MCP and is
  stored by default unless `store: false` is used. API data is not used for training by default,
  while endpoint retention and Zero Data Retention eligibility vary. Sources: [Responses
  migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [data
  controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint).
- Anthropic Messages is application-managed/stateless, supports typed streaming events and client
  tool execution, and has endpoint-specific retention/ZDR rules. Sources: [Messages
  API](https://platform.claude.com/docs/en/api/messages/create), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
  [retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
- Gemini's newer Interactions API stores interactions by default; `store=false` changes which
  stateful/background features can be used. Unpaid-service terms may permit improvement/training
  and human review, while paid-service treatment differs. Sources: [Interactions
  API](https://ai.google.dev/gemini-api/docs/interactions-overview), [terms](https://ai.google.dev/gemini-api/terms),
  [abuse monitoring](https://ai.google.dev/gemini-api/docs/usage-policies).
- xAI exposes a Responses-compatible API, custom tool calls, and a ZDR header/enterprise option;
  ordinary request/response storage may last 30 days. Sources: [function
  calling](https://docs.x.ai/developers/tools/function-calling), [security and
  retention](https://docs.x.ai/developers/faq/security).

These policies are time-sensitive and must be rechecked at adapter release. Syzygy must not reduce
them to a single “private” checkbox. Each provider profile exposes transmission, application-state,
training-use, and zero-retention fields. Local stays the default. Remote execution needs a
task-level disclosure of the selected content categories before the first send.

## Plugin and MCP findings

MCP separates user-controlled prompts, application-controlled resources, and model-controlled
tools. Its tool guidance calls for clear exposure and human denial of actions; annotations from an
untrusted server are not themselves trustworthy. See the [MCP server primitive
overview](https://modelcontextprotocol.io/specification/2025-06-18/server/index), [tools
specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), and
[security guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

WASI starts components without ambient authority and grants capabilities explicitly. That is a
better default for portable third-party code than in-webview JavaScript. Native MCP stdio remains
an advanced trust tier because it is an ordinary process, not a sandbox. Sources: [WASI
introduction](https://wasi.dev/), [WASI capabilities](https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md).

JSON contracts use [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). Structural
validation does not prove semantic safety, so runtime authorization, target re-validation, output
bounds, and human acceptance remain separate gates.

## Adversarial reviewer checklist

An independent reviewer should try to prove:

1. a provider can transmit content without a disclosure or retain state contrary to its profile;
2. a key reaches localStorage, a webview log, crash report, project export, or MCP response;
3. candidate identity or ordering leaks to a judge;
4. the baseline receives less inference budget than the panel;
5. synthesis deletes a supported minority finding;
6. an evaluator scores citation shape rather than source entailment;
7. a plugin can mutate state, Drive, or the network without its declared permission;
8. a stale proposal can overwrite a new revision;
9. an MCP tool overstates a contract-only feature; or
10. reported quality omits cost, latency, failure, or unfavorable fixtures.

Required report format: claim, contradictory evidence, exact file/artifact, severity, smallest
reproduction, and the observation that would resolve the disagreement.
