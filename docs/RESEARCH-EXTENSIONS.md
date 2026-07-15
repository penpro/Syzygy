# Adversarial research and extension evidence

**Status:** contract foundation, adversarial run-record validator, injected headless phase runner,
provider request/stream conformance, credential vault, and plugin certifier implemented; product
adversarial execution and plugin loading are not yet implemented. **Research date:** 2026-07-14. This document records the
evidence behind the design so another person or model can challenge it.

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

The execution record must eventually include provider, model, endpoint class, prompt/protocol
version, sampler controls, seed where supported, start/end time, token/cost counters, cancellation,
retention class, source snapshot identifiers, every raw candidate, every judgment, disagreement,
and the human decision. Hidden chain-of-thought is neither requested nor stored; provider-visible
reasoning summaries may be retained only when the provider explicitly returns them as output.

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
responsibilities and cannot be inferred from schema success. See `ADVERSARIAL-API.md`. The
The injected runner now executes this phase graph against a caller-supplied executor, sanitizes
failures, preserves route identity outside judge payloads, emits a content-free execution ledger,
and runs the equal-call baseline. Its synthetic tests contact no model. A product executor, batch
native disclosure, workflow persistence/UI, public benchmark corpus, live-provider evidence, and
quality statistics remain unimplemented.

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
