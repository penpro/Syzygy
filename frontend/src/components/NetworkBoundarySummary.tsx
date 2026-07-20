import { NETWORK_BOUNDARY_ITEMS } from '../networkBoundaries'

export function NetworkBoundarySummary() {
  return (
    <section className="field" aria-label="Network boundaries">
      <span>What can use the network</span>
      <em className="hint">
        Syzygy is local-first. Network access follows the feature you choose; local AI can be disabled, and remote AI is never automatic.
      </em>
      <details>
        <summary>Review destinations and data</summary>
        <div className="form pad-sm">
          {NETWORK_BOUNDARY_ITEMS.map((item) => (
            <div className="field" key={item.id}>
              <strong>{item.label}</strong>
              <span className="subtle">{item.defaultState}</span>
              <em className="hint"><b>When:</b> {item.activation}</em>
              <em className="hint"><b>Where:</b> {item.destination}</em>
              <em className="hint"><b>Data:</b> {item.data}</em>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}
