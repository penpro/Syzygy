# ADR-0003: Research plugins are manifest-declared and proposal-only

- **Status:** accepted for contract implementation; runtime pending
- **Date:** 2026-07-14

## Context

Researchers need to extend Syzygy with disciplinary tools, data connectors, evaluators, and
import/export formats. In-process webview JavaScript would combine arbitrary code with UI authority.
An unrestricted native plugin API would combine useful openness with ambient filesystem/network
authority and make project safety dependent on every plugin.

## Decision

Plugins declare a strict JSON Schema manifest, contribution points, runtime, and least-authority
permissions. WASI components are the preferred portable sandbox. MCP stdio is an advanced native
process tier with an explicit trust warning. No plugin code executes in the webview.

Project and Drive changes are typed proposals, never direct mutation. Proposals name the base
revision, are bounded and diffed, require human acceptance, and are re-authorized at execution.
Network domains and model providers are allowlisted independently. Manifest declarations request
authority but do not grant it.

## Consequences

- Python/R/native integrations remain possible through MCP, but are clearly less isolated.
- WASI host interfaces and WIT definitions must be versioned and certified before loading code.
- Declarative UI contributions are less flexible than arbitrary HTML, but preserve theming,
  accessibility, and the Tauri security boundary.
- Marketplace, signing, and reputation can be added later without making them prerequisites for
  local extension development.

## Rejected alternatives

- **Arbitrary JavaScript in the webview:** crosses the highest-value UI/credential boundary.
- **Direct project/Drive handles:** bypass revision checks, review, attribution, and selected-folder
  proof.
- **Only a curated marketplace:** creates a new gatekeeper and is unnecessary for the open API.
