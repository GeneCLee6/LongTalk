import { useEffect, useRef } from 'react'
import { JOIN_FAILURES, type ClientEvent, type JoinFailure } from '../../shared/telemetry.ts'
import { telemetry } from '../telemetry.ts'
import type { RoomMediaStatus } from './RoomMedia.ts'
import type { RoomStatus } from './RoomConnection.ts'

/** A media session counts for the TURN ratio once it has stayed up this long */
export const MEDIA_REPORT_AFTER_MS = 15_000

export interface RoomTelemetryInput {
  status: RoomStatus
  mediaStatus: RoomMediaStatus
  usingRelay: boolean
  rebuilds: number
}

const isJoinFailure = (status: RoomStatus): status is JoinFailure =>
  (JOIN_FAILURES as readonly string[]).includes(status)

/**
 * What the room page reports (e11-t03, shared/telemetry.ts): whether joining worked (and why
 * not), every reconnect of the socket or the media, every media rebuild, and, once per media
 * session that stayed up MEDIA_REPORT_AFTER_MS, whether it goes through TURN. Derived from the
 * states the page already has; nothing about who or which room.
 */
export function useRoomTelemetry(
  { status, mediaStatus, usingRelay, rebuilds }: RoomTelemetryInput,
  track: (event: ClientEvent) => void = (event) => telemetry.track(event),
): void {
  const report = useRef(track)
  useEffect(() => {
    report.current = track
  })
  const joined = useRef(false)
  const joinReported = useRef(false)
  const previousStatus = useRef<RoomStatus | null>(null)
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = status
    if (status === 'open' && !joined.current) {
      joined.current = true
      joinReported.current = true
      report.current({ type: 'join', ok: true })
    } else if (!joined.current && !joinReported.current && isJoinFailure(status)) {
      joinReported.current = true
      report.current({ type: 'join', ok: false, reason: status })
    }
    if (previous === 'open' && status === 'reconnecting') {
      report.current({ type: 'reconnect', layer: 'socket' })
    }
  }, [status])

  const previousMedia = useRef<RoomMediaStatus | null>(null)
  useEffect(() => {
    const previous = previousMedia.current
    previousMedia.current = mediaStatus
    if (previous === 'connected' && mediaStatus === 'reconnecting') {
      report.current({ type: 'reconnect', layer: 'media' })
    }
  }, [mediaStatus])

  const previousRebuilds = useRef(rebuilds)
  useEffect(() => {
    for (let i = previousRebuilds.current; i < rebuilds; i++) report.current({ type: 'rebuild' })
    previousRebuilds.current = rebuilds
  }, [rebuilds])

  // Once per session (a rebuild is a new one): read the relay flag after it settled
  const relay = useRef(usingRelay)
  useEffect(() => {
    relay.current = usingRelay
  }, [usingRelay])
  const reportedSession = useRef<number | null>(null)
  useEffect(() => {
    if (mediaStatus !== 'connected' || reportedSession.current === rebuilds) return
    const timer = setTimeout(() => {
      reportedSession.current = rebuilds
      report.current({ type: 'media', relay: relay.current })
    }, MEDIA_REPORT_AFTER_MS)
    return () => clearTimeout(timer)
  }, [mediaStatus, rebuilds])
}
