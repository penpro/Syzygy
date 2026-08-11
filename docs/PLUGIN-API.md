# Research plugin API

**Manifest version:** 1. **Runtime status:** strict schemas/validators, a non-executing package
certifier, a non-executing host authority broker, and a versioned zero-import WIT world now have a
bounded in-memory WebAssembly Component executor, explicit session loader/runner, shared review UI,
and MCP inspect/run tools. Discovery, persistent installation/upgrade/signing, capability-bearing
host interfaces, native-MCP execution, and proposal Apply are not yet implemented.

The API is deliberately contribution-open and authority-closed. Researchers can add tools,
evaluators, importers, and exporters without receiving ambient project, Drive, network, model, or
filesystem access.

## Files and contracts

- Manifest schema: `docs/schemas/syzygy-research-plugin-v1.schema.json`
- Change proposal schema: `docs/schemas/syzygy-plugin-proposal-v1.schema.json`
- Certification plan schema: `docs/schemas/syzygy-plugin-certification-v1.schema.json`
- Provider-run record schema: `docs/schemas/syzygy-provider-run-v1.schema.json`
- Compatible model-adapter schemas: `docs/schemas/syzygy-model-adapter-*.schema.json`
- Runtime validator/types: `frontend/src/extensions/pluginManifest.ts`
- Host authority broker: `frontend/src/extensions/pluginAuthorityBroker.ts`
- Zero-import WIT world: `docs/wit/syzygy-research-plugin-v1.wit`
- WIT invocation/output validator: `frontend/src/extensions/pluginWasiContract.ts`
- Zero-authority component runtime: `frontend/src-tauri/src/plugin_runtime.rs`
- Hostile-worker containment gate: `frontend/src-tauri/tests/plugin_runtime_worker.rs`
- User-selected composition: `frontend/src/extensions/pluginExecution.ts`
- Session package registry: `frontend/src/extensions/pluginPackageRegistry.ts`
- Collaborative review ledger: `frontend/src/extensions/pluginReviewModel.ts`
- Product and MCP composition: `frontend/src/workspace/PluginWorkspace.tsx`,
  `frontend/src/extensions/pluginWorkspaceAutomation.ts`
- Headless package certifier: `scripts/plugin-certifier.mjs`
- Complete interface-only example: `examples/plugins/citation-auditor`
- Machine-readable inspection: MCP tool `syzygy_platform_contracts`

Example:

```json
{
  "schemaVersion": 1,
  "id": "org.example.citation-auditor",
  "name": "Citation auditor",
  "version": "1.0.0",
  "description": "Checks cited claims and proposes a review note.",
  "runtime": {
    "kind": "wasi-component",
    "component": "citation-auditor.wasm",
    "world": "syzygy:research/plugin@1.0.0"
  },
  "permissions": {
    "capabilities": ["project.read", "project.propose", "network.fetch"],
    "networkDomains": ["doi.org", "*.crossref.org"],
    "modelProviders": []
  },
  "contributions": [
    {
      "kind": "evaluator",
      "id": "citation-coverage",
      "title": "Citation coverage",
      "description": "Find claims that lack source support."
    }
  ]
}
```

## Permissions

| Permission | Meaning | Never implies |
|---|---|---|
| `project.read` | receive the selected, bounded project snapshot | filesystem, Drive, keys, other projects |
| `project.propose` | return a revision-guarded typed proposal | direct mutation or automatic acceptance |
| `drive.read` | request a selected-workspace read through Syzygy | raw OAuth token or arbitrary Drive access |
| `drive.propose` | propose a typed Drive operation for confirmation | direct Google mutation |
| `network.fetch` | request HTTPS fetches for declared host patterns | arbitrary hosts, credentials, local/LAN access |
| `model.invoke` | request named configured providers through Syzygy's disclosure and provider-run-record boundary | API keys, undeclared providers, automatic remote transmission |

Permissions are granted per installed plugin and can be revoked. Manifest declarations are
requests, not authority. Syzygy revalidates every operation and target at execution time.
Plugins never construct authoritative provider-run records: the future host records each accepted
model call, including denial, timeout, cancellation, usage, retention attestation, and cost.
Simple compatible endpoints use the separate declarative model-adapter profile and certifier;
arbitrary model protocols require a future capability-bearing WIT host and the same `model.invoke`
authority gate.

## Host authority broker

`ResearchPluginAuthorityBroker` is the executable policy layer that the component product adapter
or a future native-MCP host must call. Opening a 15-minute session requires a schema-valid manifest, an explicit grant
that is a strict subset of the manifest request, and one bounded project/revision/source snapshot.
The broker copies session input so plugin-side mutation cannot alter host state, returns detached
snapshots only with `project.read`, and returns proposals only as `pending-human-review` after
checking plugin ID, project ID, content bounds, and the exact revision.

The broker does not fetch, call a model, read Drive, or mutate a project. It returns narrow
authorizations for a separate host implementation:

- network decisions allow only `GET`, HTTPS on the default HTTPS port, an explicitly granted
  exact/wildcard hostname, a one-MiB response ceiling, and require DNS/public-address and redirect
  rechecks at execution time;
- model decisions allow only an explicitly granted configured provider and require the provider
  run-record boundary; remote providers additionally require disclosure;
- Drive decisions require `drive.read` or `drive.propose`, exact selected-workspace identity, and
  another target check when the operation executes; and
- session expiry or revocation fails closed with a content-free error code.

This broker remains `implemented-non-executing`: it is neither the component executor nor a package
loader. Run `npm run test:plugin-host` to
exercise grant escalation, detached snapshots, stale/cross-target proposals, network/SSRF-shaped
targets, model scope, Drive workspace scope, expiry, revocation, and error redaction.
Evidence and explicit non-claims:
`docs/audits/runs/PLUGIN-AUTHORITY-BROKER-2026-07-15.json`.

## Runtime tiers

1. `wasi-component` is preferred. Components begin without ambient authority. The published
   `syzygy:research/plugin@1.0.0` world deliberately
   imports nothing and exports one typed `run` function. Its invocation can contain only plugin and
   contribution identity plus an optional bounded project snapshot; its result is either a bounded
   no-change reason or revision-guarded proposals. The host must omit the project when
   `project.read` is absent and must pass every proposal through the authority broker. A later
   capability world may version logging, bounded HTTP, Drive, and provider calls independently;
   those interfaces are not smuggled into the baseline world.
2. `mcp-stdio` is an advanced native-process tier. It can be useful for Python/R workflows and
   existing MCP servers, but the OS process is outside the WASI sandbox. Installation must show a
   stronger warning, exact executable/arguments, publisher/hash, and requested Syzygy permissions.

No plugin JavaScript executes inside the Tauri webview. A UI contribution is declarative data
rendered by Syzygy components and theme tokens; arbitrary HTML, script, CSS, and active URLs are
rejected.

The WIT file is embedded verbatim in `syzygy_platform_contracts`, alongside the world identifier
and the truthful status `zero-import-subprocess-runtime-bounded`. A pinned Bytecode Alliance
`wit-parser` test resolves the package and proves the world has zero imports and one export;
contract tests also prove the JSON-side envelopes reject unknown fields, duplicate source identity,
cyclic/unbounded payloads, direct-mutation output, empty/oversized proposal batches, and malformed
revision guards.

The native baseline executor accepts one base64-encoded in-memory component and one typed
invocation through the sole Tauri boundary. Before compilation it rejects malformed binaries,
core modules, files over 8 MiB, and every top-level component import. Wasmtime receives an empty
linker and the production dependency graph contains no `wasmtime-wasi`, so there is no filesystem,
network, environment, clock, random, Drive, model, or mutation interface to call. The store caps
linear memory at 32 MiB, sources at 200, proposals at 32, envelopes at 1 MiB, and guest execution
with fixed fuel plus a two-second epoch deadline. Returned proposals must repeat the exact plugin,
project, and revision identity and remain untrusted pending authority-broker and human review.

Execution is isolated in a fresh hidden child process with bounded stdin/stdout and suppressed
stderr. The parent serializes runs, revalidates the response, and kills and reaps the child at a
five-second whole-worker deadline. This is intentional defense in depth: on the current Windows
toolchain, the hostile fuel-exhaustion fixture can terminate the pinned Wasmtime worker rather than
return normally. The integration gate proves the parent survives, reaps that process, and completes
a clean follow-up invocation. The runtime therefore contains this failure instead of pretending it
does not exist.

Run `npm run test:plugin-runtime` for exact-world execution, proposal identity/revision checks,
ambient-import denial, malformed/core-module/size rejection, memory-limit/trap/output validation,
sanitized failures, hostile-worker containment, and post-failure reuse. This proves the low-level
baseline executor. It does not prove package discovery/install/upgrade, signer trust, broker/product
composition, capability-bearing worlds, useful plugin behavior, or a third-party runtime artifact;
the citation-auditor example intentionally remains an interface-only non-executable marker.

Run `npm run test:plugin-composition` for the layer above the raw executor. In the installed product,
the researcher explicitly selects `syzygy-plugin.json` and the exact component named by it. Syzygy
validates the manifest/world/filename/size, computes SHA-256, keeps no more than eight packages and
32 MiB of components in current-session memory, then recomputes the digest immediately before every
run. Only requested `project.read` and `project.propose` capabilities can become active in this
zero-import world; requested network, Drive, model, filesystem, and native-process capabilities are
shown as inactive. One component runs at a time through the kill-and-reap child boundary.

Valid proposal output is preflighted as one 1–32-item batch and appended to the shared Yjs review
ledger with plugin/version/component/contribution/runner provenance. Accept/reject decisions are
immutable, converge across disconnected peers, and expose opposite decisions as a conflict. Neither
execution nor decision changes the policy draft. MCP exposes `inspect_plugin_workspace` and
`run_loaded_plugin`; inspection omits component/proposal bodies, and execution can address only a
package already loaded by the person in that running GUI, with exact document and research
revisions. MCP cannot load a component, decide a plugin review, or apply text.

This is truthful status `user-selected-in-memory-session-no-install-upgrade` plus
`shared-proposal-ledger-human-decision-no-apply`. Discovery, persistent install/upgrade/rollback,
signer/publisher trust, a useful executable third-party example, capability-bearing WIT worlds,
review-event device signatures, and revision-guarded Apply remain open.

Design basis: the upstream Component Model describes WIT worlds as the strict import/export
boundary and explicitly notes that a component without a relevant import cannot access that host
capability. WIT itself specifies contracts rather than behavior. Reviewers should compare this
design against the primary references:

- <https://component-model.bytecodealliance.org/design/worlds.html>
- <https://component-model.bytecodealliance.org/design/wit.html>
- <https://component-model.bytecodealliance.org/design/components.html>

Reproducible results and non-claims are recorded separately for the published interface and the
executor:

- `docs/audits/runs/PLUGIN-WIT-CONTRACT-2026-07-15.json`
- `docs/audits/runs/PLUGIN-ZERO-AUTHORITY-RUNTIME-2026-08-11.json`
- `docs/audits/runs/PLUGIN-SHARED-REVIEW-2026-08-11.json`

## Mutation protocol

Plugins never receive a writable project handle. They return a `PluginChangeProposal` containing
plugin/project identity, an expected document revision, summary, bounded content, and append or
replace operation. Syzygy shows a diff; the person accepts, edits, or rejects. Acceptance rechecks
plugin permission, project identity, revision, content bounds, and target provider, and attributes
the change to the accepting person plus plugin/version.

Drive mutations use separate domain-specific proposal schemas; generic replace/append does not
grant Drive writes.

## Certification and publication

Run the contract certifier from `frontend`:

```powershell
npm run certify:plugin -- ..\path\to\plugin-package
npm run test:plugin-sdk
```

A package contains `syzygy-plugin.json`, `syzygy-certification.json`, package-contained
documentation/license/runtime paths, proposal fixtures, and authority probes. The runner uses Ajv
against the committed Draft 2020-12 schemas, resolves real paths to reject traversal and
symlink/junction escape, requires expected-valid and expected-invalid proposal fixtures, verifies
valid proposals target the manifest plugin ID, and evaluates declared capabilities, exact/wildcard
network hosts, and model providers. At least one denied-authority probe is mandatory. Its JSON
report contains identifiers/counts/errors, never proposal content.

`contract-certified` means package/schema/fixture/authority metadata passed. It explicitly does
not mean the runtime artifact is valid, safe, deterministic, useful, or executed. The example's
runtime artifact is intentionally a non-executable marker to make that distinction testable.

The landed contract runner validates schema shape, unknown fields, duplicate fixture/probe IDs,
bounded JSON, path containment, documentation/license/runtime presence, proposal validity and
plugin identity, plus allow/deny authority probes. Later execution certification must still validate:

- full Unicode/maximum-size boundary corpus beyond the current one-MiB file bounds;
- denied runtime operations, not only declared authority resolution;
- stale revision, malformed proposal, timeout, cancellation, crash, and output flood;
- prompt injection in project/Drive content;
- determinism declaration and fixture output where applicable;
- no secrets in stdout/stderr/logs/artifacts;
- every future granted capability world (the no-authority baseline now has separate runtime evidence); and
- install, disable, upgrade, downgrade, and removal without project corruption.

The in-process validator now also rejects unknown manifest/runtime/permission/contribution and
proposal fields, duplicate authorities, invalid provider IDs, overlong public fields, malformed
untyped proposals, and the same proposal bounds as the published schema. JSON Schema remains the
portable interchange gate; the broker repeats semantic identity/revision/authority checks.

The same headless `syzygy_platform_contracts` response publishes the strict portable scenario-pack
schema. Plugins and external research tools may produce or consume that open file contract, but schema
validation alone is insufficient: they must also verify canonical SHA-256, nested ID uniqueness,
current-turn projection, canonical histories, and the closed acyclic parent graph. Import remains an
explicit product action; publishing the schema grants no project, file, model, Drive, or network authority.

A signed marketplace is not required for the API. Local folders and explicit package files remain
supported. Publication metadata, signatures, and reputation can be layered on later without
changing the project/proposal contracts.
