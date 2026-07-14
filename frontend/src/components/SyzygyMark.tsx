/** Animated splash mark — the two satellites drift in from off-axis, reach alignment
 *  with the primary (a literal syzygy), and a sparkle fires at the moment of alignment.
 *  Base SVG positions ARE the aligned state, so reduced-motion (which kills the
 *  animation, see a11y.css) shows a clean static mark instead of a frozen mid-drift.
 *  Keyframes live in styles.css (.syz-*). */
export function SyzygySplashMark({ width = 300 }: { width?: number }) {
  return (
    <svg
      width={width}
      height={width * 0.45}
      viewBox="0 0 320 144"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ overflow: 'visible' }}
    >
      {/* orbital axis */}
      <line x1="10" y1="72" x2="310" y2="72" stroke="var(--text-2)" strokeWidth="2" opacity="0.55" />
      {/* satellites (ink) — drift in from off-axis, settle into alignment */}
      <circle className="syz-sat syz-sat-l" cx="66" cy="72" r="11" fill="var(--text)" />
      <circle className="syz-sat syz-sat-r" cx="254" cy="72" r="11" fill="var(--text)" />
      {/* primary (accent) — pulses at the moment of alignment */}
      <circle className="syz-core" cx="160" cy="72" r="21" fill="var(--accent)" />
      {/* the syzygy glint — a small, thin-rayed flare just off the primary's upper-right limb
          (the Penumbra flair, not an emoji star), firing at the moment of alignment */}
      <g className="syz-spark" transform-origin="183 49">
        <path d="M183 36 L184.6 47.4 L196 49 L184.6 50.6 L183 62 L181.4 50.6 L170 49 L181.4 47.4 Z" fill="var(--violet)" />
        <circle cx="191" cy="41" r="1.6" fill="var(--violet)" opacity="0.8" />
      </g>
    </svg>
  )
}

/** The Syzygy mark — three celestial bodies in alignment on a horizontal axis
 *  (a literal syzygy): two ink satellites flanking an Observatory-Blue primary.
 *  Colors ride the theme tokens so the mark works on paper and void alike. */
export function SyzygyMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size * 2.4}
      height={size}
      viewBox="0 0 96 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* orbital axis */}
      <line x1="2" y1="20" x2="94" y2="20" stroke="var(--text-2)" strokeWidth="1.6" />
      {/* flanking bodies (ink) */}
      <circle cx="16" cy="20" r="7" fill="var(--text)" />
      <circle cx="80" cy="20" r="7" fill="var(--text)" />
      {/* primary (accent) */}
      <circle cx="48" cy="20" r="12" fill="var(--accent)" />
    </svg>
  )
}
