# Adversarial review API

**Contract version:** 1. **Runtime status:** native multi-provider execution, resumable MCP
jobs, explicit collaborative archival, immutable human accept/reject history, exact retained-event
registered-device attribution with explicit unsigned fallback, and the product
configuration/history/decision workflow are implemented and conformance-tested against loopback
providers, in-memory Yjs peers, and headless React rendering. Results remain pending human review
and never mutate the shared draft automatically. Packaged native-dialog interaction, live
paid-provider compatibility, physical two-install archive interaction, and research-quality
superiority remain unproved.

Syzygy publishes its adversarial evidence record so researchers, plugins, headless harnesses, and
independent reviewers can inspect the same artifact without depending on React or a provider SDK.

## Canonical artifacts

- Public record: `schemas/syzygy-adversarial-run-v1.schema.json` and
  `../frontend/src/extensions/adversarialRunRecord.ts`.
- Deterministic protocol: `../frontend/src/extensions/adversarialProtocol.ts` and
  `../frontend/src/extensions/adversarialRunner.ts`.
- Frozen native call graph: `../frontend/src/extensions/adversarialNativePlan.ts`.
- Native frontend executor: `../frontend/src/extensions/adversarialNativeExecutor.ts`.
- Resumable job registry: `../frontend/src/extensions/adversarialAutomation.ts`.
- Collaborative archive and decision ledger: `../frontend/src/extensions/adversarialHistory.ts`.
- Product configuration, transient-job, evidence-history, and decision adapter:
  `../frontend/src/workspace/AdversarialReviewWorkspace.tsx`.
- Native authorization, transport, output validation, and dependency hashes:
  `../frontend/src-tauri/src/provider_runtime.rs`.
- Headless entrypoints: MCP tools `start_adversarial_review`,
  `inspect_adversarial_review`, `cancel_adversarial_review`,
  `save_adversarial_review`, and `decide_adversarial_review`.
- Installed-runtime discovery: `syzygy_platform_contracts`.

Repository files are authoritative for a checkout. The MCP payload is authoritative for the
installed executable being inspected, allowing external reviewers to detect version drift.

## Native execution boundary

For `N` participants, one authorization freezes `N` independent proposals, `N` cyclic
cross-critiques, one evidence audit, two order-swapped judgments, and a separate `2N + 3` call
baseline. The authorization binds the exact question/source bytes, call IDs, phase order,
provider/model routes, dependencies, judge presentation order, final-pass flag, per-call timeout,
per-call output ceiling, route budgets, and total budget. Any change requires a new native
disclosure decision.

Rust stores the approved scope as a random 256-bit, process-memory capability for at most 30
minutes. It reads no credential before a call is atomically reserved. Reservation consumes a call
ID and both budgets once, checks that every dependency completed, and compares the caller-supplied
upstream bytes with the SHA-256 recorded for the authorized prior output. A transport failure,
timeout, cancellation, malformed JSON result, or unsafe result shape remains consumed and cannot
be replayed. Only a successful strict result is recorded as a later dependency.

Rust—not the webview—constructs phase instructions and the serialized research task, retrieves the
OS-vault credential, selects a built-in fixed provider endpoint, applies timeout/cancellation, and
authors a content-free provider run record. Provider output must be strict phase-specific JSON and
must not contain private-reasoning keys. The frontend forwards only the exact raw bytes returned by
completed dependencies, validates the public result shape again, keeps provider routing outside
judge-visible artifacts, and revokes the batch capability in a `finally` path.

The base runner still owns phase isolation, blinding, bounded artifacts, compute matching,
minority retention, semantic record validation, and the pending human decision. It has no shared
mutation authority. The implemented accept/reject ledger records human judgment only. A future
apply workflow must be a separate explicit proposal operation that independently rechecks the live
document revision and retains attribution.

## Resumable MCP job contract

`start_adversarial_review` accepts an exact live document revision and 1–200 block indexes; the
webview derives source snapshots from those live blocks, so an MCP caller cannot substitute
arbitrary source bytes. It allows only the four built-in remote-provider IDs and returns a job
immediately. At most eight jobs run at once. Jobs heartbeat every 30 seconds, abort at an absolute
15-minute deadline, and retain terminal state for one hour.

`inspect_adversarial_review` returns bounded lifecycle metadata while running and the validated
pending result when complete. `cancel_adversarial_review` aborts the shared signal, which invokes
the native call cancellation path. These tools provide explicit model authority only for this
revision-guarded workflow; they do not grant general Drive, filesystem, credential, arbitrary
endpoint, prompt, or project-mutation authority.

## Collaborative archive and decision contract

Completed jobs remain transient until an explicit `save_adversarial_review` call. Saving requires
the exact current Yjs research revision and caller attribution. It writes a canonical SHA-256
archive containing the original question, selected source excerpts, validated result, baselines,
call ledger, and content-free provider provenance into the existing provider-neutral
`project:discussions` collection. A Drive-backed project can therefore synchronize that full
research content to collaborators. No persisted Zustand shape changed, so no migration was
required.

Archives are limited to 32 MiB each and 2,000 per project. Peer-namespaced internal keys preserve
same-run collisions so reads fail closed instead of choosing one. Decode revalidates the request,
reconstructs the exact native plan, rechecks source order, public run semantics, every planned call,
and every strict provider provenance record before accepting the canonical hash.

`decide_adversarial_review` is separate. It requires the exact research revision, archive hash,
and current decision event (or null for the first decision), then appends one immutable
accepted/rejected event. Exact retries are idempotent. Concurrent branches remain in Yjs and make
the decision conflicted; no timestamp winner is selected. Up to 20,000 bounded events are retained.
After either mutation commits, Syzygy best-effort signs the exact retained record with an
unconflicted project-registered installation key for its stored participant. Archive attribution
hashes the complete strict envelope; decision attribution hashes the run/archive identity, exact
parent, judgment, participant/display name, notes, and timestamp. Distinct archive and
length-prefixed decision locators make retained re-resolution unambiguous. Correctly signed
cross-author claims and changed stored bodies fail verification. Signing failure leaves history
committed and returns an explicit bounded unsigned reason; MCP returns the post-attribution
research revision. Neither saving nor deciding reads or changes the Lexical draft. Routine
`inspect_research_state` returns only IDs, hashes, counts, attribution metadata, decision state,
and integrity issues; question, source, result, decision-note, proof, public-key, signature, and
display-name bodies are omitted. Installation signatures prove device-key possession, not a person,
organization, truth, consensus, or consent.

## Product workflow contract

The workspace product surface reuses the same registry and ledger as MCP. It selects exact live
semantic blocks from one displayed editor revision, supports two to eight configurable perspectives,
and shows the deterministic `4N + 6` total call count before native approval. It preflights only
whether each required OS-vault credential exists. The authoritative native approval still freezes
the full content-bound graph.

The running view polls bounded job metadata, names the 30-second heartbeat and absolute deadline,
and uses the shared cancellation path. Completion does not persist automatically. **Share full
review with project** separately writes the complete canonical archive and explicitly warns that a
Drive project may deliver it to collaborators. The product can then inspect frozen sources,
proposals, critiques, claim audit, minority findings, baseline outputs, route provenance, accounting,
and decision history. Invalid or branched state disables decisions and remains visibly conflicted.
Evidence categories are lazy and opened lists, including nested proposal claims, render deterministic
50-item pages, so hidden bodies do not enter the DOM merely because an archive was selected. Accept/reject appends history only;
there is deliberately no Apply control or editor mutation path. Archive and decision actions remain
busy through their post-commit attribution check, render pending/signed-device/explicit-unsigned
status, and suppress a late result after a project or selected-run change.

Headless product tests cover exact source selection, panel/call bounds, disclosure copy, evidence
classes, provenance separation, and absence of an apply action. Domain convergence, stale-write,
tamper, branch, and no-editor-mutation tests remain authoritative for shared writes. The bounded
run and honest limitations are recorded in
`audits/runs/ADVERSARIAL-PRODUCT-WORKFLOW-2026-07-30.json`,
`audits/runs/ADVERSARIAL-EVIDENCE-PAGING-2026-07-31.json`, and
`audits/runs/SIGNED-ADVERSARIAL-REVIEW-EVENTS-2026-08-11.json`.

## Validation pipeline

1. Validate untrusted JSON against the public schema. This rejects missing/unknown fields,
   provider or model identity added to blinded artifacts, hidden-reasoning fields, oversized
   strings/arrays, unsafe numeric accounting, and structurally unguarded shared mutation.
2. Reconstruct the exact deterministic `AdversarialRunPlan` for the run.
3. Call `validateAdversarialRunRecord(plan, record)`. This checks relationships that the standalone
   schema cannot know: exact candidate coverage, one critique per planned candidate, claim/source
   membership, planned reversed judge order, equal panel/baseline calls, supported-minority
   retention, and human/revision authorization.
4. Only after both layers pass, compute descriptive metrics with
   `adversarialRunMetrics(plan, record)`.
5. Treat the record as evidence about protocol execution, never as proof that its synthesis is
   correct or superior. Quality claims require the versioned benchmark and statistical review.

## Safety and portability rules

- Candidate and judgment artifacts use blinded candidate IDs. Provider, model, and slot identity
  belong in a separate access-controlled execution provenance record, not this judge-visible file.
- Hidden chain-of-thought is not requested or accepted. Store concise provider-visible answers,
  critiques, evidence verdicts, and human notes only.
- `sourceSnapshotIds` identify frozen evidence inputs. A source changing later must create a new
  snapshot and run, not silently alter the old record.
- `sharedMutation.applied: true` requires an accepted human decision, proposal identity, expected
  revision, and applied revision. Consumers must still recheck the live target revision.
- JSON Schema validation is structural. It does not grant Drive, project, network, model, or plugin
  authority and does not replace domain validation.

## Self-check

From `frontend`:

```powershell
npm run test:adversarial
npm run test:contracts
npm run test:mcp
npm run audit
```

The adversarial suite compiles the public schema in strict Draft 2020-12 mode, exercises the
full phase graph, route/budget/dependency/order forgery cases, exact upstream-byte forwarding,
malformed/private-reasoning/usage-free output rejection, cancellation, and the resumable job
lifecycle. Rust loopback tests exercise the same native executor used by the Tauri command and
prove secret/content/authorization-token exclusion from run records, atomic duplicate refusal,
and malformed-output fail-closed consumption. The MCP harness requires all 46 semantic tools and
clean stdio. Collaborative-history tests cover identical-peer convergence, same-run archive
conflicts, stale zero-write refusal, provider-provenance tampering, hostile nested records,
idempotent decision replay, concurrent decision branches, exact archive/decision hashes,
cross-author rejection, changed-retained-body rejection, explicit unsigned preservation, and
content-minimized attestation inspection.

None of these checks calls a paid provider. They establish local conformance and security
properties, not provider availability, policy compliance, output correctness, or superiority.
