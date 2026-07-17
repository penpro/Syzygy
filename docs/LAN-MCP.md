# Syzygy LAN MCP control plane

Syzygy can expose two or more installed applications to one MCP-capable test host on a private
local network. This is an offline-capable **control and test plane**. It does not yet synchronize
the projects stored in each installation's IndexedDB; Drive-backed or WebSocket-backed Yjs remains
the project transport milestone.

## Shape

```text
ChatGPT / Codex
  `- stdio MCP: lan-mcp-host.mjs on the primary computer
       |- encrypted coordinator on one explicit private-LAN address
       |- Syzygy.exe --lan-agent (primary computer)
       |    `- Syzygy.exe --mcp -> authenticated 127.0.0.1 GUI bridge
       `- Syzygy.exe --lan-agent (second computer)
            `- Syzygy.exe --mcp -> authenticated 127.0.0.1 GUI bridge
```

The app's GUI bridge never listens on the LAN. Each packaged agent connects outbound, starts the
installed binary's normal stdio MCP mode, and forwards only MCP JSON-RPC. The coordinator exposes
four stable tools:

- `lan_nodes` lists authenticated installations.
- `lan_node_tools` discovers the native tools on one installation.
- `lan_call` invokes one native tool on one installation. Native revision guards still apply.
- `lan_probe` runs bounded read-only status and tool discovery on every connected installation.

## Security contract

- The coordinator binds `127.0.0.1` unless an explicit address is provided. For LAN use, bind the
  primary computer's private address, not `0.0.0.0` and never a public interface.
- A 256-bit pairing key is read from a file, not accepted on the command line. Copy that file to
  the second computer through a trusted local channel. Do not put it in the repository or Drive.
- A fresh server and client nonce authenticate the node with HMAC-SHA-256. HKDF-SHA-256 derives
  direction-specific session keys. Every subsequent frame uses AES-256-GCM with a monotonic
  replay counter bound into authenticated additional data.
- Frames are capped at 12 MiB. Operations default to 20 seconds and cannot exceed 60 seconds.
  Heartbeats run every 15 seconds and the coordinator evicts a silent node after 45 seconds.
- A node ID is a routing label, not a human identity or authorization claim. Possession of the
  pairing key authorizes access to the native MCP tools available on that installation.
- The control plane does not add ambient Drive, filesystem, model, or credential authority. Each
  native Syzygy tool keeps its existing proposal, confirmation, revision, and disclosure boundary.

Use this only on a trusted private LAN. Prefer an isolated research VLAN for sensitive work. The
pairing key protects and encrypts the protocol but cannot make a compromised endpoint trustworthy.

## One-time setup

On the primary development computer, create the key file once:

```powershell
node D:\PolicyPad\syzygy\scripts\lan-pairing-key.mjs --out "$env:USERPROFILE\.syzygy-lan.key"
```

Copy that file securely to the second computer. Record the primary computer's private IPv4
address, for example `192.168.1.20`. Allow inbound TCP port `37663` only on the Windows **Private**
network profile and only from the office subnet. Do not configure router port forwarding.

The installed executable path is available in **Settings -> Connect an LLM** or through the local
`syzygy_installation` MCP tool.

## Configure ChatGPT/Codex on the primary computer

The host wrapper starts both the coordinator and the primary computer's packaged agent. Use this
stdio MCP shape, replacing the private address, executable, Node, and key paths:

```toml
[mcp_servers.syzygy_lan]
command = "C:\\Program Files\\nodejs\\node.exe"
args = [
  "D:\\PolicyPad\\syzygy\\scripts\\lan-mcp-host.mjs",
  "--listen", "192.168.1.20",
  "--port", "37663",
  "--key-file", "C:\\Users\\you\\.syzygy-lan.key",
  "--local-executable", "C:\\Program Files\\Syzygy\\Syzygy.exe",
  "--local-node-id", "office-primary"
]
```

Restart or reconnect the MCP host after changing its configuration. The coordinator remains alive
for the lifetime of the MCP process.

## Join the second installed computer

Open PowerShell on the second computer and run:

```powershell
& "C:\Program Files\Syzygy\Syzygy.exe" `
  --lan-agent `
  --node-id office-secondary `
  --coordinator 192.168.1.20 `
  --port 37663 `
  --key-file "$env:USERPROFILE\.syzygy-lan.key"
```

The agent reconnects with bounded exponential backoff if the coordinator restarts. Keep the
PowerShell process running for this initial development slice. A later UI/startup task can install
the agent as an opt-in background launch item after the two-computer live proof.

Ask the MCP host to call `lan_nodes`, then `lan_probe`. If a GUI is closed, call the native
`launch_syzygy` tool on that node through `lan_call`, then probe again.

## Headless evidence

All commands should be supervised through the repository watchdog:

```powershell
cd D:\PolicyPad\syzygy
node scripts\run-with-heartbeat.mjs --timeout-seconds 60 --heartbeat-seconds 15 -- node --test scripts\lan-bridge.test.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 90 --heartbeat-seconds 15 -- node scripts\lan-mcp-harness.mjs
node scripts\run-with-heartbeat.mjs --timeout-seconds 90 --heartbeat-seconds 15 -- node scripts\lan-packaged-agent-harness.mjs
```

The first suite checks authentication, key separation, encryption, tamper detection, replay
rejection, identity bounds, and deadlines. The second starts a coordinator and two isolated fake
installations, proves independent mutation routing, rejects an invalid key, and proves disconnect
cleanup. The third connects the compiled Rust `Syzygy.exe --lan-agent` to the Node coordinator,
discovers all native MCP tools, and calls installation self-description through the encrypted path.

## Honest current limit

This proves that one autonomous harness can inspect and drive two real installations. It does not
prove that a mutation on one installation appears on the other. That convergence gate belongs to
the future Drive/WebSocket Yjs provider and must use two clean installed profiles over this control
plane before project synchronization is claimed.
