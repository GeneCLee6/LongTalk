import type { ClientMessage, MemberTrack } from '../../shared/protocol.ts'
import { STATS_INTERVAL_MS, type UsageState } from '../../shared/usage.ts'
import {
  MediaTransportError,
  trackKey,
  type MediaTransport,
  type MediaTransportErrorCode,
  type PublishedTrack,
  type TrackKind,
} from '../media/MediaTransport.ts'

// One member's media in the room (e2-t03, e2-t04, e2-t05), on top of a MediaTransport and
// nothing else (CLAUDE.md rule 2): publishes the local microphone and camera, tells the room what
// it publishes (`tracks`), and keeps what it receives in line with the room's track list.
//
// What it sends is also a reconciliation: `setLocal` hands over the track to send per kind (null:
// turned off, muted, or no device). A kind never published is published once a track arrives;
// after that, turning it off, on, or switching devices only replaces what the published track
// sends (MediaTransport.replaceTrack, no renegotiation) and reports `muted` to the room. Once the
// month is audio-only a camera that is not sending stays off: replacing would get round the
// proxy's refusal of new video.
//
// Subscriptions are a desired / actual reconciliation, the only way anything gets subscribed:
// `setDesired` hands over every other member's tracks from RoomDO; `reconcile` subscribes to what
// is desired and not yet received, and unsubscribes what is received and no longer desired.
// Calling it again with the same list does nothing, so it can run on every room patch. A
// subscription that fails is retried a few times, then left alone until the track leaves the
// list and comes back.
//
// No React here: useRoomMedia (useRoomMedia.ts) wraps it, the tests drive it with FakeTransport.

/** What to send per kind; null when it is off (muted, camera off, or no device) */
export interface LocalTracks {
  mic: MediaStreamTrack | null
  cam: MediaStreamTrack | null
}

/** A track this member publishes, and whether it is muted (sending nothing) now */
export type OwnTrack = PublishedTrack & { muted: boolean }

export interface ReceivedTrack {
  sessionId: string
  trackName: string
  kind: TrackKind
  track: MediaStreamTrack
}

export type RoomMediaStatus = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'

export interface RoomMediaState {
  status: RoomMediaStatus
  /** Why connecting or publishing failed (the interface explains it with strings.ts) */
  error: MediaTransportErrorCode | null
  /** What this member publishes */
  published: OwnTrack[]
  /** What this member receives, by trackKey */
  received: Readonly<Record<string, ReceivedTrack>>
  /** The camera was not published: the month's free allowance is nearly spent */
  videoRefused: boolean
  /** The camera sends low quality (the month passed the low-quality threshold) */
  lowQuality: boolean
}

export interface RoomMediaOptions {
  transport: MediaTransport
  /** Sends a message to the room over its WebSocket */
  send: (message: ClientMessage) => void
  statsIntervalMs?: number
  /** Wait before retrying a subscription that failed */
  retryDelayMs?: number
}

/** Tries per track before giving up on it until it leaves the list */
const MAX_SUBSCRIBE_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000

/** What a camera sends once the month is past the low-quality threshold */
export const LOW_QUALITY_VIDEO: MediaTrackConstraints = {
  width: { ideal: 320 },
  height: { ideal: 180 },
  frameRate: { max: 15 },
}

export const idleRoomMedia: RoomMediaState = {
  status: 'idle',
  error: null,
  published: [],
  received: {},
  videoRefused: false,
  lowQuality: false,
}

const errorCode = (error: unknown): MediaTransportErrorCode =>
  error instanceof MediaTransportError ? error.code : 'sfu_error'

async function lowerQuality(cam: MediaStreamTrack): Promise<void> {
  try {
    await cam.applyConstraints(LOW_QUALITY_VIDEO)
  } catch {
    // The camera cannot go that low; it keeps sending what it can
  }
}

export class RoomMedia {
  private readonly transport: MediaTransport
  private readonly send: (message: ClientMessage) => void
  private readonly statsIntervalMs: number
  private readonly retryDelayMs: number
  private state: RoomMediaState = { ...idleRoomMedia }
  private readonly listeners = new Set<() => void>()
  private closed = false
  private started = false
  private usage: UsageState = 'normal'
  /** What to send, from setLocal */
  private wanted: LocalTracks = { mic: null, cam: null }
  /** What each published track sends now */
  private readonly sending: LocalTracks = { mic: null, cam: null }
  /** Local changes run one at a time, in order */
  private localQueue: Promise<void> = Promise.resolve()
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly offTransport: (() => void)[] = []

  /** Every other member's tracks, by trackKey (from RoomDO) */
  private desired = new Map<string, MemberTrack>()
  /** Subscriptions asked for and not settled yet */
  private readonly pending = new Set<string>()
  /** Failed subscriptions; at MAX_SUBSCRIBE_ATTEMPTS the track is left alone */
  private readonly attempts = new Map<string, number>()
  /** Tracks that ended on their own (their publisher stopped them) while still listed */
  private readonly ended = new Set<string>()

  constructor(options: RoomMediaOptions) {
    this.transport = options.transport
    this.send = options.send
    this.statsIntervalMs = options.statsIntervalMs ?? STATS_INTERVAL_MS
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
    this.offTransport.push(
      this.transport.on('trackEnded', (ref) => {
        const key = trackKey(ref)
        if (!(key in this.state.received)) return
        if (this.desired.has(key)) this.ended.add(key)
        this.removeReceived(key)
      }),
      this.transport.on('state', (status) => {
        if (status === 'failed') this.update({ status: 'failed' })
      }),
    )
  }

  getState = (): RoomMediaState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Opens the SFU session and publishes the local tracks: the microphone first, then the camera
   * (not at all once the month is audio-only; at low resolution once it is past the low-quality
   * threshold). Each success is reported to the room. Runs once.
   */
  async start(local: LocalTracks, usage: UsageState = 'normal'): Promise<void> {
    if (this.started || this.closed) return
    this.started = true
    this.usage = usage
    this.wanted = local
    this.update({ status: 'connecting' })
    try {
      await this.transport.connect()
    } catch (error) {
      if (!this.closed) this.update({ status: 'failed', error: errorCode(error) })
      return
    }
    if (this.closed) return
    this.update({ status: 'connected' })
    this.reconcile()
    this.statsTimer = setInterval(() => void this.reportStats(), this.statsIntervalMs)
    await this.syncLocal()
  }

  /**
   * What to send now (e2-t05, e2-t06): a toggle or a device switch. Resolves once it is applied;
   * before start() it only becomes what start() publishes.
   */
  setLocal(local: LocalTracks): Promise<void> {
    if (local.mic === this.wanted.mic && local.cam === this.wanted.cam) return this.localQueue
    this.wanted = local
    // Turning the camera off clears the refusal, so asking again tells the member again
    if (local.cam === null && this.state.videoRefused) this.update({ videoRefused: false })
    if (this.state.status !== 'connected') return this.localQueue
    return this.syncLocal()
  }

  /** The month's state from the room view: past the low-quality threshold the camera goes low */
  setUsage(usage: UsageState): void {
    this.usage = usage
    if (usage !== 'normal' && !this.state.lowQuality) {
      this.update({ lowQuality: true })
      if (this.sending.cam) void lowerQuality(this.sending.cam)
    }
  }

  /** Every other member's tracks, from the room view; reconciles at once */
  setDesired(tracks: readonly MemberTrack[]): void {
    const next = new Map(tracks.map((track) => [trackKey(track), track]))
    for (const key of [...this.attempts.keys(), ...this.ended]) {
      if (!next.has(key)) {
        this.attempts.delete(key)
        this.ended.delete(key)
      }
    }
    this.desired = next
    this.reconcile()
  }

  /** Subscribes to what is desired and missing, unsubscribes what is received and not desired */
  reconcile(): void {
    if (this.closed || this.state.status !== 'connected') return
    for (const [key, track] of this.desired) {
      if (key in this.state.received || this.pending.has(key) || this.ended.has(key)) continue
      if ((this.attempts.get(key) ?? 0) >= MAX_SUBSCRIBE_ATTEMPTS) continue
      void this.subscribeTo(key, track)
    }
    for (const key of Object.keys(this.state.received)) {
      if (this.desired.has(key)) continue
      const { sessionId, trackName } = this.state.received[key]
      this.removeReceived(key)
      void this.transport.unsubscribe({ sessionId, trackName }).catch(() => undefined)
    }
  }

  /** Stops everything; the published tracks end on the SFU with the session */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    for (const timer of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    for (const off of this.offTransport) off()
    this.update({ status: 'closed', received: {} })
    await this.transport.close()
  }

  private syncLocal(): Promise<void> {
    this.localQueue = this.localQueue.then(() => this.applyLocal()).catch(() => undefined)
    return this.localQueue
  }

  /** Brings what each kind sends in line with `wanted`, the microphone first */
  private async applyLocal(): Promise<void> {
    for (const kind of ['mic', 'cam'] as const) {
      if (this.closed) return
      const want = this.wanted[kind]
      const own = this.state.published.find((track) => track.kind === kind)
      if (!own) {
        if (want) await this.publishLocal(want, kind)
        continue
      }
      if (this.sending[kind] === want) continue
      if (kind === 'cam' && want && this.sending.cam === null && this.usage === 'audioOnly') {
        this.update({ videoRefused: true })
        continue
      }
      if (kind === 'cam' && want && this.usage !== 'normal') await lowerQuality(want)
      try {
        await this.transport.replaceTrack(own.trackName, want)
      } catch (error) {
        if (!this.closed) this.update({ error: errorCode(error) })
        continue
      }
      if (this.closed) return
      this.sending[kind] = want
      this.update({
        published: this.state.published.map((track) =>
          track.kind === kind ? { ...track, muted: want === null } : track,
        ),
      })
      this.reportTracks()
    }
  }

  private async publishLocal(track: MediaStreamTrack, kind: 'mic' | 'cam'): Promise<void> {
    if (kind === 'cam') {
      if (this.usage === 'audioOnly') {
        this.update({ videoRefused: true })
        return
      }
      if (this.usage === 'low') {
        this.update({ lowQuality: true })
        await lowerQuality(track)
      }
    }
    try {
      const published = await this.transport.publish(track, { kind })
      if (this.closed) return
      this.sending[kind] = track
      this.update({ published: [...this.state.published, { ...published, muted: false }] })
      this.reportTracks()
    } catch (error) {
      if (this.closed) return
      const code = errorCode(error)
      if (code === 'quota_exceeded') this.update({ videoRefused: true })
      else this.update({ error: code })
    }
  }

  private async subscribeTo(key: string, track: MemberTrack): Promise<void> {
    this.pending.add(key)
    try {
      const remote = await this.transport.subscribe(track)
      this.pending.delete(key)
      if (this.closed) return
      if (!this.desired.has(key)) {
        // Left the list while we were subscribing
        await this.transport.unsubscribe(track).catch(() => undefined)
        return
      }
      this.attempts.delete(key)
      this.update({
        received: {
          ...this.state.received,
          [key]: {
            sessionId: track.sessionId,
            trackName: track.trackName,
            kind: track.kind,
            track: remote.track,
          },
        },
      })
    } catch {
      this.pending.delete(key)
      if (this.closed) return
      this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1)
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer)
        this.reconcile()
      }, this.retryDelayMs)
      this.retryTimers.add(timer)
    }
  }

  private reportTracks(): void {
    const sessionId = this.transport.sessionId
    if (!sessionId) return
    this.send({
      t: 'tracks',
      sessionId,
      tracks: this.state.published.map(({ trackName, kind, muted }) => ({
        trackName,
        kind,
        muted,
      })),
    })
  }

  private async reportStats(): Promise<void> {
    const sessionId = this.transport.sessionId
    if (this.closed || !sessionId) return
    try {
      const { bytesReceived } = await this.transport.getStats()
      if (!this.closed)
        this.send({ t: 'stats', sessionId, bytesReceived: Math.round(bytesReceived) })
    } catch {
      // Not connected yet; the next tick tries again
    }
  }

  private removeReceived(key: string): void {
    const received = { ...this.state.received }
    delete received[key]
    this.update({ received })
  }

  private update(changes: Partial<RoomMediaState>): void {
    this.state = { ...this.state, ...changes }
    for (const listener of this.listeners) listener()
  }
}
