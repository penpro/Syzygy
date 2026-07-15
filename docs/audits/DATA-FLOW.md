# Data-flow inventory

**Baseline:** 2026-07-14

| Flow | Trigger | Source → destination | Data | Persistence | Guard |
|---|---|---|---|---|---|
| Local generation | User sends Ask | Webview → loopback llama.cpp | Prompt, selected local/Drive passages, history | Thread in localStorage | Loopback endpoint only |
| Local folder context | User grants folder and asks | Granted path → Rust → model prompt | Relevant text chunks | Knowledge cache in memory | Canonical `Granted` allowlist |
| Local research project | User creates/edits project | Lexical editor ↔ Yjs document ↔ IndexedDB | Rich editor updates and reserved project collections | `syzygy-project-v1:<projectId>` IndexedDB | Schema-versioned manifest; fail-closed migration; no network provider attached |
| Drive link | User clicks Link/Re-link and consents | System browser ↔ Google; Rust ↔ token endpoint | OAuth code, refresh/access token, account email | `google_auth.json` in app data | PKCE, state, loopback listener; token never returned to webview |
| Drive direct research | Shared mode + Ask | Selected Drive tree → Rust exports → model prompt | Supported relevant text; file labels | No mirror; request memory only | Collaboration scope + persisted folder ID + descendant checks |
| Drive transcript | Shared mode after response | Completed exchange → selected Drive folder | Prompt and model response | Drive file | Explicit per-thread Shared toggle |
| Drive mirror | User clicks Sync | Selected Drive folder ↔ `Documents/Syzygy` | Supported files; Google-native text/CSV snapshots | Local mirror + Drive | Explicit action; exported snapshots are not re-uploaded |
| Model download | User selects model | Publisher URL → app model directory | GGUF/model metadata | App data | Explicit UI action and expected hash/size metadata where available |
| Update check/install | User confirms check/install | GitHub release endpoint → updater | Version metadata, signed installer | Installer/update cache | Explicit disclosure; updater signature |
| Diagnostic log | Runtime errors/milestones | Frontend/Rust error boundary → local ring | Command/tag/error only | localStorage, newest 500 entries | No prompt, file content, token, or credential logging |
| Live MCP read/control | MCP host starts `Syzygy --mcp` and calls a tool | MCP stdio → token-authenticated ephemeral loopback → Rust event → live webview | Semantic method/parameters; project content only for explicit read/write tools | No MCP copy; live Zustand/Yjs owners persist normally | Loopback only, 256-bit per-process bearer, browser-origin rejection, bounded request, timeout |
| MCP setup/self-description | User opens Settings guide or connected host calls `syzygy_installation` | Running Rust process → webview or MCP stdio | Executable path, parent install folder, app/protocol versions, generated config/prompts | None | Local process metadata only; no OAuth token, model secret, or research content |
| Extension contract inspection | Connected host calls `syzygy_platform_contracts` or CI loads validators | Embedded schemas/status → MCP stdio/test process | Provider transports, adversarial phases, plugin permissions/schemas, implementation states | None | Static public contract data; unimplemented runtimes say `contract-only`; no project/key/account data |
| Remote credential management | User expands optional remote keys and saves/replaces/removes | Masked transient DOM field → typed wrapper → Rust → OS credential facility | Provider ID and API key; status returns only a boolean | OS credential store only | Field clears before awaited write; no key in React/Zustand/localStorage/project/backup/log/MCP; no get-secret command; saving has no generation authority |
| Native-gated provider task | Typed frontend call, currently with no product caller | Structured question/instructions/labeled snapshots → Rust-derived categories/provenance → native disclosure → OS vault → fixed provider HTTPS route → content-free record | Serialized research envelope leaves only after native **Send once**; hashes/derived source IDs/status/usage return | Key in OS vault; call/record persistence belongs to future workflow | No caller approval/category/detached-provenance fields; unique source IDs; bounded content/model; denial precedes vault/network; fixed route; timeout/cancellation; MCP has no invoke authority |
| Provider task proof | Headless fake-network/interoperability test | Memory vault → Rust task bridge → loopback fake provider → serialized record → TypeScript public validators | Synthetic prompt/credential in transport; hashes/source IDs/status/usage in record | Test memory only | Explicit conformance mode, schema/semantic validation, secret/content canaries; native dialog copy tested separately without GUI clicks |
| Injected adversarial runner proof | Headless synthetic test invokes the phase runner | Frozen synthetic snapshots → injected executor → blinded record + separate route ledger/baseline artifacts | Synthetic questions, excerpts, candidate output, sanitized status/usage | Test memory only | No provider import/network/key; route outside judge payload; exact equal-call baseline; semantic record gate; pending human decision; shared mutation false |
| Native adversarial batch authorization and private reservation | Future workflow requests one panel consent; tests call reservation directly | Real question/frozen source scope + exact remote routes/budgets → Rust validation → native dialog → random capability → atomic run/source-ID/route/call-ID reservation | Route/model/count/source identity and derived content categories; no research text in dialog/status; no task bytes pass through reservation | Rust process memory, maximum 30 minutes | Denial stores nothing; random 256-bit ID; exact summed ceilings; bounded registry; content-free status; explicit revoke; parallel route+total decrements; call-ID replay rejection; expiry cleanup; no public command/vault/network/call consumer |
| Plugin authority broker proof | Headless test opens a synthetic host session | Strict manifest + explicit grant + bounded project snapshot → in-process broker → detached snapshot/pending proposal/target decision | Synthetic semantic text, IDs, declared authorities, sanitized error codes | Test memory, maximum 15-minute session | Grant must be manifest subset; exact revision/project/plugin; selected Drive ID; HTTPS host/model allowlists; no loader/fetch/model/Drive/mutation implementation |
| Plugin WIT contract proof | Headless TypeScript/MCP tests inspect public contract | Optional bounded project snapshot → zero-import `run` export → no-change or typed proposals → existing proposal validator | Synthetic project/source text and revision IDs in test memory; WIT source in public MCP metadata | No component executes or persists | No WIT imports; one-MiB envelope ceiling; duplicate-source/unknown-field/cycle/direct-mutation rejection; exact revision guards; truthful no-runtime status |
| Collaborative heuristics | Workspace domain service and future UI/plugins | Validated create/update/delete → nested Yjs heuristic/edit maps → validated sorted projection | Heuristic title/guidance/priority/enabled plus author/time/change values | Existing project Y.Doc and collaboration provider | Stable bounded IDs/text; field-level CRDT merge; peer-specific storage retains colliding edit IDs so projection fails closed; 10,000-edit bound; delete-versus-edit fixture proves no resurrection; no evaluator/model call |

## Planned flows that are not yet runtime claims

| Flow | Trigger | Source → destination | Required guard |
|---|---|---|---|
| Product remote model workflow | User chooses provider/model and sends a research task | Selected research context → registered Rust provider task bridge → provider HTTPS API | Build key/settings UI and task orchestration on the existing native one-use disclosure; retain authoritative run record; add live opt-in evidence and streamed/tool handling before availability |
| Product adversarial panel | User starts a configured panel | Evidence snapshot → native batch-authorized provider executor → injected runner → blinded review record | atomically consume existing scope against exact run/route/source identity before vault/network; provider-run provenance; compute-matched baseline; order swap; source audit; minority retention; no automatic shared mutation |
| Research plugin | User installs/enables and invokes a contribution | Bounded snapshot → WASI or trusted MCP runtime → typed proposal | declared and granted permissions, no ambient authority, revision guard, diff plus human acceptance |

## Drive boundary nuance

Google's token has wider technical authority than the selected workspace. Syzygy narrows product
operations by folder ID and descendant enumeration. This is an application control, not a Google
permission boundary; see ADR-0001. Any new Drive command must prove that it cannot operate outside
the selected tree or must receive a separate explicit review.

## Evidence still required

- sanitized per-feature network traces (S-06);
- Windows/macOS/Linux app-data permission checks;
- crash-dump inspection for prompt/token leakage;
- two-account Drive harness evidence after restricted-scope reauthorization; and
- packaged Windows/macOS/Linux MCP launch and same-user temp-descriptor permission checks.
