# Editor provenance ledger

**Status:** First clean-room editor vertical slice landed; dependency and source-file gate active.

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
| `frontend/src/workspace/schema.ts` | Penumbra original | Versioned project-manifest contract and fail-closed validator |
| `frontend/src/workspace/projectModel.ts` | Penumbra original | Provider-neutral Yjs shared-type names and update helpers |
| `frontend/src/workspace/heuristicsModel.ts` | Penumbra original | Typed collaborative heuristic records with nested CRDT fields, bounded validation, per-edit attribution, replay rejection, and deterministic read projection |
| `frontend/src/workspace/policyVersionModel.ts` | Penumbra original | Canonical SHA-256-addressed immutable policy envelopes, parent validation, detached readback, and historical attribution snapshots |
| `frontend/src/workspace/policyVersionHistory.ts` | Penumbra original | Exact-head commits, restore-as-new-child history, concurrent branch retention, and deterministic engine-free structured diffs |
| `frontend/src/workspace/localProvider.ts` | Penumbra original | Local IndexedDB provider implementing the Lexical/Yjs provider boundary |
| `frontend/src/workspace/collaborationProvider.ts` | Penumbra original | Provider-neutral lifecycle shared by local and test/future transports |
| `frontend/src/workspace/memoryProvider.ts` | Penumbra original | Deterministic two-editor live/partition convergence transport used only by the headless contract suite |
| `frontend/src/workspace/nodes/PolicyBlockNode.ts` | Penumbra original | Stable-identity editable policy statement node with review state and strict JSON round-trip |
| `frontend/src/workspace/ResearchEditor.tsx` | Penumbra original | Original Syzygy editor composition, formatting toolbar, and local provider wiring |
| `frontend/src/workspace/WorkspaceView.tsx` | Penumbra original | Original three-column research workspace scaffold |
| `frontend/src/workspace/editorAutomation.ts` | Penumbra original | Semantic live-editor controller, deterministic text-block adapter, and optimistic revision guard |
| `frontend/src/workspace/editorAutomationRegistry.ts` | Penumbra original | Lightweight active-editor capability registry that preserves lazy workspace loading |
| `frontend/src/workspace/*.test.ts` and `frontend/src/migrations.test.ts` | Penumbra original | Schema, migration, convergence, duplicate/reorder, and reopen harnesses |
| `frontend/src/automationBridge.ts` and `frontend/src-tauri/src/{automation,mcp}.rs` | Penumbra original | Live semantic dispatcher, authenticated loopback bridge, and stdio MCP protocol implementation |
| `frontend/src/extensions/*.ts` | Penumbra original | Provider, adversarial-run, and researcher-plugin contracts and tests authored for Syzygy |
| `frontend/src-tauri/src/platform_contracts.rs` and `docs/schemas/*.json` | Penumbra original | Strict extension schemas and truthful MCP self-description authored for Syzygy |

## Approved exact dependencies

All product dependencies below are exact-pinned in both `package.json` and `package-lock.json`.
Integrity values are npm registry `dist.integrity` values captured before installation. The root
Lexical repository and packages are MIT; Yjs, y-indexeddb, and y-protocols are MIT. The test-only
fake IndexedDB implementation is Apache-2.0. No example/playground source or UI was copied.

| Package | Version | License/source evidence | npm integrity |
|---|---:|---|---|
| `lexical` | 0.47.0 | MIT; <https://github.com/facebook/lexical> | `sha512-ZKsxsk3jUpXsRtG20EBq42z2bq8A20UHtjqvVT/kIxfsaiXwaRFBBcLSFxPa77j+hXkBF5w96C3/imwtmLoRdg==` |
| `@lexical/react` | 0.47.0 | MIT; same monorepo | `sha512-4y2iEKghKcYcJ8+GoO8pqyvwjJFVDWR71Ezm37lLQGmSTFKY50miTJmgKI12GeL4hLWQjePpB3eVdmSQHG1b7g==` |
| `@lexical/rich-text` | 0.47.0 | MIT; same monorepo | `sha512-GtRH7KNW7fVJzd3Xftdr/EPXaMqHt2xCIO/eJtf17Yrs7vlVOljM0xMcDoj4QOY2Gp4p3CheLlwBbcO96YYV0A==` |
| `@lexical/selection` | 0.47.0 | MIT; same monorepo | `sha512-/q+eXnryZxCeqeWAODhTRlJL+jGa6/vIhE/bh+KvHmLbZJM8qfwa0qzt4rb3g+L1/CbjcowS/Xwv2ha1OmjBFQ==` |
| `@lexical/yjs` | 0.47.0 | MIT; same monorepo | `sha512-EKw1df2cmUTQrfSp1EnXqsHtNjwgxS973CRor0W4GWmIQJyKdmf6cmA7cct3flkyH5tE/xDnpr8sy38U4R2hlQ==` |
| `yjs` | 13.6.31 | MIT; <https://github.com/yjs/yjs> | `sha512-Eq+5BRfbeGyqGVrTJL3bEcr8gKkxPuyuoHmAwpk52fDb8kOVMrfVSTRPd6yiGgX5Fskb96qCRjzjbRjrL4YEnw==` |
| `y-indexeddb` | 9.0.12 | MIT; <https://github.com/yjs/y-indexeddb> | `sha512-9oCFRSPPzBK7/w5vOkJBaVCQZKHXB/v6SIT+WYhnJxlEC61juqG0hBrAf+y3gmSMLFLwICNH9nQ53uscuse6Hg==` |
| `y-protocols` | 1.0.7 | MIT; <https://github.com/yjs/y-protocols> | `sha512-YSVsLoXxO67J6eE/nV4AtFtT3QEotZf5sK5BHxFBXso7VDUT3Tx07IfA6hsu5Q5OmBdMkQVmFZ9QOA7fikWvnw==` |
| `fake-indexeddb` (test only) | 6.2.5 | Apache-2.0; <https://github.com/dumbmatter/fakeIndexedDB> | `sha512-CGnyrvbhPlWYMngksqrSSUT1BAVP49dZocrHuK0SvtR0D5TMs5wP0o3j7jexDJW01KSadjBp1M/71o/KR3nD1w==` |

The generated full SBOM/license inventory remains an open Phase 0 gate; this ledger approves only
the dependencies introduced by the first editor slice.

The CI audit currently fails if Tiptap, Firebase, or PolicyPad packages/imports enter the source
tree. It is a guardrail, not proof of clean-room authorship; human and adversarial review remain
mandatory.
