import type { ApiError, TrackObject } from '../../shared/sfu.ts'
import { MediaTransportError, type TrackRef } from './MediaTransport.ts'

// A2 spike only: without RoomDO signalling (A3) the two browsers exchange session ids by hand,
// and the subscriber asks the SFU which tracks that session publishes. The room page gets the
// track list from RoomDO instead (e2-t04); delete this with the spike page.
export async function listPublishedTracks(
  sessionId: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  apiBase = '/api/sfu',
): Promise<TrackRef[]> {
  const res = await fetchImpl(`${apiBase}/sessions/${encodeURIComponent(sessionId)}`)
  const json = (await res.json().catch(() => ({}))) as ApiError & {
    error?: string
    tracks?: (TrackObject & { status?: string })[]
  }
  if (res.status === 503) throw new MediaTransportError('sfu_not_configured')
  if (!res.ok || json.errorCode)
    throw new MediaTransportError('not_found', json.errorCode ?? json.error)
  return (json.tracks ?? [])
    .filter((t) => t.location === 'local' && t.status !== 'inactive' && t.trackName)
    .map((t) => ({ sessionId, trackName: t.trackName as string }))
}
