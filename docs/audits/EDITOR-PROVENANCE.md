# Editor provenance ledger

**Status:** Phase 0 baseline; no collaborative editor implementation has landed.

## Rules

- PolicyPad and Tiptap code, packages, prompts, schemas, fixtures, assets, templates, tests, and
  UI are prohibited implementation inputs.
- Every future editor source file must be added to the file ledger in the same commit.
- Third-party packages require an exact locked version, upstream source URL, package-level
  license evidence, and shipped-license/SBOM evidence before use.
- Example/playground UI from an editor dependency is not an approved product source.

## Current file ledger

| Path/pattern | Classification | Evidence |
|---|---|---|
| `frontend/src/components/AskView.tsx` and current shell components | Penumbra original / inherited MIT Syzygy shell | Repository history and MIT license |
| `frontend/src/driveContext.ts` | Penumbra original | Added with direct Drive evidence tests |
| `frontend/src-tauri/src/google_*.rs` | Penumbra original | OAuth/Drive implementation and ADR-0001 |
| Future `frontend/src/workspace/**` | **Not created** | Must be registered before merge |

## Candidate dependency gate

Lexical, `@lexical/yjs`, and Yjs remain candidates only. No package is approved until exact
versions are pinned and this table records package-level MIT evidence and the generated SBOM.

The CI audit currently fails if Tiptap, Firebase, or PolicyPad packages/imports enter the source
tree. It is a guardrail, not proof of clean-room authorship; human and adversarial review remain
mandatory.
