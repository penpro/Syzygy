# Live Syzygy MCP

Syzygy's installed application binary is also a local MCP server. Launching it with `--mcp`
starts a stdio MCP process; launching it normally starts the desktop UI. The MCP does not open a
second project database or scrape pixels. It sends semantic operations to the running Syzygy
window, which remains the owner of project navigation, Lexical editor state, Yjs, and IndexedDB.

This is an automation and interoperability surface, not a claim that unfinished research
features exist. `syzygy_status`, `workspace_walkthrough`, and `inspect_research_state` explicitly
report the difference between usable domain foundations and the still-disabled version controls,
scenario UI, evaluation, Drive project transport, and real-time presence slices. Guarded scenario/
branch/turn mutation, aggregate voting, and flag/note lifecycle are narrow automation surfaces.

## Connect an MCP host

The streamlined path is **Syzygy → Settings → Connect an LLM → MCP setup guide**. The running app
detects its exact executable and install folder, then generates JSON-host configuration, Codex
TOML, a connection prompt, and a safe first task. Use those generated values because install paths
vary across computers.

To configure a host manually, use a local stdio server with the full path to the installed Syzygy
executable:

```json
{
  "servers": {
    "syzygy-live": {
      "type": "stdio",
      "command": "C:\\full\\path\\to\\Syzygy.exe",
      "args": ["--mcp"]
    }
  }
}
```

Use the equivalent stdio-server shape for hosts that use TOML or another configuration format.
The executable path must be absolute. The MCP can call `launch_syzygy` when the GUI is closed;
otherwise open Syzygy normally before using the other tools.

Recommended first instruction to an MCP-capable model:

> Use the Syzygy tools to inspect the live workspace, run the workspace walkthrough, explain the
> current project to me, and offer one concrete demonstration edit. Read before writing.

## Tool contract

| Tool | Mutation | Contract |
|---|---:|---|
| `syzygy_status` | no | Running version/view, active project, editor readiness, honest capability report |
| `launch_syzygy` | launches app | Starts the GUI from the same installed executable and waits for readiness |
| `syzygy_installation` | no | Exact executable/install folder, protocol, JSON/TOML configuration, connection prompt, and starter prompt; works without the GUI |
| `syzygy_platform_contracts` | no | Provider-run, custom-adapter, public adversarial-run, and plugin schemas, honest runtime status, and self-check commands; works without the GUI |
| `workspace_walkthrough` | no | State-aware explanation of the current use case and next step |
| `list_projects` | no | Stable IDs, titles, archive state, transport, active project |
| `create_project` | yes | Creates and opens a local project with a non-empty title |
| `open_project` | navigation | Opens a non-archived project by stable ID |
| `rename_project` | yes | Changes project metadata only |
| `read_active_project` | no | Returns the manifest plus structured blocks, plain text, and a revision |
| `inspect_research_state` | no | Validates bounded live scenario/vote/flag/note/label/heuristic/version/head/lineage state and returns metadata summaries without policy, scenario, annotation, voter, label-event, guidance, edit-value, or version-note bodies |
| `create_scenario` | scenario metadata | Creates one scenario/branch only when `expectedResearchRevision` exactly matches the revision from inspection; no model generation |
| `add_scenario_turn` | scenario content | Adds one attributed system/user/assistant turn against the exact current research revision; never invokes a model |
| `revise_scenario_turn` | scenario content | Adds an attributed immutable revision to an existing turn against the exact current research revision |
| `cast_scenario_vote` | vote event | Casts support/oppose/abstain/withdrawn against the exact current research revision; retains re-vote history and returns aggregate counts |
| `create_scenario_annotation` | annotation event | Creates a scenario- or turn-level flag/note against the exact research revision; stores but does not return its body |
| `update_scenario_annotation` | annotation event | Appends a body revision only when both research revision and current annotation event match; prior bodies remain in history and readback omits them |
| `set_scenario_annotation_resolution` | annotation event | Resolves or reopens by appending an event under both revision guards |
| `create_scenario_label` | label event | Creates a shared context label against the exact current research revision; event bodies remain omitted |
| `rename_scenario_label` | label event | Appends a rename only when both research revision and current label event match |
| `set_scenario_label_assignment` | assignment event | Assigns/removes a label under the research guard; follow-up events also require the exact assignment event |
| `save_active_policy_version` | version metadata | Saves the exact active semantic draft as a new immutable head under both document-revision and expected-head guards; does not edit the draft or restore history |
| `restore_active_policy_version` | document + version metadata | Restores one inspected immutable version into the live semantic draft and appends it as a new head under exact target, document-revision, and expected-head guards; never rewrites history |
| `replace_active_document` | yes | Replaces the document only when `expectedRevision` still matches |
| `append_active_document` | yes | Appends blocks only when `expectedRevision` still matches |

Automation document text has a deliberately small, deterministic format: `# ` for heading 1,
`## ` for heading 2, `> ` for a quotation, `[policy:stable-id:draft|review|approved] statement`
for a policy block, and other lines for paragraphs. Structured reads also return the policy ID and
status. It does not pretend to round-trip editor features Syzygy has not implemented.

Every document write requires the exact revision returned by the latest read. If the user or a
collaborator changes the live draft between read and write, the tool fails with a revision
conflict. The caller must read again and reconcile; there is no blind last-writer-wins overwrite.
Revisions combine a controller-session nonce, monotonic live-editor generation, and deterministic
content fingerprint, so a draft that changes away and back to identical content still rejects an
older read (the ABA case).

## Local bridge and security boundary

```text
MCP host
  `- spawns `Syzygy --mcp` over stdio
       `- authenticated POST to ephemeral 127.0.0.1 port
            `- Rust emits semantic request to main webview
                 `- live Zustand + Lexical/Yjs operation
                      `- typed response follows the same path back
```

- The GUI binds an ephemeral IPv4 loopback port; it never listens on the LAN.
- Each GUI process creates a random 256-bit bearer token and a small descriptor at
  `${temp}/syzygy-automation-v1.json`. On Unix the descriptor is set to mode `0600`; Windows
  relies on the current user's temp-directory ACL.
- Browser-origin requests are rejected even when they somehow know the token. Requests and
  headers are bounded; live operations time out after 15 seconds.
- The descriptor contains only schema version, port, token, process ID, and app version. It has
  no OAuth credential, prompt, project content, or model secret and is removed during normal GUI
  shutdown.
- Research content is not added to the diagnostic log. Backend failures record only the command
  name and error, following the existing typed `tauri.ts` boundary.
- This protects against remote/LAN callers and blind browser requests. It is not a sandbox from
  malware already executing as the same OS user; such a process can already access the user's
  local app data and input devices.
- MCP tools do not receive ambient Drive, filesystem, or local-model authority. Future tools for
  those systems need their own typed proposal/confirmation contracts.
- `inspect_research_state` is read-only and content-minimized. It checks the same live Y.Doc owned
  by the editor/local provider, caps returned items, and has no scenario/label/heuristic/version/document mutation
  path. Titles, attribution, IDs, counts, and timestamps are metadata and may be returned; policy
  text, scenario backgrounds/turn content/revision, annotation, voter, and label-event bodies,
  heuristic guidance and edit values, and version notes are deliberately omitted. Scenario branch
  ancestry plus vote/annotation/label targets are checked; peer-colliding public identities or
  events fail closed. Aggregate vote counts, annotation lifecycle/event totals, and label names/
  assignments are metadata returned to the connected host.
- `create_scenario` requires the exact monotonic Yjs research revision returned by
  `inspect_research_state`. A stale revision fails before mutation; the frontend domain harness and
  packaged live harness assert zero stale writes. Participant identity/time remain caller/process
  supplied, and the tool does not generate turns or make the unavailable gallery appear.
- `add_scenario_turn` and `revise_scenario_turn` use the same guard. Chain the returned research
  revision into the next mutation. Revision retains earlier turn bodies and attribution; stale
  calls fail before mutation. These tools store explicit caller content and never contact a model.
- `cast_scenario_vote` uses the same guard and retains each attributed vote/re-vote/withdrawal as
  an immutable event. Its response and inspection expose only aggregate counts/event totals. A
  stale call fails before adding an event. Participant IDs, display names, and time are caller/
  process supplied, so the tool is not an authenticated election or Sybil-resistant consensus.
- Annotation create uses the research revision guard. Edit/resolve/reopen additionally require the
  exact `currentEventId` returned by the preceding mutation or inspection. Both stale-research and
  stale-lifecycle conflicts fail before an event is added. Bodies are accepted for create/edit and
  retained locally in immutable history, but mutation responses and inspection return only IDs,
  kind/status, target, timestamps, and event counts. Identity/time remain caller/process supplied.
- Label create uses the research revision guard. Rename additionally requires the exact label
  `currentEventId`; an assignment's first event requires no event parent and every follow-up add/
  remove requires its exact assignment `currentEventId`. Stale research or event parents add no
  event. Responses return label/assignment metadata only; caller identity/time are unauthenticated.
- `save_active_policy_version` requires `expectedDocumentRevision` from `read_active_project` and,
  when non-null, `expectedHeadVersionId` from `inspect_research_state`. The live editor revision is
  checked once before hashing and again inside the final Yjs head transaction; the existing head
  and parent bytes are rechecked there too. A conflict inserts no record in the committed harness.
  Participant ID/display name are caller-supplied historical attribution, not authenticated identity.
- `restore_active_policy_version` requires `targetVersionId` from bounded version inspection,
  `expectedDocumentRevision` from `read_active_project`, and the exact non-null
  `expectedHeadVersionId` from `inspect_research_state`. The existing restore transaction
  validates target lineage/project identity, rechecks document and head, replaces exact semantic
  blocks, and appends a new immutable child. A stale document or head adds no version, and a
  synthetic editor failure restores the prior draft/head. Participant ID/display name remain
  caller-supplied attribution rather than authenticated identity.
- `syzygy_installation` discloses the executable and parent-folder paths to the already-connected
  local MCP host. These paths are local machine metadata, contain no OAuth token or research
  content, and are also visible to the user in Settings.
- `syzygy_platform_contracts` embeds public plugin, custom-adapter, provider-run, and adversarial-run schemas plus implementation-state labels only. It
  reports the OpenAI adapter as `request-and-stream-control-conformance` and Anthropic
  Messages, Gemini Interactions, and xAI Responses as the narrower `request-control-conformance`.
  It reports the OS-vault Settings surface as `settings-vault-ui`, the native-disclosure one-shot task
  bridge as `native-disclosure-research-envelope`, and aggregate remote execution as
  `native-disclosure-single-review-ui-no-live-proof`. MCP itself has no provider-generation or credential
  tool and therefore cannot bypass the native send boundary. It reports adversarial batch
  authorization as `native-scoped-authorizer-no-product-executor`; the authorizer itself is not an
  MCP tool and has no call consumer. It separately reports its private concurrency-tested budget
  boundary as `internal-atomic-reservation-no-executor`; that function also has no MCP/Tauri
  command, content binding, credential access, or network access. It reports the non-executing
  plugin certifier as `contract-certified-runner`, adversarial execution as
  `injected-runner-no-product-executor`, and plugin loading and custom-adapter execution as
  `contract-only`; the non-executing adapter
  certifier is `contract-certified-runner`, while provider-run and adversarial record validators are
  reported separately as `implemented` without implying product model calls run;
  the in-process plugin authority broker is `implemented-non-executing` without implying a plugin
  can be installed or loaded; the embedded `syzygy:research/plugin@1.0.0` WIT source is reported as
  `published-zero-imports-no-runtime`, and the harness rejects any host import or runtime claim;
  it returns no key, provider account, project content, or Drive credential.

## Private-LAN multi-install control

The development LAN control plane lets one MCP host drive multiple installed Syzygy applications
without exposing their GUI bridges. The primary host runs `scripts/lan-mcp-host.mjs`; every
installation joins through its packaged `Syzygy --lan-agent` mode. The coordinator exposes
`lan_nodes`, `lan_node_tools`, `lan_call`, and read-only `lan_probe`. Calls retain the selected
installation's native tool schemas, revision conflicts, disclosure prompts, and mutation guards.

The LAN stream is pairing-key authenticated and encrypted; it has 15-second heartbeats, 45-second
stale eviction, replay counters, bounded frames, and a one-minute absolute operation ceiling. It
must bind one explicit private address and must never be router-forwarded or exposed publicly. The
GUI automation descriptor and bearer listener remain in the local user's temp directory and on
`127.0.0.1` respectively.

This is a control-plane claim, not a project-convergence claim. See `LAN-MCP.md` for setup, threat
model, commands, and current non-claims.

## Executable evidence

Run the cross-layer headless contract harness:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:mcp
# packaged binary self-description/protocol proof, without launching the GUI
node ..\scripts\mcp-harness.mjs --executable <absolute-Syzygy.exe>
```

It fails unless:

1. live Lexical reads return structured blocks and stable revisions;
2. replace/append operations change the same editor and reject a stale revision;
3. the loopback parser accepts an authenticated request and rejects browser origins;
4. MCP initialization negotiates the current `2025-11-25` protocol revision;
5. all twenty-one semantic tools are discoverable and route to their intended live operation;
6. self-description returns absolute paths and copy-ready configuration without a GUI;
7. platform contracts parse, keep provider-run/adversarial/plugin schemas strict, and do not
   overstate unimplemented runtimes; and
8. the actual compiled application binary speaks newline-delimited JSON-RPC over stdio without
   contaminating stdout.
9. research-state inspection rejects tampered hashes/lineage and omits synthetic secret bodies.

The harness uses a fake semantic live responder for protocol routing and the real Lexical editor
for mutation behavior. A packaged-app live smoke proof remains a separate release check because
it opens the user's actual WebView profile.

The 0.1.10 onboarding/self-description run is recorded in
`docs/audits/runs/MCP-SETUP-2026-07-14.json`, including the packaged executable path, tool count,
installer size, compile marker, and explicit test limitations.

For an explicit end-to-end proof against the current user's real app profile, build the app and
run `npm run test:mcp:live`. It launches the GUI if needed, creates a visible `MCP pilot` project,
replaces/appends its document, creates a scenario, adds/revises a turn, support/re-votes, runs a
flag/note create→edit→resolve→reopen lifecycle, deliberately attempts stale writes at every layer,
and reads bounded state back. Because this is a real mutation, it is deliberately excluded from CI
and must not be run without intending to keep the demonstration project.

## Design sources

The protocol behavior follows the public MCP specification and is implemented in Penumbra-owned
Rust/TypeScript code. No PolicyPad or Tiptap code, prompts, schemas, fixtures, UI, or automation
material is used. Protocol references checked 2026-07-14:

- <https://modelcontextprotocol.io/specification/2025-11-25>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
