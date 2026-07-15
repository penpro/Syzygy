# Live Syzygy MCP

Syzygy's installed application binary is also a local MCP server. Launching it with `--mcp`
starts a stdio MCP process; launching it normally starts the desktop UI. The MCP does not open a
second project database or scrape pixels. It sends semantic operations to the running Syzygy
window, which remains the owner of project navigation, Lexical editor state, Yjs, and IndexedDB.

This is an automation and interoperability surface, not a claim that unfinished research
features exist. `syzygy_status` and `workspace_walkthrough` explicitly report the difference
between the usable local project/editor slice and the still-disabled versions, scenarios,
evaluation, Drive project transport, and real-time presence slices.

## Connect an MCP host

Configure a local stdio server using the full path to the installed Syzygy executable:

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
| `workspace_walkthrough` | no | State-aware explanation of the current use case and next step |
| `list_projects` | no | Stable IDs, titles, archive state, transport, active project |
| `create_project` | yes | Creates and opens a local project with a non-empty title |
| `open_project` | navigation | Opens a non-archived project by stable ID |
| `rename_project` | yes | Changes project metadata only |
| `read_active_project` | no | Returns the manifest plus structured blocks, plain text, and a revision |
| `replace_active_document` | yes | Replaces the document only when `expectedRevision` still matches |
| `append_active_document` | yes | Appends blocks only when `expectedRevision` still matches |

Automation document text has a deliberately small, deterministic format: `# ` for heading 1,
`## ` for heading 2, `> ` for a quotation, and other lines for paragraphs. It does not pretend
to round-trip editor features Syzygy has not implemented.

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

## Executable evidence

Run the cross-layer headless contract harness:

```powershell
cd D:\PolicyPad\syzygy\frontend
npm run test:mcp
```

It fails unless:

1. live Lexical reads return structured blocks and stable revisions;
2. replace/append operations change the same editor and reject a stale revision;
3. the loopback parser accepts an authenticated request and rejects browser origins;
4. MCP initialization negotiates the current `2025-11-25` protocol revision;
5. all semantic tools are discoverable and route to their intended live operation; and
6. the actual compiled application binary speaks newline-delimited JSON-RPC over stdio without
   contaminating stdout.

The harness uses a fake semantic live responder for protocol routing and the real Lexical editor
for mutation behavior. A packaged-app live smoke proof remains a separate release check because
it opens the user's actual WebView profile.

For an explicit end-to-end proof against the current user's real app profile, build the app and
run `npm run test:mcp:live`. It launches the GUI if needed, creates a visible `MCP pilot` project,
replaces and appends its document through MCP, deliberately attempts a stale overwrite, and reads
the surviving live draft back. Because this is a real mutation, it is deliberately excluded from
CI and must not be run without intending to keep the demonstration project.

## Design sources

The protocol behavior follows the public MCP specification and is implemented in Penumbra-owned
Rust/TypeScript code. No PolicyPad or Tiptap code, prompts, schemas, fixtures, UI, or automation
material is used. Protocol references checked 2026-07-14:

- <https://modelcontextprotocol.io/specification/2025-11-25>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
