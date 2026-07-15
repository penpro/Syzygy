# Research plugin API

**Manifest version:** 1. **Runtime status:** schemas, validators, and a non-executing package
certifier are implemented; discovery, installation, execution, and UI are not yet implemented.

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
    "world": "syzygy:research/plugin"
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
arbitrary model protocols require the future WASI host and the same `model.invoke` authority gate.

## Runtime tiers

1. `wasi-component` is preferred. Components begin without ambient authority; Syzygy links only
   the approved host interfaces. The future WIT world will version project snapshots, proposals,
   logging, bounded HTTP, and provider calls independently.
2. `mcp-stdio` is an advanced native-process tier. It can be useful for Python/R workflows and
   existing MCP servers, but the OS process is outside the WASI sandbox. Installation must show a
   stronger warning, exact executable/arguments, publisher/hash, and requested Syzygy permissions.

No plugin JavaScript executes inside the Tauri webview. A UI contribution is declarative data
rendered by Syzygy components and theme tokens; arbitrary HTML, script, CSS, and active URLs are
rejected.

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
- WASI no-authority baseline and each granted capability; and
- install, disable, upgrade, downgrade, and removal without project corruption.

A signed marketplace is not required for the API. Local folders and explicit package files remain
supported. Publication metadata, signatures, and reputation can be layered on later without
changing the project/proposal contracts.
