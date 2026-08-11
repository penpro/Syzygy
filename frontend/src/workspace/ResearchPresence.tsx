import { useEffect, useMemo, useRef, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import {
  collaborationIdentitySignPresence,
  type DevicePresenceProof,
  type PresenceIdentityClaim,
} from '../tauri'
import {
  createPresenceSessionNonce,
  devicePresenceProofCacheKey,
  MAX_DEVICE_PROOF_CACHE_ENTRIES,
  MAX_DEVICE_PROOF_VERIFICATIONS,
  type DeviceProofStatus,
  verifyDevicePresenceProof,
} from './deviceIdentity'
import type { PresenceInspection } from './presenceModel'
import { inspectAwareness } from './presenceModel'
import {
  getProjectPresence,
  subscribeProjectPresence,
  type PresenceTransportMode,
  type RegisteredProjectPresence,
} from './presenceRegistry'

function proofLabel(status: DeviceProofStatus | undefined): string {
  if (status === 'verified-device') return ' · signed device'
  if (status === 'invalid') return ' · invalid device proof'
  if (status === 'unavailable') return ' · signature not checked'
  if (status === 'checking') return ' · checking signature'
  return ' · unsigned device'
}

export function installSignedPresencePublisher(
  awareness: Awareness,
  context: { projectId: string; documentId: string; participantId: string },
  sign: (claim: PresenceIdentityClaim) => Promise<DevicePresenceProof> = collaborationIdentitySignPresence,
  sessionNonce = createPresenceSessionNonce(),
): () => void {
  let disposed = false
  let attempted = false
  let signing = false
  let signedAwarenessData: Record<string, unknown> | null = null
  const ensureSignedState = () => {
    if (disposed || signing) return
    const current = awareness.getLocalState() as Record<string, unknown> | null
    const awarenessData = current?.awarenessData
    if (!awarenessData || typeof awarenessData !== 'object' || Array.isArray(awarenessData)) return
    const syzygy = (awarenessData as Record<string, unknown>).syzygy
    if (!syzygy || typeof syzygy !== 'object' || Array.isArray(syzygy) ||
      (syzygy as Record<string, unknown>).participantId !== context.participantId) return
    if ((syzygy as Record<string, unknown>).schemaVersion === 2) return
    if (signedAwarenessData) {
      awareness.setLocalStateField('awarenessData', signedAwarenessData)
      return
    }
    if (attempted) return
    signing = true
    attempted = true
    void sign({
      schemaVersion: 1,
      projectId: context.projectId,
      documentId: context.documentId,
      participantId: context.participantId,
      awarenessClientId: awareness.doc.clientID,
      sessionNonce,
    }).then((deviceProof) => {
      if (disposed) return
      signing = false
      signedAwarenessData = {
        syzygy: { schemaVersion: 2, participantId: context.participantId, deviceProof },
      }
      awareness.setLocalStateField('awarenessData', signedAwarenessData)
    }).catch(() => {
      signing = false
      // Collaboration remains usable with the explicit legacy unsigned-device state.
    })
  }
  awareness.on('change', ensureSignedState)
  ensureSignedState()
  return () => {
    disposed = true
    awareness.off('change', ensureSignedState)
  }
}

export function ResearchPresenceView({
  mode,
  inspection,
  proofStatuses = new Map(),
}: {
  mode: PresenceTransportMode | null
  inspection: PresenceInspection | null
  proofStatuses?: ReadonlyMap<number, DeviceProofStatus>
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
              {participant.displayName}
              {participant.local ? ' · this device' : participant.focusing ? ' · editing' : ' · viewing'}
              {live ? proofLabel(proofStatuses.get(participant.clientId)) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!inspection.healthy ? (
        <span className="presence-warning" role="alert">
          {inspection.invalidRecords} invalid or excess presence record{inspection.invalidRecords === 1 ? '' : 's'} hidden.
        </span>
      ) : null}
      {live ? (
        <small>
          Presence is ephemeral. Signed device means this session proved possession of an installation key;
          it does not verify a person. Names remain self-reported.
        </small>
      ) : null}
    </section>
  )
}

export function ResearchPresence({
  projectId,
  documentId,
  participantId,
}: {
  projectId: string
  documentId: string
  participantId: string
}) {
  const [registration, setRegistration] = useState<RegisteredProjectPresence | null>(
    () => getProjectPresence(projectId),
  )
  const [awarenessRevision, setAwarenessRevision] = useState(0)
  const [proofStatuses, setProofStatuses] = useState<ReadonlyMap<number, DeviceProofStatus>>(new Map())
  const verificationCache = useRef(new Map<string, DeviceProofStatus>())
  const pendingVerifications = useRef(new Map<string, Promise<DeviceProofStatus>>())

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

  useEffect(() => {
    verificationCache.current.clear()
    pendingVerifications.current.clear()
  }, [registration])

  useEffect(() => {
    if (!registration || registration.mode !== 'live') return
    try {
      return installSignedPresencePublisher(registration.awareness, { projectId, documentId, participantId })
    } catch {
      // A runtime without secure randomness retains explicit unsigned-device presence.
    }
  }, [documentId, participantId, projectId, registration])

  const inspection = useMemo(
    () => registration ? inspectAwareness(registration.awareness) : null,
    [registration, awarenessRevision],
  )

  useEffect(() => {
    let disposed = false
    if (!registration || registration.mode !== 'live' || !inspection) {
      setProofStatuses(new Map())
      return () => { disposed = true }
    }
    const next = new Map<number, DeviceProofStatus>()
    const pending: Promise<void>[] = []
    for (const participant of inspection.participants) {
      if (!participant.deviceProof) {
        next.set(participant.clientId, 'unsigned')
        continue
      }
      const expected = {
        projectId,
        documentId,
        participantId: participant.participantId,
        awarenessClientId: participant.clientId,
      }
      const cacheKey = devicePresenceProofCacheKey(participant.deviceProof, expected)
      const cached = verificationCache.current.get(cacheKey)
      if (cached) {
        next.set(participant.clientId, cached)
        continue
      }
      let verification = pendingVerifications.current.get(cacheKey)
      if (!verification && pendingVerifications.current.size >= MAX_DEVICE_PROOF_VERIFICATIONS) {
        next.set(participant.clientId, 'unavailable')
        continue
      }
      next.set(participant.clientId, 'checking')
      if (!verification) {
        verification = verifyDevicePresenceProof(participant.deviceProof, expected).then((status) => {
          if (verificationCache.current.size >= MAX_DEVICE_PROOF_CACHE_ENTRIES) {
            verificationCache.current.clear()
          }
          verificationCache.current.set(cacheKey, status)
          return status
        }).finally(() => {
          if (pendingVerifications.current.get(cacheKey) === verification) {
            pendingVerifications.current.delete(cacheKey)
          }
        })
        pendingVerifications.current.set(cacheKey, verification)
      }
      pending.push(verification.then((status) => {
        next.set(participant.clientId, status)
      }))
    }
    setProofStatuses(new Map(next))
    void Promise.all(pending).then(() => {
      if (!disposed) setProofStatuses(new Map(next))
    })
    return () => { disposed = true }
  }, [documentId, inspection, projectId, registration])

  return (
    <ResearchPresenceView
      mode={registration?.mode ?? null}
      inspection={inspection}
      proofStatuses={proofStatuses}
    />
  )
}
