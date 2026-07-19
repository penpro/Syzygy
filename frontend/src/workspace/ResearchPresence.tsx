import { useEffect, useMemo, useState } from 'react'
import type { PresenceInspection } from './presenceModel'
import { inspectAwareness } from './presenceModel'
import {
  getProjectPresence,
  subscribeProjectPresence,
  type PresenceTransportMode,
  type RegisteredProjectPresence,
} from './presenceRegistry'

export function ResearchPresenceView({
  mode,
  inspection,
}: {
  mode: PresenceTransportMode | null
  inspection: PresenceInspection | null
}) {
  if (!mode || !inspection) {
    return <section className="research-presence" aria-label="Collaboration presence"><span>Presence starting…</span></section>
  }
  const live = mode === 'live'
  const status = mode === 'drive-polling'
    ? 'Drive sync shares edits, but this transport does not provide live cursors or online status.'
    : mode === 'local-only'
      ? 'This project is local. No remote editing sessions are connected.'
      : `${inspection.participants.length} live editing session${inspection.participants.length === 1 ? '' : 's'}.`
  return (
    <section className="research-presence" aria-label="Collaboration presence" data-presence-mode={mode}>
      <div>
        <strong>Presence</strong>
        <span>{status}</span>
      </div>
      {inspection.participants.length > 0 ? (
        <ul aria-label="Editing sessions">
          {inspection.participants.map((participant) => (
            <li key={participant.clientId}>
              <span className="presence-dot" aria-hidden="true" />
              {participant.displayName}{participant.local ? ' · this device' : participant.focusing ? ' · editing' : ' · viewing'}
            </li>
          ))}
        </ul>
      ) : null}
      {!inspection.healthy ? (
        <span className="presence-warning" role="alert">
          {inspection.invalidRecords} invalid or excess presence record{inspection.invalidRecords === 1 ? '' : 's'} hidden.
        </span>
      ) : null}
      {live ? <small>Presence is ephemeral. Collaborator names are self-reported, not authenticated.</small> : null}
    </section>
  )
}

export function ResearchPresence({ projectId }: { projectId: string }) {
  const [registration, setRegistration] = useState<RegisteredProjectPresence | null>(
    () => getProjectPresence(projectId),
  )
  const [awarenessRevision, setAwarenessRevision] = useState(0)
  useEffect(() => {
    setRegistration(getProjectPresence(projectId))
    return subscribeProjectPresence(projectId, () => setRegistration(getProjectPresence(projectId)))
  }, [projectId])
  useEffect(() => {
    if (!registration) return
    const update = () => setAwarenessRevision((value) => value + 1)
    registration.awareness.on('change', update)
    update()
    return () => registration.awareness.off('change', update)
  }, [registration])
  const inspection = useMemo(
    () => registration ? inspectAwareness(registration.awareness) : null,
    [registration, awarenessRevision],
  )
  return <ResearchPresenceView mode={registration?.mode ?? null} inspection={inspection} />
}
