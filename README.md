<p align="center"><strong>Syzygy — a private, local-first AI workspace for real documents. Free. No account required.</strong></p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-5EEAD4" />
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-22D3EE" />
  <img alt="Local AI" src="https://img.shields.io/badge/AI-100%25_local-FF79C6" />
</p>

---

**Syzygy** is a desktop app that pairs a local AI model (running entirely on your own GPU, via a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) engine) with real access to your documents and folders:

- **Ask a tuned expert** — your question is routed to the right expert rule-set (Code, Writing, Photography, and more), or pick one yourself. Experts are editable and you can add your own.
- **Bring your own knowledge** — grant a folder of PDFs or notes and the assistant answers from them. Files stay on disk; only relevant passages enter the model's context.
- **Make real documents** — ask for a polished PDF (via Typst), or a code / HTML / Markdown file, saved straight into your folder.
- **See images (optional)** — add a vision model and it can describe images or search a folder for the ones matching a description.
- **Private by default** — no account, no telemetry. After the one-time model download it works with the network unplugged.
- **Google Drive (optional, in progress)** — choose a Drive workspace for direct shared research. Syzygy exports Docs, Sheets, and Slides into local-model context without requiring a mirror; OAuth tokens remain in the Rust core. Google does not offer a folder-only scope for this desktop flow, so the app discloses its broader collaboration grant and constrains operations to the folder you select.
- **Live MCP automation (in progress)** — the installed executable can run as a local stdio MCP server and semantically pilot the running project/editor. Settings detects the exact installation and generates copy-ready JSON/TOML configuration and prompts. Reads and revision-guarded writes go through the live app rather than a second mirror; unfinished workspace capabilities are reported as unavailable.

> *Syzygy (n.) — an alignment of celestial bodies. Sister app to [Aphelion](https://github.com/penpro/Aphelion), Penumbra's local-AI studio: Aphelion is your AI at the farthest point from the cloud; Syzygy is where people and documents come into alignment.*

**Where this is heading:** a free, local-first collaborative research workspace with an independently built Penumbra editor, local AI, and pluggable sync (Drive / self-hosted / P2P). No Tiptap or PolicyPad code, templates, prompts, schemas, fixtures, or assets are used.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The mental model: shell, Rust core, frontend, persistence, invariants |
| [docs/DESIGN.md](docs/DESIGN.md) | Design system: palette, type, theming rules, motion, copy voice |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev/build/release processes, secrets & keys, the gotcha table |
| [docs/GOOGLE-DRIVE.md](docs/GOOGLE-DRIVE.md) | Drive auth + folder-mirror sync, Google quirks, limitations |
| [docs/MCP.md](docs/MCP.md) | Embedded live-app MCP tools, connection shape, security boundary, and headless proof |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Lineage, shipped versions, what's next, decision log |
| [docs/END-GOAL-PLAN.md](docs/END-GOAL-PLAN.md) | Independent end-goal delivery plan, hard gates, tests, and adversarial audit protocol |
| [docs/audits/](docs/audits/) | Machine-readable capability status, provenance, data flow, threat model, and decision records |

## Build from source

**Prerequisites:** [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) 18+, and VS C++ Build Tools.

```powershell
git clone https://github.com/penpro/Syzygy
cd Syzygy/frontend
npm install
npm run fetch-engine     # one-time: downloads the bundled llama.cpp + Typst binaries (run from PowerShell)
npm run tauri dev        # or: npm run tauri build  → installer in src-tauri/target/release/bundle/nsis/
```

**Stack:** [Tauri v2](https://tauri.app/) (Rust + React 18 / TypeScript / Vite), bundled llama.cpp (Vulkan), GGUF models downloaded in-app. The engine listens only on `127.0.0.1` — nothing is exposed to your network.

## Credits & license

- **Syzygy** is a product of **Penumbra**, built on the [Aphelion](https://github.com/penpro/Aphelion) shell.
- Inference by [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT). PDF output by [Typst](https://typst.app/).
- AI models are downloaded from their original publishers and remain under **their own licenses**.

License: **[MIT](LICENSE)**.
