import { RECONNECT_GRACE_MS, type ClientMessage, type MemberTrack } from '../../shared/protocol.ts'
import { STATS_INTERVAL_MS, type UsageState } from '../../shared/usage.ts'
import {
  MediaTransportError,
  trackKey,
  type ConnectOptions,
  type ConnectionState,
  type MediaTransport,
  type MediaTransportErrorCode,
  type PublishedTrack,
  type TrackKind,
} from '../media/MediaTransport.ts'
import { Backoff } from './backoff.ts'

// One member's media in the room (e2-t03, e2-t04, e2-t05, e2-t08), on top of a MediaTransport
// and nothing else (CLAUDE.md rule 2): publishes the local microphone and camera, tells the room
// what it publishes (`tracks`), and keeps what it receives in line with the room's track list.
//
// What it sends is also a reconciliation: `setLocal` hands over the track to send per kind (null:
// turned off, muted, or no device). A kind never published is published once a track arrives;
// after that, turning it off, on, or switching devices only replaces what the published track
// sends (MediaTransport.replaceTrack, no renegotiation) and reports `muted` to the room. Once the
// month is audio-only a camera that is not sending stays off: replacing would get round the
// proxy's refusal of new video.
//
// The screen (D1, e3-t01) is the third kind: `setScreen` hands over the captured screen (null:
// not sharing). Unlike the camera it is published when sharing starts and unpublished when it
// ends (RoomDO allows one sharer and only lists the sharer's screen); its video goes out as VP8
// like the camera's (CloudflareRealtimeTransport). Once the month is audio-only it is not
// published (`screenRefused`).
//
// The screen's sound (D2, e3-t04, kind `screenAudio`) goes with it: setScreen's second track
// (null: none, or the sharer turned it off). It is published once the screen is, after it (an
// audio track of its own, through the same transport), the first time there is sound to send;
// turning it off and on after that replaces what it sends, like the microphone, and the room is
// told it is muted. It is unpublished with the screen, and before a screen picked again. In an
// audio-only month the screen is refused, and so its sound never goes out either.
//
// Subscriptions are a desired / actual reconciliation, the only way anything gets subscribed:
// `setDesired` hands over every other member's tracks from RoomDO; `reconcile` subscribes to what
// is desired and not yet received, and unsubscribes what is received and no longer desired.
// Calling it again with the same list does nothing, so it can run on every room patch. A
// subscription that fails ("not there yet": the publisher's first packets have not reached the
// SFU; or a refused call) is retried with backoff, 2, 4, 8 s up to every RETRY_MAX_MS, for as long
// as the track is listed: the publisher may only become ready later. A change to the listed track
// (its publisher reported it again) retries at once. A publish that fails is retried the same way.
//
// Rebuilding (e2-t08): when the transport fails, or stays `reconnecting` (ICE disconnected) for
// DISCONNECT_GRACE_MS, the session is thrown away and a new one built from the factory: new ICE
// servers (TURN credentials, e2-t07), a new SFU session (the room drops the old one's tracks when
// the proxy binds the new one), the local tracks published again and reported, and everything
// desired subscribed again. Failed attempts wait with backoff and jitter (backoff.ts); coming
// online or to the foreground (`nudge`) tries at once; after RECONNECT_GRACE_MS of failures the
// status is `failed` until `retry()`.
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

/**
 * - `reconnecting`: the media connection dropped; waiting for it to come back, or building a new
 *   session
 * - `failed`: could not connect (not retried: not configured, not a member), or gave up
 *   rebuilding; `retry()` tries again
 */
export type RoomMediaStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed'

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
  /** The screen was not published, for the same reason (D1) */
  screenRefused: boolean
  /** The camera sends low quality (the month passed the low-quality threshold) */
  lowQuality: boolean
  /** The media goes through a TURN relay (the selected candidate pair, e2-t07) */
  usingRelay: boolean
  /** How many times the session was thrown away and built anew (telemetry, e11-t03) */
  rebuilds: number
}

/** ICE settings for the next session, and when to ask for fresh ones (TURN credentials expire) */
export interface IceConfig {
  connect: ConnectOptions
  /** Ask again after this long, ms; null: never */
  refreshAfterMs: number | null
}

export interface RoomMediaOptions {
  /** The first transport; rebuilding needs `createTransport` */
  transport?: MediaTransport
  /** A new transport per session (the first one too, without `transport`) */
  createTransport?: () => MediaTransport
  /** ICE servers before each session (TURN, e2-t07); without it the transport's default STUN */
  iceConfig?: () => Promise<IceConfig | null>
  /** Sends a message to the room over its WebSocket */
  send: (message: ClientMessage) => void
  statsIntervalMs?: number
  /** Wait before the first retry of a subscription or publish that failed; doubles after that */
  retryDelayMs?: number
  /** Longest wait between retries */
  retryMaxMs?: number
  /** How long a dropped media connection may take to come back by itself before a rebuild */
  disconnectGraceMs?: number
  /** A session this long without failing resets the rebuild backoff */
  stableAfterMs?: number
  backoff?: Backoff
}

const RETRY_DELAY_MS = 2_000
/** A track that is still not there is tried again this often (a request per track) */
export const RETRY_MAX_MS = 15_000
/** ICE `disconnected` often heals by itself within a few seconds (a Wi-Fi hiccup) */
export const DISCONNECT_GRACE_MS = 4_000
export const STABLE_AFTER_MS = 20_000

/** Errors that a new session would not fix */
const FINAL_ERRORS: ReadonlySet<MediaTransportErrorCode> = new Set([
  'unauthorized',
  'sfu_not_configured',
])

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
  screenRefused: false,
  lowQuality: false,
  usingRelay: false,
  rebuilds: 0,
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

type Timer = ReturnType<typeof setTimeout>

export class RoomMedia {
  private transport: MediaTransport
  private readonly createTransport: (() => MediaTransport) | null
  private readonly iceConfig: (() => Promise<IceConfig | null>) | null
  private readonly send: (message: ClientMessage) => void
  private readonly statsIntervalMs: number
  private readonly retryDelayMs: number
  private readonly retryMaxMs: number
  private readonly disconnectGraceMs: number
  private readonly stableAfterMs: number
  private readonly backoff: Backoff
  private state: RoomMediaState = { ...idleRoomMedia }
  private readonly listeners = new Set<() => void>()
  private closed = false
  private started = false
  /** The current transport's session is open (publish and subscribe work) */
  private ready = false
  private usage: UsageState = 'normal'
  /** What to send, from setLocal */
  private wanted: LocalTracks = { mic: null, cam: null }
  /** What each published track sends now */
  private sending: LocalTracks = { mic: null, cam: null }
  /** The screen to share, from setScreen (D1), and the one published now */
  private wantedScreen: MediaStreamTrack | null = null
  private sendingScreen: MediaStreamTrack | null = null
  /** The screen's sound to send, from setScreen (D2), and what its published track sends now */
  private wantedScreenAudio: MediaStreamTrack | null = null
  private sendingScreenAudio: MediaStreamTrack | null = null
  /** Local changes run one at a time, in order */
  private localQueue: Promise<void> = Promise.resolve()
  private statsTimer: ReturnType<typeof setInterval> | null = null
  /** Subscriptions waiting to be retried, by trackKey */
  private readonly retryTimers = new Map<string, Timer>()
  /** A publish waiting to be retried */
  private publishTimer: Timer | null = null
  /** Publishes that failed in a row */
  private publishFailures = 0
  private offTransport: (() => void)[] = []
  /** A rebuild waiting for its backoff delay */
  private rebuildTimer: Timer | null = null
  /** The media connection dropped; a rebuild follows unless it comes back */
  private disconnectTimer: Timer | null = null
  private stableTimer: Timer | null = null
  private iceTimer: Timer | null = null
  /** Why the last attempt failed, for when the backoff gives up */
  private lastError: MediaTransportErrorCode | null = null

  /** Every other member's tracks, by trackKey (from RoomDO) */
  private desired = new Map<string, MemberTrack>()
  /** Subscriptions asked for and not settled yet */
  private readonly pending = new Set<string>()
  /** Failed subscriptions in a row, by trackKey: how long the next retry waits */
  private readonly attempts = new Map<string, number>()
  /** Tracks that ended on their own (their publisher stopped them) while still listed */
  private readonly ended = new Set<string>()

  constructor(options: RoomMediaOptions) {
    this.createTransport = options.createTransport ?? null
    const first = options.transport ?? options.createTransport?.()
    if (!first) throw new Error('RoomMedia needs a transport or createTransport')
    this.transport = first
    this.iceConfig = options.iceConfig ?? null
    this.send = options.send
    this.statsIntervalMs = options.statsIntervalMs ?? STATS_INTERVAL_MS
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS
    this.disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS
    this.stableAfterMs = options.stableAfterMs ?? STABLE_AFTER_MS
    this.backoff = options.backoff ?? new Backoff({ giveUpAfterMs: RECONNECT_GRACE_MS })
    this.attach(first)
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
    this.statsTimer = setInterval(() => void this.reportStats(), this.statsIntervalMs)
    await this.openSession(this.transport, 'connecting')
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
    if (!this.ready) return this.localQueue
    return this.syncLocal()
  }

  /**
   * The screen to share (D1), or null to stop sharing, and its sound to send (D2; null: none, or
   * turned off): published, or unpublished, once the session is open. Resolves once it is
   * applied.
   */
  setScreen(track: MediaStreamTrack | null, audio: MediaStreamTrack | null = null): Promise<void> {
    if (track === null) audio = null
    if (track === this.wantedScreen && audio === this.wantedScreenAudio) return this.localQueue
    this.wantedScreen = track
    this.wantedScreenAudio = audio
    if (track === null && this.state.screenRefused) this.update({ screenRefused: false })
    if (!this.ready) return this.localQueue
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
    for (const key of new Set([
      ...this.attempts.keys(),
      ...this.retryTimers.keys(),
      ...this.ended,
    ])) {
      const before = this.desired.get(key)
      const now = next.get(key)
      if (!now) {
        this.forgetRetry(key)
        this.ended.delete(key)
      } else if (before && before.muted !== now.muted) {
        // Its publisher reported it again: whatever kept it from us may be over, try at once
        this.forgetRetry(key)
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
      if (this.retryTimers.has(key)) continue
      void this.subscribeTo(key, track)
    }
    for (const key of Object.keys(this.state.received)) {
      if (this.desired.has(key)) continue
      const { sessionId, trackName } = this.state.received[key]
      this.removeReceived(key)
      void this.transport.unsubscribe({ sessionId, trackName }).catch(() => undefined)
    }
  }

  /**
   * The room welcomed us again (the socket reconnected): tell it what we publish, in case a
   * `tracks` message was lost while the socket was down
   */
  rejoined(): void {
    if (this.ready && this.state.published.length > 0) this.reportTracks()
  }

  /** The browser came online or to the foreground: a rebuild waiting for its delay runs now */
  nudge(): void {
    if (this.closed || !this.started) return
    if (this.rebuildTimer !== null) {
      this.backoff.restart()
      void this.rebuild()
    } else if (this.state.status === 'failed') {
      this.retry()
    }
  }

  /** After `failed`: build a new session from the first delay */
  retry(): void {
    if (this.closed || !this.started || this.state.status !== 'failed' || !this.canRebuild()) return
    this.backoff.reset()
    void this.rebuild()
  }

  /** Stops everything; the published tracks end on the SFU with the session */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.ready = false
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    this.clearSessionTimers()
    this.clearRetries()
    this.detach()
    this.update({ status: 'closed', received: {} })
    await this.transport.close()
  }

  private canRebuild(): boolean {
    return this.createTransport !== null && !FINAL_ERRORS.has(this.state.error ?? 'sfu_error')
  }

  private attach(transport: MediaTransport): void {
    this.detach()
    this.offTransport = [
      transport.on('trackEnded', (ref) => {
        const key = trackKey(ref)
        if (!(key in this.state.received)) return
        if (this.desired.has(key)) this.ended.add(key)
        this.removeReceived(key)
      }),
      transport.on('state', (status) => this.onTransportState(transport, status)),
    ]
  }

  private detach(): void {
    for (const off of this.offTransport) off()
    this.offTransport = []
  }

  /** Connects `transport` (with fresh ICE servers), then publishes and subscribes */
  private async openSession(transport: MediaTransport, status: RoomMediaStatus): Promise<void> {
    this.update({ status })
    let ice: IceConfig | null = null
    try {
      ice = this.iceConfig ? await this.iceConfig().catch(() => null) : null
      if (this.closed || transport !== this.transport) return
      await transport.connect(ice?.connect)
    } catch (error) {
      if (this.closed || transport !== this.transport) return
      const code = errorCode(error)
      if (FINAL_ERRORS.has(code) || !this.createTransport) {
        this.update({ status: 'failed', error: code })
        return
      }
      this.lastError = code
      this.rebuildLater()
      return
    }
    if (this.closed || transport !== this.transport) return
    this.ready = true
    this.update({ status: 'connected', error: null })
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      this.backoff.reset()
    }, this.stableAfterMs)
    this.scheduleIceRefresh(transport, ice)
    this.reconcile()
    await this.syncLocal()
  }

  private onTransportState(transport: MediaTransport, status: ConnectionState): void {
    if (this.closed || transport !== this.transport || !this.ready) return
    if (status === 'connected') {
      if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer)
      this.disconnectTimer = null
      if (this.state.status === 'reconnecting') {
        this.update({ status: 'connected' })
        this.reconcile()
      }
    } else if (status === 'reconnecting') {
      if (this.disconnectTimer !== null) return
      this.update({ status: 'reconnecting' })
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null
        this.lastError = 'negotiation_failed'
        this.rebuildLater()
      }, this.disconnectGraceMs)
    } else if (status === 'failed') {
      this.lastError = 'negotiation_failed'
      this.rebuildLater()
    }
  }

  /** The current session is lost: build a new one after the backoff delay, or give up */
  private rebuildLater(): void {
    this.ready = false
    if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer)
    this.disconnectTimer = null
    if (!this.createTransport) {
      this.update({ status: 'failed', error: this.lastError ?? 'sfu_error' })
      return
    }
    if (this.rebuildTimer !== null) return
    const delay = this.backoff.next()
    if (delay === null) {
      this.clearSessionTimers()
      this.update({ status: 'failed', error: this.lastError ?? 'sfu_error' })
      return
    }
    if (this.state.status !== 'reconnecting') this.update({ status: 'reconnecting' })
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      void this.rebuild()
    }, delay)
  }

  /** Throws the session away and builds a new one */
  private async rebuild(): Promise<void> {
    if (this.closed || !this.createTransport) return
    this.clearSessionTimers()
    this.ready = false
    const old = this.transport
    this.detach()
    void old.close().catch(() => undefined)
    this.clearRetries()
    this.pending.clear()
    this.ended.clear()
    this.sending = { mic: null, cam: null }
    this.sendingScreen = null
    this.sendingScreenAudio = null
    this.update({
      status: 'reconnecting',
      error: null,
      published: [],
      received: {},
      usingRelay: false,
      rebuilds: this.state.rebuilds + 1,
    })
    const transport = this.createTransport()
    this.transport = transport
    this.attach(transport)
    await this.openSession(transport, 'reconnecting')
  }

  /** TURN credentials expire: hand the transport fresh ones before they do */
  private scheduleIceRefresh(transport: MediaTransport, ice: IceConfig | null): void {
    const load = this.iceConfig
    const after = ice?.refreshAfterMs
    if (!load || after === null || after === undefined) return
    this.iceTimer = setTimeout(async () => {
      this.iceTimer = null
      const next = await load().catch(() => null)
      if (this.closed || transport !== this.transport || !this.ready) return
      if (next?.connect.iceServers) transport.setIceServers(next.connect.iceServers)
      this.scheduleIceRefresh(transport, next ?? ice)
    }, after)
  }

  private clearSessionTimers(): void {
    for (const timer of [
      this.rebuildTimer,
      this.disconnectTimer,
      this.stableTimer,
      this.iceTimer,
    ]) {
      if (timer !== null) clearTimeout(timer)
    }
    this.rebuildTimer = this.disconnectTimer = this.stableTimer = this.iceTimer = null
  }

  private syncLocal(): Promise<void> {
    this.localQueue = this.localQueue.then(() => this.applyLocal()).catch(() => undefined)
    return this.localQueue
  }

  /** Brings what each kind sends in line with `wanted`, the microphone first */
  private async applyLocal(): Promise<void> {
    const transport = this.transport
    for (const kind of ['mic', 'cam'] as const) {
      if (this.closed || !this.ready || transport !== this.transport) return
      const want = this.wanted[kind]
      const own = this.state.published.find((track) => track.kind === kind)
      if (!own) {
        if (want) await this.publishLocal(transport, want, kind)
        continue
      }
      if (this.sending[kind] === want) continue
      if (kind === 'cam' && want && this.sending.cam === null && this.usage === 'audioOnly') {
        this.update({ videoRefused: true })
        continue
      }
      if (kind === 'cam' && want && this.usage !== 'normal') await lowerQuality(want)
      try {
        await transport.replaceTrack(own.trackName, want)
      } catch (error) {
        if (!this.closed && transport === this.transport) this.update({ error: errorCode(error) })
        continue
      }
      if (this.closed || transport !== this.transport) return
      this.sending[kind] = want
      this.update({
        published: this.state.published.map((track) =>
          track.kind === kind ? { ...track, muted: want === null } : track,
        ),
      })
      this.reportTracks()
    }
    if (this.closed || !this.ready || transport !== this.transport) return
    await this.applyScreen(transport)
  }

  /** Publishes the screen to share, or unpublishes the one that is no longer shared (D1) */
  private async applyScreen(transport: MediaTransport): Promise<void> {
    const want = this.wantedScreen
    if (want === this.sendingScreen) return this.applyScreenAudio(transport)
    // The screen's sound belongs to the screen that goes: it goes first
    await this.unpublishOwn(transport, 'screenAudio')
    if (this.closed || transport !== this.transport) return
    this.sendingScreenAudio = null
    const own = this.state.published.find((track) => track.kind === 'screen')
    if (own) {
      // Another screen (picked again) or none: the old one goes; a new one is published below
      try {
        await transport.unpublish(own.trackName)
      } catch {
        // The session is closing or broken: a rebuild starts without it anyway
      }
      if (this.closed || transport !== this.transport) return
      this.sendingScreen = null
      this.update({ published: this.state.published.filter((track) => track !== own) })
      this.reportTracks()
    }
    if (!want || this.closed || transport !== this.transport) return
    if (this.usage === 'audioOnly') {
      this.update({ screenRefused: true })
      return
    }
    try {
      const published = await transport.publish(want, { kind: 'screen' })
      if (this.closed || transport !== this.transport) return
      if (this.wantedScreen !== want) {
        // Stopped while it was being published
        await transport.unpublish(published.trackName).catch(() => undefined)
        return
      }
      this.sendingScreen = want
      this.update({
        published: [...this.state.published, { ...published, muted: false }],
        error: null,
      })
      this.reportTracks()
    } catch (error) {
      if (this.closed || transport !== this.transport) return
      const code = errorCode(error)
      if (code === 'quota_exceeded') {
        this.update({ screenRefused: true })
        return
      }
      this.update({ error: code })
      if (!FINAL_ERRORS.has(code) && transport.state !== 'failed') this.retryPublish()
      return
    }
    await this.applyScreenAudio(transport)
  }

  /**
   * The screen's sound (D2), once the screen is published: published the first time there is
   * sound to send, then turned off and on by replacing what it sends (`muted` to the room)
   */
  private async applyScreenAudio(transport: MediaTransport): Promise<void> {
    if (this.closed || transport !== this.transport) return
    const own = this.state.published.find((track) => track.kind === 'screenAudio')
    if (!this.sendingScreen) {
      // No screen out (stopped, refused, or not published yet): no sound either
      if (own) await this.unpublishOwn(transport, 'screenAudio')
      if (transport === this.transport) this.sendingScreenAudio = null
      return
    }
    const want = this.wantedScreenAudio
    if (!own) {
      if (!want) return
      try {
        const published = await transport.publish(want, { kind: 'screenAudio' })
        if (this.closed || transport !== this.transport) return
        if (this.wantedScreen !== this.sendingScreen) {
          // The screen stopped while its sound was being published
          await transport.unpublish(published.trackName).catch(() => undefined)
          return
        }
        this.sendingScreenAudio = want
        this.update({
          published: [...this.state.published, { ...published, muted: false }],
          error: null,
        })
        this.reportTracks()
      } catch (error) {
        if (this.closed || transport !== this.transport) return
        const code = errorCode(error)
        this.update({ error: code })
        if (!FINAL_ERRORS.has(code) && transport.state !== 'failed') this.retryPublish()
      }
      return
    }
    if (this.sendingScreenAudio === want) return
    try {
      await transport.replaceTrack(own.trackName, want)
    } catch (error) {
      if (!this.closed && transport === this.transport) this.update({ error: errorCode(error) })
      return
    }
    if (this.closed || transport !== this.transport) return
    this.sendingScreenAudio = want
    this.update({
      published: this.state.published.map((track) =>
        track.kind === 'screenAudio' ? { ...track, muted: want === null } : track,
      ),
    })
    this.reportTracks()
  }

  /** Unpublishes this member's track of `kind`, if there is one, and tells the room */
  private async unpublishOwn(transport: MediaTransport, kind: TrackKind): Promise<void> {
    const own = this.state.published.find((track) => track.kind === kind)
    if (!own) return
    try {
      await transport.unpublish(own.trackName)
    } catch {
      // The session is closing or broken: a rebuild starts without it anyway
    }
    if (this.closed || transport !== this.transport) return
    this.update({ published: this.state.published.filter((track) => track !== own) })
    this.reportTracks()
  }

  private async publishLocal(
    transport: MediaTransport,
    track: MediaStreamTrack,
    kind: 'mic' | 'cam',
  ): Promise<void> {
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
      const published = await transport.publish(track, { kind })
      if (this.closed || transport !== this.transport) return
      this.sending[kind] = track
      this.publishFailures = 0
      this.update({
        published: [...this.state.published, { ...published, muted: false }],
        error: null,
      })
      this.reportTracks()
    } catch (error) {
      if (this.closed || transport !== this.transport) return
      const code = errorCode(error)
      if (code === 'quota_exceeded') {
        this.update({ videoRefused: true })
        return
      }
      this.update({ error: code })
      // A session that failed is rebuilt (and publishes again); otherwise try again later
      if (!FINAL_ERRORS.has(code) && transport.state !== 'failed') this.retryPublish()
    }
  }

  private async subscribeTo(key: string, track: MemberTrack): Promise<void> {
    const transport = this.transport
    this.pending.add(key)
    try {
      const remote = await transport.subscribe(track)
      if (transport !== this.transport) return
      this.pending.delete(key)
      if (this.closed) return
      if (!this.desired.has(key)) {
        // Left the list while we were subscribing
        await transport.unsubscribe(track).catch(() => undefined)
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
      if (transport !== this.transport) return
      this.pending.delete(key)
      if (this.closed || !this.desired.has(key)) return
      const attempts = (this.attempts.get(key) ?? 0) + 1
      this.attempts.set(key, attempts)
      const timer = setTimeout(() => {
        this.retryTimers.delete(key)
        this.reconcile()
      }, this.retryWait(attempts))
      this.retryTimers.set(key, timer)
    }
  }

  /** The wait before retry number `attempts`: doubling from retryDelayMs up to retryMaxMs */
  private retryWait(attempts: number): number {
    const delay = Math.min(this.retryDelayMs * 2 ** (attempts - 1), this.retryMaxMs)
    return Math.round(delay * (0.85 + Math.random() * 0.3))
  }

  private retryPublish(): void {
    if (this.publishTimer !== null) return
    this.publishFailures += 1
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      void this.syncLocal()
    }, this.retryWait(this.publishFailures))
  }

  private forgetRetry(key: string): void {
    const timer = this.retryTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.retryTimers.delete(key)
    this.attempts.delete(key)
  }

  private clearRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.attempts.clear()
    if (this.publishTimer !== null) clearTimeout(this.publishTimer)
    this.publishTimer = null
    this.publishFailures = 0
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
    const transport = this.transport
    const sessionId = transport.sessionId
    if (this.closed || !this.ready || !sessionId) return
    try {
      const { bytesReceived, usingRelay } = await transport.getStats()
      if (this.closed || transport !== this.transport) return
      if (usingRelay !== this.state.usingRelay) this.update({ usingRelay })
      this.send({
        t: 'stats',
        sessionId,
        bytesReceived: Math.round(bytesReceived),
        relay: usingRelay,
      })
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
