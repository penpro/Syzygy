import { useEffect, useMemo, useRef, useState } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import {
  collaborationDeviceTrustChange,
  collaborationDeviceTrustStatus,
  collaborationIdentitySignPresence,
  type DevicePresenceProof,
  type DeviceTrustReport,
  type DeviceTrustStatus,
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
import type { PresenceInspection, PresenceParticipant } from './presenceModel'
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

type DeviceTrustUiStatus = DeviceTrustStatus | 'checking' | 'unavailable'

function trustLabel(status: DeviceTrustUiStatus | undefined): string {
  if (status === 'approved') return ' · key approved locally'
  if (status === 'revoked') return ' · key revoked locally'
  if (status === 'unavailable') return ' · approval not checked'
  if (status === 'checking') return ' · checking local approval'
  return ' · key not approved'
}

function shortFingerprint(participant: PresenceParticipant): string | null {
  const fingerprint = participant.deviceProof?.keyId.replace(/^ed25519-sha256:/, '')
  return fingerprint ? fingerprint.slice(0, 12) : null
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
  trustStatuses = new Map(),
  busyKeyId = null,
  onApproveDevice,
  onRevokeDevice,
  trustError = null,
}: {
  mode: PresenceTransportMode | null
  inspection: PresenceInspection | null
  proofStatuses?: ReadonlyMap<number, DeviceProofStatus>
  trustStatuses?: ReadonlyMap<number, DeviceTrustUiStatus>
  busyKeyId?: string | null
  onApproveDevice?: (participant: PresenceParticipant) => void
  onRevokeDevice?: (participant: PresenceParticipant) => void
  trustError?: string | null
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
          {inspection.participants.map((participant) => {
            const proofStatus = proofStatuses.get(participant.clientId)
            const trustStatus = trustStatuses.get(participant.clientId)
            const fingerprint = shortFingerprint(participant)
            const actionable = live && !participant.local && proofStatus === 'verified-device' &&
              participant.deviceProof && trustStatus !== 'checking' && trustStatus !== 'unavailable'
            return (
              <li key={participant.clientId}>
                <span className="presence-dot" aria-hidden="true" />
                {participant.displayName}
                {participant.local ? ' · this device' : participant.focusing ? ' · editing' : ' · viewing'}
                {live ? proofLabel(proofStatus) : null}
                {live && !participant.local && proofStatus === 'verified-device' ? trustLabel(trustStatus) : null}
                {fingerprint && live && proofStatus === 'verified-device' ? (
                  <span className="mono subtle" title={participant.deviceProof?.keyId}>key {fingerprint}</span>
                ) : null}
                {actionable && trustStatus === 'approved' && onRevokeDevice ? (
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={busyKeyId !== null}
                    aria-label={`Revoke ${participant.displayName} device key on this installation`}
                    onClick={() => onRevokeDevice(participant)}
                  >
                    Revoke key
                  </button>
                ) : actionable && onApproveDevice ? (
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={busyKeyId !== null}
                    aria-label={`${trustStatus === 'revoked' ? 'Re-approve' : 'Approve'} ${participant.displayName} device key on this installation`}
                    onClick={() => onApproveDevice(participant)}
                  >
                    {trustStatus === 'revoked' ? 'Re-approve key' : 'Approve key'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {!inspection.healthy ? (
        <span className="presence-warning" role="alert">
          {inspection.invalidRecords} invalid or excess presence record{inspection.invalidRecords === 1 ? '' : 's'} hidden.
        </span>
      ) : null}
      {trustError ? <span className="presence-warning" role="alert">{trustError}</span> : null}
      {live ? (
        <small>
          Presence is ephemeral. Signed device means this session proved possession of an installation key;
          it does not verify a person. Names remain self-reported. Approvals and revocations apply only
          to this installation and project; they do not grant or remove relay access.
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
  const [trustReport, setTrustReport] = useState<DeviceTrustReport | null>(null)
  const [trustRegistryState, setTrustRegistryState] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [trustError, setTrustError] = useState<string | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)
  const trustMutationInFlight = useRef(false)
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
    let disposed = false
    setTrustReport(null)
    setTrustError(null)
    if (!registration || registration.mode !== 'live') {
      setTrustRegistryState('ready')
      return () => { disposed = true }
    }
    setTrustRegistryState('checking')
    void collaborationDeviceTrustStatus(projectId).then((next) => {
      if (disposed) return
      setTrustReport(next)
      setTrustRegistryState('ready')
    }).catch(() => {
      if (!disposed) setTrustRegistryState('unavailable')
    })
    return () => { disposed = true }
  }, [projectId, registration])

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

  const trustStatuses = useMemo(() => {
    const next = new Map<number, DeviceTrustUiStatus>()
    const decisions = new Map(trustReport?.decisions.map((decision) => [decision.keyId, decision.status]) ?? [])
    for (const participant of inspection?.participants ?? []) {
      if (participant.local || proofStatuses.get(participant.clientId) !== 'verified-device' ||
        !participant.deviceProof) continue
      next.set(
        participant.clientId,
        trustRegistryState === 'ready'
          ? decisions.get(participant.deviceProof.keyId) ?? 'unapproved'
          : trustRegistryState,
      )
    }
    return next
  }, [inspection, proofStatuses, trustRegistryState, trustReport])

  const changeTrust = async (participant: PresenceParticipant, action: 'approve' | 'revoke') => {
    if (trustMutationInFlight.current) return
    const proof = participant.deviceProof
    if (!proof || participant.local || proofStatuses.get(participant.clientId) !== 'verified-device' ||
      trustRegistryState !== 'ready') return
    const current = trustReport?.decisions.find((decision) => decision.keyId === proof.keyId)?.status ?? 'unapproved'
    if ((action === 'approve' && current === 'approved') || (action === 'revoke' && current !== 'approved')) return
    trustMutationInFlight.current = true
    setBusyKeyId(proof.keyId)
    setTrustError(null)
    try {
      setTrustReport(await collaborationDeviceTrustChange(projectId, proof.keyId, current, action))
    } catch (error) {
      setTrustError(error instanceof Error ? error.message : String(error))
    } finally {
      trustMutationInFlight.current = false
      setBusyKeyId(null)
    }
  }

  return (
    <ResearchPresenceView
      mode={registration?.mode ?? null}
      inspection={inspection}
      proofStatuses={proofStatuses}
      trustStatuses={trustStatuses}
      busyKeyId={busyKeyId}
      onApproveDevice={(participant) => { void changeTrust(participant, 'approve') }}
      onRevokeDevice={(participant) => { void changeTrust(participant, 'revoke') }}
      trustError={trustError}
    />
  )
}
