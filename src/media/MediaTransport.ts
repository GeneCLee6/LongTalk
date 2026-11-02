// The media layer's only door (CLAUDE.md rule 2): components and hooks talk to a MediaTransport,
// never to RTCPeerConnection or the SFU API. CloudflareRealtimeTransport is the first
// implementation, FakeTransport runs the tests, LiveKitTransport is the fallback (e2-t17).
// Decision record: docs/adr-001-media-layer.md. No React in src/media/.

import type { TrackKind } from '../../shared/protocol.ts'

/** What a published track is, as RoomDO and the UI care about it (defined with the protocol) */
export type { TrackKind }

/** Simulcast layer a receiver asks for; the transport maps it to the SFU's rid */
export type Layer = 'high' | 'medium' | 'low'

/**
 * - `new`: created, connect() not called yet
 * - `connecting`: first connection in progress
 * - `connected`: the session is open and publish/subscribe work; media flows once negotiated
 * - `reconnecting`: was connected, the network dropped; the transport is trying again
 * - `failed`: gave up; the caller rebuilds the transport (e2-t08)
 * - `closed`: close() was called
 */
export type ConnectionState =
  'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'

/**
 * Global address of a published track: the publisher's SFU session plus the track's name in it.
 * The publisher reports it to RoomDO; RoomDO hands it to everyone who should subscribe.
 */
export interface TrackRef {
  sessionId: string
  trackName: string
}

export interface PublishedTrack extends TrackRef {
  kind: TrackKind
}

export interface RemoteTrack extends TrackRef {
  track: MediaStreamTrack
}

export interface PublishOptions {
  kind: TrackKind
  /** Send three layers (cam) or two (screen); M1 (e2-t11). Ignored for audio. */
  simulcast?: boolean
}

export interface ConnectOptions {
  /** STUN and short-lived TURN servers from the Worker (e2-t07) */
  iceServers?: RTCIceServer[]
}

/** A snapshot of the connection's health; e2-t13 grows it into per-track stats */
export interface TransportStats {
  /** Round-trip time to the SFU on the selected candidate pair */
  rttMs: number | null
  /** True when the selected candidate pair goes through TURN (AC-2.4) */
  usingRelay: boolean
  bytesSent: number
  bytesReceived: number
}

export interface MediaTransportEvents {
  state: ConnectionState
  /** A subscribed track started arriving (also returned by subscribe()) */
  track: RemoteTrack
  /** A subscribed track stopped: unsubscribed, or its publisher unpublished or left */
  trackEnded: TrackRef
}

export type MediaTransportEvent = keyof MediaTransportEvents
export type Unsubscribe = () => void

export type MediaTransportErrorCode =
  | 'not_connected'
  | 'closed'
  | 'not_found'
  | 'sfu_not_configured'
  /** The proxy refused the call: no valid member session token, or not this member's session */
  | 'unauthorized'
  /** The month's free allowance is nearly spent: no new video tracks (shared/usage.ts) */
  | 'quota_exceeded'
  | 'sfu_error'
  | 'negotiation_failed'

export class MediaTransportError extends Error {
  readonly code: MediaTransportErrorCode

  constructor(code: MediaTransportErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'MediaTransportError'
    this.code = code
  }
}

export interface MediaTransport {
  /** Our own SFU session id; null until connect() resolves */
  readonly sessionId: string | null
  readonly state: ConnectionState

  /** Opens the session. Resolves when publish/subscribe can be called. */
  connect(options?: ConnectOptions): Promise<void>

  /** Sends a local track to the SFU; report the result to RoomDO so others can subscribe */
  publish(track: MediaStreamTrack, options: PublishOptions): Promise<PublishedTrack>
  /** Stops sending a track published by this transport */
  unpublish(trackName: string): Promise<void>

  /** Starts receiving someone else's track; rejects with `not_found` if it is not published */
  subscribe(ref: TrackRef): Promise<RemoteTrack>
  /** Stops receiving; a no-op for a track that is not subscribed */
  unsubscribe(ref: TrackRef): Promise<void>
  /** Asks the SFU for another simulcast layer of a subscribed track (e2-t12) */
  setPreferredLayer(ref: TrackRef, layer: Layer): Promise<void>

  getStats(): Promise<TransportStats>

  /** Returns a function that removes the handler */
  on<E extends MediaTransportEvent>(
    event: E,
    handler: (payload: MediaTransportEvents[E]) => void,
  ): Unsubscribe

  /** Stops everything; the transport cannot be reused */
  close(): Promise<void>
}

export function trackKey(ref: TrackRef): string {
  return `${ref.sessionId}/${ref.trackName}`
}
