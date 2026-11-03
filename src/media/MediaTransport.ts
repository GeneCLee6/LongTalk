// The media layer's only door (CLAUDE.md rule 2): components and hooks talk to a MediaTransport,
// never to RTCPeerConnection or the SFU API. CloudflareRealtimeTransport is the first
// implementation, FakeTransport runs the tests, LiveKitTransport is the fallback (e2-t17).
// Decision record: docs/adr-001-media-layer.md. No React in src/media/.

import type { TrackKind } from '../../shared/protocol.ts'
import type { ShareMode } from './shareMode.ts'

/** What a published track is, as RoomDO and the UI care about it (defined with the protocol) */
export type { TrackKind }

/**
 * Simulcast layer a receiver asks for; the transport maps it to the SFU's rid (high `f`, medium
 * `h`, low `q`). A screen has two layers (high, medium): asking for low gets medium.
 */
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
  /**
   * Send three layers (cam) or two (screen) for receivers to pick from (e2-t11, encoding.ts
   * SIMULCAST). Ignored for audio; a browser that refuses simulcast encodings sends one layer.
   */
  simulcast?: boolean
}

export interface SubscribeOptions {
  /**
   * The simulcast layer to start with (video only, e2-t12); the SFU falls back to the next one
   * when the publisher does not send it. Without it the SFU picks.
   */
  layer?: Layer
}

export interface ConnectOptions {
  /** STUN and short-lived TURN servers from the Worker (e2-t07) */
  iceServers?: RTCIceServer[]
  /** `relay` forces every path through TURN (a debugging aid, `?ice=relay`) */
  iceTransportPolicy?: RTCIceTransportPolicy
}

/**
 * A snapshot of the connection's health (e2-t13): cumulative counters as getStats() reads them,
 * per sent and received track. Rates and loss over an interval come from two snapshots
 * (media/stats.ts sampleStats). Plain data: no RTCStats objects, no SDP, nothing secret.
 */
export interface TransportStats {
  /** When it was read, ms (performance-style clock of the report, or Date.now()) */
  timestamp: number
  /** Round-trip time to the SFU on the selected candidate pair */
  rttMs: number | null
  /** True when the selected candidate pair goes through TURN (AC-2.4) */
  usingRelay: boolean
  /** The selected local candidate's type: host, srflx, prflx or relay; null before one is chosen */
  candidateType: string | null
  /** How the relay is reached (udp, tcp, tls) when usingRelay; otherwise the pair's protocol */
  protocol: string | null
  bytesSent: number
  bytesReceived: number
  /** The browser's estimate of the uplink, bits per second (Chrome); null when not reported */
  availableOutgoingBitrate: number | null
  /** One entry per published track */
  outbound: OutboundTrackStats[]
  /** One entry per subscription */
  inbound: InboundTrackStats[]
}

/** One simulcast layer (or the only encoding) of a published video, or a published audio */
export interface OutboundLayerStats {
  /** The layer's rid (`f`／`h`／`q`); null for a single encoding */
  rid: string | null
  /** False once the sender stopped this layer (setTopLayer: HD off, or e2-t15) */
  active: boolean
  bytesSent: number
  packetsSent: number
  framesEncoded: number
  width: number | null
  height: number | null
  fps: number | null
  /** Why the encoder sends less than it would: none, bandwidth, cpu, other */
  qualityLimitationReason: string | null
}

export interface OutboundTrackStats {
  trackName: string
  kind: TrackKind
  codec: string | null
  /** Summed over the layers */
  bytesSent: number
  packetsSent: number
  /** What the SFU reports back (remote-inbound-rtp), summed over the layers */
  packetsLost: number
  /** The SFU's latest loss fraction for the track (0–1), the worst layer; null when unknown */
  fractionLost: number | null
  layers: OutboundLayerStats[]
}

export interface InboundTrackStats extends TrackRef {
  media: 'audio' | 'video'
  codec: string | null
  bytesReceived: number
  packetsReceived: number
  packetsLost: number
  /** Seconds, as the browser reports it */
  jitter: number | null
  width: number | null
  height: number | null
  fps: number | null
  framesDecoded: number
  framesDropped: number
  freezeCount: number
  /** Seconds */
  totalFreezesDuration: number
  /** Seconds summed over every emitted frame or sample (divide by jitterBufferEmittedCount) */
  jitterBufferDelay: number
  jitterBufferEmittedCount: number
  /** Audio: samples the decoder made up for lost packets, and all samples */
  concealedSamples: number
  totalSamplesReceived: number
}

/**
 * Why the browser sends a video below what it was asked for (RTCOutboundRtpStreamStats
 * `qualityLimitationReason`): `bandwidth` is the uplink
 */
export type QualityLimitation = 'none' | 'bandwidth' | 'cpu' | 'other'

/**
 * How a published video's uplink is doing (e6-t04: may it send HD), read from the connection's
 * statistics (media/stats.ts uplinkOf; one getStats() path for everything, H2)
 */
export interface UplinkStats {
  /** The browser's estimate of what it can send now, bits per second; null when not reported */
  availableOutgoingBitrate: number | null
  /** The worst limitation across the track's layers that are sending; null when not reported */
  limitation: QualityLimitation | null
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

  /**
   * Opens the session. Resolves when publish/subscribe can be called. A transport that went
   * `failed` is not reused: the caller builds a new one (RoomMedia, e2-t08).
   */
  connect(options?: ConnectOptions): Promise<void>

  /** Sends a local track to the SFU; report the result to RoomDO so others can subscribe */
  publish(track: MediaStreamTrack, options: PublishOptions): Promise<PublishedTrack>
  /** Stops sending a track published by this transport */
  unpublish(trackName: string): Promise<void>
  /**
   * Sends another local track (a new device) or nothing (null: muted, camera off) on a published
   * track, without renegotiating: subscribers keep their subscription (B2). Rejects with
   * `not_found` for a track this transport did not publish.
   */
  replaceTrack(trackName: string, track: MediaStreamTrack | null): Promise<void>

  /** Starts receiving someone else's track; rejects with `not_found` if it is not published */
  subscribe(ref: TrackRef, options?: SubscribeOptions): Promise<RemoteTrack>
  /** Stops receiving; a no-op for a track that is not subscribed */
  unsubscribe(ref: TrackRef): Promise<void>
  /**
   * Asks the SFU for another simulcast layer of a subscribed video track (e2-t12); asking for
   * the layer already asked for does nothing. Rejects with `not_found` when not subscribed.
   */
  setPreferredLayer(ref: TrackRef, layer: Layer): Promise<void>

  /**
   * The highest simulcast layer a published video sends (e6-t04, HD): `high` sends every layer,
   * `medium` leaves the top one out (a camera then sends at most 360p; a receiver asking for
   * `high` gets the next one down from the SFU). A single-layer sender is scaled down instead.
   * Kept across replaceTrack; a new publish starts with every layer. Rejects with `not_found`
   * for a track this transport did not publish.
   */
  setTopLayer(trackName: string, top: Layer): Promise<void>

  /**
   * How a published screen is encoded (e3-t06): 文字 (`text`: resolution first) or 動態
   * (`motion`: frame rate first), media/shareMode.ts. Applied live (the track's contentHint and
   * the sender's parameters, no renegotiation); kept across setTopLayer, and across replaceTrack
   * except the new track's contentHint (call it again). Does nothing for a track that is not a
   * screen; rejects with `not_found` for a track this transport did not publish.
   */
  setShareMode(trackName: string, mode: ShareMode): Promise<void>

  /**
   * Reads the connection's statistics (e2-t13): one call to the PeerConnection's getStats(),
   * summarised per track. RoomMedia polls it (STATS_POLL_MS); nothing else should.
   */
  getStats(): Promise<TransportStats>

  /**
   * Fresh ICE servers for the open connection (TURN credentials expire, e2-t07); used by the
   * next ICE gathering. A no-op before connect().
   */
  setIceServers(iceServers: RTCIceServer[]): void

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
