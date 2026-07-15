# Adversarial run record API

**Contract version:** 1. **Runtime status:** structural schema and plan-relative validator
implemented; multi-model orchestration and quality benchmarking are contract-only.

Syzygy publishes its adversarial evidence record so researchers, plugins, headless harnesses, and
independent reviewers can inspect the same artifact without depending on the React application or a
particular model provider.

## Canonical artifacts

- JSON interchange: `schemas/syzygy-adversarial-run-v1.schema.json` (JSON Schema Draft 2020-12).
- TypeScript record and semantic validator: `../frontend/src/extensions/adversarialRunRecord.ts`.
- Deterministic plan: `../frontend/src/extensions/adversarialProtocol.ts`.
- Headless discovery: call MCP tool `syzygy_platform_contracts` and read
  `adversarialRunRecordSchema` plus `adversarialProtocol`.

The repository files are authoritative for a source checkout. The MCP payload is authoritative for
the installed executable being inspected, which lets an external tool detect version drift.

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

The adversarial suite compiles the public schema in strict Draft 2020-12 mode against the typed
valid fixture and hostile identity, reasoning, accounting, and mutation cases. The semantic suite
then exercises plan-relative invariants. The MCP harness proves the installed/headless contract
contains the same schema. None of these commands calls a paid model API.
