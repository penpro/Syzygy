# Research-use and adversarial-panel literature notes — 2026-07-15

**Scope:** public requirements research only. No PolicyPad/Tiptap code, prompts, schemas, fixtures,
assets, or private behavior were used. These notes constrain future Syzygy experiments; they do not
claim that a paper's benchmark result generalizes to policy research.

## Sources checked

- W3C, [PROV-O: The PROV Ontology](https://www.w3.org/TR/prov-o/) — interoperable provenance uses
  explicit entities, activities, agents, and qualified relationships.
- Du et al., [Improving Factuality and Reasoning in Language Models through Multiagent
  Debate](https://arxiv.org/abs/2305.14325) — reports task-specific gains from repeated independent
  proposals/debate; it is positive evidence for testing debate, not evidence that agreement is truth.
- Chen et al., [ReConcile: Round-Table Conference Improves Reasoning via Consensus among Diverse
  LLMs](https://arxiv.org/abs/2309.13007) — treats model diversity as an experimental factor and
  reports benchmark gains from confidence-weighted multi-model discussion.
- Wu et al., [Can LLM Agents Really Debate? A Controlled Study of Multi-Agent Debate in Logical
  Reasoning](https://arxiv.org/abs/2511.07784) — reports that model capability/diversity dominate
  structural tweaks and that majority pressure can suppress independent correction.
- [On scalable oversight with weak LLMs judging strong LLMs](https://arxiv.org/abs/2407.04622) —
  evaluates debate/consultancy with explicit protocols, judge roles, round counts, and task-level
  comparisons rather than treating one panel transcript as a general quality result.

## Requirements derived for Syzygy

1. **Agreement is an observation, never the truth field.** Keep every independent candidate,
   critique, source audit, minority finding, and judge artifact. A shared draft changes only after a
   person reviews a diff and accepts it.
2. **Blind before judging.** Provider/model routes stay in a separate ledger; judges receive stable
   candidate IDs. Reverse candidate order and preserve both judgments so positional instability is
   visible.
3. **Measure diversity rather than branding it.** Compare heterogeneous and same-model panels under
   equal call budgets. Record provider/model/version, but do not infer epistemic independence from
   different vendor names.
4. **Protect independent correction.** Generate candidates before cross-agent exposure; do not show
   vote totals or confidence during the initial judgment. Retain supported minority findings even
   when every other participant disagrees.
5. **Require source-level audit.** A candidate or critique must point to frozen source snapshot IDs;
   the audit records support/contradiction/absence per claim. Unsupported consensus remains
   unsupported.
6. **Keep a compute-matched baseline.** Panel quality must be compared with an equal-call independent
   sampling baseline and reported with failure, latency, token, and cost accounting.
7. **Make provenance portable.** Future export should map Syzygy records cleanly to the W3C
   entity/activity/agent distinction without changing the internal CRDT schema or exposing hidden
   reasoning.

## Falsification gates

- A shuffled-label test must show that provider identity cannot be reconstructed from judge input.
- An order-swap fixture must fail if only one ordering is retained or instability is hidden.
- A majority-pressure fixture must retain a source-supported minority correction.
- Same-model and heterogeneous panels must run with equal actual call counts before diversity gains
  can be reported.
- A provenance export fixture must preserve source snapshot, actor, activity, generated artifact,
  timestamp, and parent/reference identity across export/import.
- No superiority claim is permitted until a preregistered domain corpus has human reference labels,
  uncertainty intervals, ablations, and a held-out evaluation.

## Roadmap effect

The existing adversarial contracts already implement blinding, order swap, minority retention,
source audit, equal-call baseline accounting, and human-gated mutation at the schema/headless-runner
level. The next implementation work is therefore not another consensus prompt: it is the scoped
provider executor, frozen project/source binding, failure-complete run persistence, and a real
policy-research benchmark with preregistered falsifiers.
