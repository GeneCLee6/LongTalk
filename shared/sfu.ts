// The subset of the Cloudflare Realtime SFU HTTPS API (OpenAPI realtime-api-2024-05-21) that
// LongTalk uses. The Worker proxies these calls under /api/sfu/* (worker/sfu.ts) so the App
// Secret never reaches the browser; the bodies pass through unchanged, so the browser speaks
// these shapes too (src/media/CloudflareRealtimeTransport.ts). See docs/adr-001-media-layer.md.

export interface SessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

// Simulcast rids, highest quality first: Realtime's 'asciibetical' ordering treats 'f' as the
// most desirable layer, so these names double as the fallback order.
export type SimulcastRid = 'f' | 'h' | 'q'

export interface SimulcastPreference {
  preferredRid?: SimulcastRid
  priorityOrdering?: 'none' | 'asciibetical'
  ridNotAvailable?: 'none' | 'asciibetical'
}

export interface TrackObject {
  location?: 'local' | 'remote'
  // Transceiver mid on the session being changed
  mid?: string
  // Publisher session id (remote tracks only)
  sessionId?: string
  trackName?: string
  kind?: string
  simulcast?: SimulcastPreference
}

export interface ApiError {
  errorCode?: string
  errorDescription?: string
}

export interface NewSessionResponse extends ApiError {
  sessionId: string
  sessionDescription?: SessionDescription
}

export interface TracksRequest {
  sessionDescription?: SessionDescription
  tracks: TrackObject[]
  autoDiscover?: boolean
}

export interface TracksResponse extends ApiError {
  requiresImmediateRenegotiation?: boolean
  sessionDescription?: SessionDescription
  tracks?: (TrackObject & ApiError)[]
}

export interface RenegotiateRequest {
  sessionDescription: SessionDescription
}

export type RenegotiateResponse = ApiError

export interface UpdateTracksRequest {
  tracks: TrackObject[]
}

export interface CloseTracksRequest {
  tracks: { mid: string }[]
  sessionDescription?: SessionDescription
  force: boolean
}

export interface CloseTracksResponse extends ApiError {
  sessionDescription?: SessionDescription
  requiresImmediateRenegotiation?: boolean
  tracks?: ({ mid: string } & ApiError)[]
}

// What /api/sfu/<roomId>/* answers when the Worker has no Realtime app configured, or rejects a
// request before it reaches Cloudflare (worker/sfu.ts):
// - 401 `unauthorized`: no member session token for this room
// - 403 `forbidden`: the SFU session is not this member's
// - 403 `usage_audio_only`: the month's allowance is nearly spent, no new video (shared/usage.ts)
// - 404 `track_not_in_room`: a track to pull is not published in this room
export interface SfuProxyError {
  error:
    | 'sfu_not_configured'
    | 'bad_request'
    | 'not_found'
    | 'upstream_error'
    | 'unauthorized'
    | 'forbidden'
    | 'usage_audio_only'
    | 'track_not_in_room'
}

/** The SFU proxy's base for a room; calls carry `Authorization: Bearer <session token>` */
export const sfuApiBase = (roomId: string): string => `/api/sfu/${roomId}`
