import { Modal } from './Modal'

const PIECES: { icon: string; title: string; body: string }[] = [
  {
    icon: '⌨️',
    title: 'You → the interface',
    body: 'You type a prompt. The app bundles it with the active expert’s rules, the conversation so far, and any relevant passages from folders you’ve granted.',
  },
  {
    icon: '🧠',
    title: 'The model (GGUF)',
    body: "An open-weights model file — SuperGemma4, Gemma 3, and friends. It's the actual brain, quantized down to fit in your GPU's VRAM.",
  },
  {
    icon: '⚙️',
    title: 'llama.cpp engine',
    body: 'A tiny server bundled inside the app. It loads the model onto your GPU and streams tokens back, running hidden on 127.0.0.1 — no console window, no cloud.',
  },
  {
    icon: '🗃️',
    title: 'Knowledge & context',
    body: 'Grant a folder and its documents become searchable reference: only the passages relevant to your question are read into the model’s context — the files themselves never leave disk.',
  },
  {
    icon: '🎛️',
    title: 'Samplers',
    body: 'Temperature, top-p, penalties and friends decide how the model picks each next word. Tune them under Settings → Advanced sampling — every knob has an explainer.',
  },
  {
    icon: '🔒',
    title: 'Local-first by design',
    body: 'The whole AI loop runs on your PC — your prompts and the model\'s answers never leave the machine. Only the things you explicitly invoke touch the internet: model downloads, update checks, and Google Drive collaboration.',
  },
]

export function Tutorial({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="How Syzygy works"
      onClose={onClose}
      wide
      footer={
        <div className="row full">
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            Got it
          </button>
        </div>
      }
    >
      <div className="tut">
        <p className="muted tut-intro">
          Four pieces, all on your own machine — from your keystroke to the model on your GPU and back.
        </p>

        <div className="tut-flow">
          <svg viewBox="0 0 620 175" width="100%" role="img" aria-label="Flow: you, to the Syzygy interface, to the llama.cpp engine, to the model on your GPU — all running locally and offline.">
            <defs>
              <marker id="tut-ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
              </marker>
              <marker id="tut-ahm" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent-2)" />
              </marker>
            </defs>

            <rect x="146" y="26" width="466" height="120" rx="10" fill="none" stroke="var(--border-2)" strokeDasharray="4 4" />
            <text x="152" y="20" fill="var(--muted)" fontSize="9.5" fontFamily="var(--font-mono)" letterSpacing="2">YOUR PC · AI LOOP 100% LOCAL</text>

            <g fontFamily="'JetBrains Mono', monospace" textAnchor="middle">
              <rect x="6" y="50" width="120" height="56" rx="8" fill="var(--panel)" stroke="var(--border-2)" />
              <text x="66" y="80" fill="var(--text)" fontSize="12" fontWeight="600">You</text>
              <text x="66" y="96" fill="var(--muted)" fontSize="9.5">your prompt</text>

              <rect x="156" y="50" width="130" height="56" rx="8" fill="var(--panel)" stroke="var(--border-2)" />
              <text x="221" y="80" fill="var(--text)" fontSize="12" fontWeight="600">Syzygy</text>
              <text x="221" y="96" fill="var(--muted)" fontSize="9.5">builds the request</text>

              <rect x="312" y="50" width="130" height="56" rx="8" fill="var(--panel)" stroke="var(--accent)" strokeWidth="1.4" />
              <text x="377" y="80" fill="var(--accent)" fontSize="12" fontWeight="600">llama.cpp</text>
              <text x="377" y="96" fill="var(--muted)" fontSize="9.5">127.0.0.1 · hidden</text>

              <rect x="468" y="50" width="138" height="56" rx="8" fill="var(--panel)" stroke="var(--accent-2)" />
              <text x="537" y="80" fill="var(--accent-2)" fontSize="12" fontWeight="600">Model · GPU</text>
              <text x="537" y="96" fill="var(--muted)" fontSize="9.5">GGUF on your GPU</text>
            </g>

            <line x1="126" y1="78" x2="154" y2="78" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#tut-ah)" />
            <line x1="286" y1="78" x2="310" y2="78" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#tut-ah)" />
            <line x1="442" y1="78" x2="466" y2="78" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#tut-ah)" />

            <path d="M537 106 L537 132 L223 132 L223 108" fill="none" stroke="var(--accent-2)" strokeWidth="1.4" strokeDasharray="3 3" markerEnd="url(#tut-ahm)" />
            <text x="380" y="127" fill="var(--accent-2)" fontSize="9.5" fontFamily="var(--font-mono)" textAnchor="middle">streamed tokens</text>
          </svg>
        </div>

        <div className="tut-grid">
          {PIECES.map((p) => (
            <div className="tut-card" key={p.title}>
              <h4>
                <span aria-hidden="true">{p.icon}</span> {p.title}
              </h4>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
