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
      {/* the syzygy sparkle — a four-point star + its 45° echo, firing on alignment */}
      <g className="syz-spark" transform-origin="160 72">
        <path
          d="M160 34 L165 65 L196 72 L165 79 L160 110 L155 79 L124 72 L155 65 Z"
          fill="var(--violet)"
        />
        <path
          d="M160 50 L163 68 L182 72 L163 76 L160 94 L157 76 L138 72 L157 68 Z"
          fill="var(--on-accent)"
          opacity="0.9"
          transform="rotate(45 160 72)"
        />
      </g>
      {/* two little echo twinkles, slightly delayed */}
      <g className="syz-spark syz-spark-echo" transform-origin="216 40">
        <path d="M216 30 L218 38 L226 40 L218 42 L216 50 L214 42 L206 40 L214 38 Z" fill="var(--violet)" />
      </g>
      <g className="syz-spark syz-spark-echo2" transform-origin="106 106">
        <path d="M106 98 L108 104 L114 106 L108 108 L106 114 L104 108 L98 106 L104 104 Z" fill="var(--accent-2)" />
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
