import { useState } from 'react'
import type { ReactNode } from 'react'
import { CoronaMark } from './CoronaMark'
import { cx } from '../util'

// First-run welcome tour: a stepped, on-brand overlay that introduces what Syzygy can do.
// Feature-oriented (vs. the "How it works" architecture modal, which it links to on the last step).
// Auto-shows once; the "Don't show this again" checkbox controls whether it returns next launch.
export function WelcomeTour({
  onClose,
  onOpenArchitecture,
}: {
  onClose: (dontShowAgain: boolean) => void
  onOpenArchitecture: () => void
}) {
  const [i, setI] = useState(0)
  const [dontShow, setDontShow] = useState(true)

  const steps: { icon: ReactNode; title: string; body: ReactNode }[] = [
    {
      icon: <CoronaMark size={76} />,
      title: 'Welcome to Syzygy',
      body: 'A local-first AI workspace: the model runs entirely on your own GPU, and your conversations with it never leave this PC. Link Google Drive when you want to collaborate — sharing only what you put in the shared folder, only at your say-so.',
    },
    {
      icon: '🧭',
      title: 'Ask the right expert',
      body: 'Your question is quietly routed to a tuned expert — Code, Writing, Photography, and more — or you can choose one yourself. Edit the built-ins or add your own; it’s the same local model, wearing the right hat. The engine status, loaded model, and VRAM sit at the top right, so you always know what’s running.',
    },
    {
      icon: '📁',
      title: 'Bring your own knowledge',
      body: 'Grant a folder of PDFs or notes and the assistant answers from it — your files stay on disk; only the relevant passages are read into context. With a vision model added, it can also scan a folder of images and find the ones you describe.',
    },
    {
      icon: '📄',
      title: 'Make real documents',
      body: 'Describe what you want and get a polished PDF (math, tables, structure — via Typst) or a ready-to-use code / HTML / Markdown file, saved into your folder. You can also open and edit an existing file.',
    },
    {
      icon: '🔒',
      title: 'Local-first, by design',
      body: (
        <>
          Models, samplers, and updates all live in <b>Settings</b>. The AI itself is fully local — once a model is
          downloaded you can unplug the network and it keeps answering. Syzygy only reaches the internet for the
          things you explicitly ask for: model downloads, update checks, and Google Drive collaboration.{' '}
          <button
            type="button"
            className="welcome-arch"
            onClick={() => {
              onClose(dontShow)
              onOpenArchitecture()
            }}
          >
            See how Syzygy works ↗
          </button>
        </>
      ),
    },
  ]

  const last = i === steps.length - 1
  const step = steps[i]

  return (
    <div className="welcome-overlay" role="dialog" aria-modal="true" aria-label="Welcome to Syzygy">
      <div className="welcome-card">
        <div className="welcome-hero">
          {typeof step.icon === 'string' ? (
            <span className="welcome-step-icon" aria-hidden="true">
              {step.icon}
            </span>
          ) : (
            step.icon
          )}
        </div>

        <h2 className="welcome-title">{step.title}</h2>
        <div className="welcome-body">{step.body}</div>

        <div className="welcome-dots" role="tablist" aria-label="Tour steps">
          {steps.map((s, n) => (
            <button
              key={n}
              type="button"
              className={cx('welcome-dot', n === i && 'sel')}
              aria-label={`Step ${n + 1} of ${steps.length}`}
              aria-selected={n === i}
              onClick={() => setI(n)}
            />
          ))}
        </div>

        <label className="welcome-dsa">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          Don’t show this again
        </label>

        <div className="welcome-actions">
          <button className="btn ghost sm" onClick={() => onClose(dontShow)}>
            Skip
          </button>
          <div className="grow" />
          {i > 0 && (
            <button className="btn ghost sm" onClick={() => setI((n) => n - 1)}>
              Back
            </button>
          )}
          {last ? (
            <button className="btn sm" onClick={() => onClose(dontShow)}>
              Get started
            </button>
          ) : (
            <button className="btn sm" onClick={() => setI((n) => n + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
