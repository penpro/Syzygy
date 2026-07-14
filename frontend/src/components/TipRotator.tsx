import { useEffect, useState } from 'react'

// Small rotating helper tips above the sidebar footer menu. Advances on a timer (~5 min) and on
// click. Copy stays accurate to where things actually live: "below" = the footer menu right under it.
const TIPS: string[] = [
  'We ship updates often — open Settings below and hit “Check for updates.”',
  'Lost? Replay the walkthrough anytime with Quick tour, just below.',
  'Your question is routed to the right expert automatically — or pick one yourself up top.',
  'Experts are editable — tweak a built-in’s rules or add your own from the expert picker.',
  'It’s all local: once a model is downloaded, Syzygy keeps working with the internet unplugged.',
  'Grant a folder of PDFs or notes and the assistant answers from your own documents.',
  'Ask for a PDF, code file, or Markdown doc and it lands right in your granted folder.',
  'Add a vision model in Settings and the assistant can describe and search your images.',
  'Fine-tune the model under Settings → Advanced sampling; every knob has an explainer.',
  'Change the whole look under Settings → Theme — five accent presets to choose from.',
]

const ROTATE_MS = 5 * 60 * 1000

export function TipRotator() {
  // Vary the starting tip by wall-clock so it isn't always the same one on launch.
  const [i, setI] = useState(() => Math.floor(Date.now() / ROTATE_MS) % TIPS.length)

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % TIPS.length), ROTATE_MS)
    return () => clearInterval(t)
  }, [])

  return (
    <button
      type="button"
      className="side-tip"
      title="Tip — click for another"
      onClick={() => setI((n) => (n + 1) % TIPS.length)}
    >
      <span className="side-tip-icon" aria-hidden="true">
        💡
      </span>
      <span className="side-tip-text" key={i}>
        {TIPS[i]}
      </span>
    </button>
  )
}
