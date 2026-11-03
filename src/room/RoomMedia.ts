import {
  RECONNECT_GRACE_MS,
  SIGNAL_REPORT_MS,
  type ClientMessage,
  type MemberTrack,
  type SignalLevel,
} from '../../shared/protocol.ts'
import { STATS_INTERVAL_MS, type UsageState } from '../../shared/usage.ts'
import {
  DownlinkAdaptation,
  FULL_UPLINK,
  UplinkAdaptation,
  type DownlinkStage,
  type UplinkState,
} from '../media/adaptation.ts'
import { SIMULCAST } from '../media/encoding.ts'
import { chooseLayers, DOWNLINK_BUDGET_BPS, ladder, type LayerInput } from '../media/layers.ts'
import {
  connectionVerdict,
  downlinkVerdict,
  encoderLimit,
  SignalMeter,
  uplinkVerdict,
} from '../media/quality.ts'
import { sampleStats, type StatsSample } from '../media/stats.ts'
import {
  MediaTransportError,
  trackKey,
  type ConnectOptions,
  type ConnectionState,
  type Layer,
  type MediaTransport,
  type MediaTransportErrorCode,
  type PublishedTrack,
  type TrackKind,
  type TransportStats,
  type UplinkStats,
} from '../media/MediaTransport.ts'
import {
  nextUplinkCheck,
  startUplinkCheck,
  UPLINK_SAMPLE_MS,
  uplinkRetryWait,
  type UplinkCheck,
} from '../media/uplink.ts'
import { Backoff } from './backoff.ts'
import type { StatsStore } from './statsStore.ts'
import type { VideoDemandStore } from './videoDemand.ts'

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
// Layers (H1, e2-t11, e2-t12): the camera and the screen are published in simulcast layers, and
// every received camera or screen asks the SFU for the layer its tile needs. Tiles report where
// they draw each track (`demand`, videoDemand.ts); a change (a resize, a page turned, a strip
// scrolled, a tile hidden) or a new subscription recomputes every layer after LAYER_DEBOUNCE_MS
// (media/layers.ts: size, visibility, budget, hysteresis), and only the ones that changed go to
// the SFU. A camera starts at medium and a screen at high until its tile reports. Without a
// demand store nothing is recomputed.
//
// Statistics and adaptation (H2, e2-t13, e2-t15; ADR-001 「頻寬自適應」): one poller, every
// STATS_POLL_MS, reads the transport's getStats() and turns two readings into a sample
// (media/stats.ts). From each sample: the signal level for our own nameplate (media/quality.ts,
// steadied over three samples) and, when it changes, `signal` to the room (at most every
// SIGNAL_REPORT_MS) for everyone else's; every STATS_INTERVAL_MS the bytes received to the room
// (`stats`, the free-tier guard); the latest sample to the StatsStore for the stats panel; and a
// step of the two adaptation machines (media/adaptation.ts). Downlink: a lower video budget for
// the layer choice, then no cameras but the ones `setVideoPriority` keeps (they are unsubscribed:
// Realtime cannot pause; their tiles show initials), then `downlink: 'audioOnly'`, a suggestion
// the page shows. Uplink: the top layers of our camera and screen turned off
// (MediaTransport.setTopLayer, combined with HD's) while the encoder is held back, and on again
// later. Audio is never touched. In 純音訊模式 (below) the adaptation holds where it is.
//
// HD (e6-t04): with `hd` on the camera sends all three layers; off, its 720p layer is turned off
// (MediaTransport.setTopLayer 'medium': at most 360p goes out, the capture stays 720p so turning
// HD back on is instant). While HD is on and the camera sends, its uplink is sampled every
// UPLINK_SAMPLE_MS (from the latest stats sample: one getStats() path); when it is too short (media/uplink.ts) HD is held
// back (`hdLimited`) and tried again later, longer each time.
//
// 純音訊模式 (e6-t04, `audioOnly`; not the month's audio-only usage state, e11-t13): no camera or
// screen of anyone else is received (unsubscribed: the SFU stops sending them), and our camera
// sends nothing (replaceTrack null, reported muted); microphones, the screen's sound and our own
// screen share go on. Turning it off subscribes again and sends the camera again. Anything may
// call setAudioOnly (the settings panel, H2's bandwidth adaptation); the room page turns the
// camera device off and back on with it.
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
  /** The simulcast layer asked for per received camera or screen, by trackKey (e2-t12) */
  layers: Readonly<Record<string, Layer>>
  /** Our own connection's level (e2-t13); null until the first samples */
  signal: SignalLevel | null
  /** Where the downlink adaptation stands (e2-t15) */
  downlink: DownlinkStage
  /** The video budget the layers are chosen within now */
  downlinkBudgetBps: number
  /** The highest layer our camera and screen send now (e2-t15) */
  uplink: UplinkState
  /** Other members' cameras not received to save the downlink, or in audio-only, by trackKey */
  pausedVideos: readonly string[]
  /** 純音訊模式 (e6-t04): no video received, our camera not sent */
  audioOnly: boolean
  /** HD is wanted (e6-t04): the camera sends its 720p layer, uplink allowing */
  hd: boolean
  /** HD is wanted but held back: the uplink is too short (media/uplink.ts) */
  hdLimited: boolean
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
  /** Where tiles draw each received video, for choosing layers (e2-t12) */
  demand?: VideoDemandStore
  /** Wait after a layout change before recomputing layers */
  layerDebounceMs?: number
  /** How often getStats() is read (STATS_POLL_MS; at most statsIntervalMs) */
  pollIntervalMs?: number
  /** Where the latest sample goes, for the stats panel (e2-t14) */
  stats?: StatsStore
  /** Adapt to the network (e2-t15); on unless a test turns it off */
  adapt?: boolean
  /** 純音訊模式 from the start (e6-t04; the pre-join screen's choice) */
  audioOnly?: boolean
  /** HD from the start (e6-t04); on without it */
  hd?: boolean
  /** How often the camera's uplink is sampled while HD is on (UPLINK_SAMPLE_MS) */
  uplinkSampleMs?: number
  /** The clock for the uplink check, for tests */
  now?: () => number
}

const RETRY_DELAY_MS = 2_000
/** A track that is still not there is tried again this often (a request per track) */
export const RETRY_MAX_MS = 15_000
/** ICE `disconnected` often heals by itself within a few seconds (a Wi-Fi hiccup) */
export const DISCONNECT_GRACE_MS = 4_000
export const STABLE_AFTER_MS = 20_000
/** Layout changes come in bursts (a resize, a scroll, the strip's animation): settle first */
export const LAYER_DEBOUNCE_MS = 400
/** getStats() is read this often (e2-t13, PRD: 每 2 秒) */
export const STATS_POLL_MS = 2_000
/** How many cameras stay when the downlink cuts them: the first ones setVideoPriority lists */
export const KEEP_WHEN_CUT = 2
/** A kept camera stays this long after it was last listed (the speaker changes often) */
export const KEEP_HOLD_MS = 15_000
/** The layer a received video starts with, before its tile reports (e2-t12) */
export const INITIAL_LAYER: Record<'cam' | 'screen', Layer> = { cam: 'medium', screen: 'high' }

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
  layers: {},
  signal: null,
  downlink: 'normal',
  downlinkBudgetBps: DOWNLINK_BUDGET_BPS,
  uplink: FULL_UPLINK,
  pausedVideos: [],
  audioOnly: false,
  hd: true,
  hdLimited: false,
}

const LAYER_ORDER: Record<Layer, number> = { high: 2, medium: 1, low: 0 }
/** The lower of two layers */
const lowerLayer = (a: Layer, b: Layer): Layer => (LAYER_ORDER[a] <= LAYER_ORDER[b] ? a : b)

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
  private readonly demand: VideoDemandStore | null
  private readonly layerDebounceMs: number
  private layerTimer: Timer | null = null
  private offDemand: (() => void) | null = null
  private readonly pollIntervalMs: number
  private readonly statsStore: StatsStore | null
  private readonly adapt: boolean
  /** The previous reading, and the transport it came from (a new session starts afresh) */
  private lastStats: { transport: MediaTransport; stats: TransportStats } | null = null
  private polls = 0
  private polling = false
  private readonly meter = new SignalMeter()
  private readonly downlink = new DownlinkAdaptation()
  private readonly uplink = new UplinkAdaptation()
  /** The cameras kept when the downlink cuts them, by trackKey (setVideoPriority) */
  private kept: string[] = []
  /** When each camera was last among the first KEEP_WHEN_CUT listed */
  private readonly listedAt = new Map<string, number>()
  /** The level last sent to the room, and when; a report waiting for SIGNAL_REPORT_MS */
  private signalSent: { level: SignalLevel; at: number } | null = null
  private signalTimer: Timer | null = null
  /** The highest layer the published camera sends now (e6-t04); null before it is published */
  private sendingTop: Layer | null = null
  /** The highest layer the published screen sends now (e2-t15); null before it is published */
  private sendingScreenTop: Layer | null = null
  /** The latest stats sample (H3's uplink check reads it: one getStats() path) */
  private lastSample: StatsSample | null = null
  private readonly uplinkSampleMs: number
  private readonly now: () => number
  private uplinkTimer: ReturnType<typeof setInterval> | null = null
  /** The uplink check while the camera sends its 720p layer; null otherwise */
  private uplinkCheck: UplinkCheck | null = null
  /** Trying HD again after it was held back */
  private hdRetryTimer: Timer | null = null
  /** Times HD was held back since it was last turned on: how long the next retry waits */
  private holdBacks = 0

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
    this.demand = options.demand ?? null
    this.layerDebounceMs = options.layerDebounceMs ?? LAYER_DEBOUNCE_MS
    this.uplinkSampleMs = options.uplinkSampleMs ?? UPLINK_SAMPLE_MS
    this.now = options.now ?? (() => Date.now())
    this.state = {
      ...this.state,
      audioOnly: options.audioOnly ?? false,
      hd: options.hd ?? true,
    }
    this.offDemand = this.demand?.subscribe(() => this.scheduleLayers()) ?? null
    this.pollIntervalMs = Math.min(options.pollIntervalMs ?? STATS_POLL_MS, this.statsIntervalMs)
    this.statsStore = options.stats ?? null
    this.adapt = options.adapt ?? true
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
    this.statsTimer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.uplinkTimer = setInterval(() => void this.sampleUplink(), this.uplinkSampleMs)
    await this.openSession(this.transport, 'connecting')
  }

  /**
   * 純音訊模式 on or off (e6-t04): stops or starts receiving everyone's video and sending our
   * camera. Resolves once what we send is applied.
   */
  setAudioOnly(on: boolean): Promise<void> {
    if (on === this.state.audioOnly) return this.localQueue
    this.update({ audioOnly: on })
    if (!on) {
      // Back from audio-only: the downlink adaptation starts over (e2-t15; the network may have
      // changed meanwhile)
      this.downlink.reset()
      this.update({ downlink: 'normal', downlinkBudgetBps: this.downlink.state.budgetBps })
    }
    this.reconcile()
    if (!this.ready) return this.localQueue
    return this.syncLocal()
  }

  /** HD on or off (e6-t04). Turning it on tries at once, even after the uplink held it back. */
  setHd(on: boolean): Promise<void> {
    if (on === this.state.hd) return this.localQueue
    this.clearHdRetry()
    this.holdBacks = 0
    this.update({ hd: on, hdLimited: false })
    if (!this.ready) return this.localQueue
    return this.syncLocal()
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

  /**
   * The cameras that matter most now (e2-t15): `chosen` ones (a pin, a spotlight) and the
   * `speakers` (the big tile, whoever speaks), most important first. While the downlink cuts
   * video, KEEP_WHEN_CUT of them stay: the chosen ones always, a speaker in a free place. The
   * speaker changes every few seconds, and each change would be an unsubscribe and a subscribe
   * (a renegotiation each; measured on the PR preview, #31: one every 3 s), so a camera keeps its
   * place for KEEP_HOLD_MS after it was last listed, unless a chosen one needs it.
   */
  setVideoPriority(chosen: readonly string[], speakers: readonly string[] = []): void {
    const now = Date.now()
    const listed = [...new Set([...chosen, ...speakers])].slice(0, KEEP_WHEN_CUT)
    for (const key of listed) this.listedAt.set(key, now)
    const kept = this.kept.filter((key) => this.desired.has(key))
    for (const key of listed) {
      if (kept.includes(key)) continue
      if (kept.length < KEEP_WHEN_CUT) {
        kept.push(key)
        continue
      }
      // The kept camera listed longest ago gives its place: once its hold is over, or at once to
      // a chosen one
      const out = kept
        .filter((k) => !listed.includes(k))
        .sort((a, b) => (this.listedAt.get(a) ?? 0) - (this.listedAt.get(b) ?? 0))[0]
      if (!out) continue
      const held = now - (this.listedAt.get(out) ?? 0) < KEEP_HOLD_MS
      if (held && !chosen.includes(key)) continue
      kept[kept.indexOf(out)] = key
    }
    for (const [key, at] of this.listedAt) {
      if (!kept.includes(key) && now - at >= KEEP_HOLD_MS) this.listedAt.delete(key)
    }
    if (kept.length === this.kept.length && kept.every((key, i) => key === this.kept[i])) return
    this.kept = kept
    this.reconcile()
  }

  /** Whether a desired track is to be received now: 純音訊模式 and the adaptation may say no */
  private wants(key: string): boolean {
    const track = this.desired.get(key)
    if (!track) return false
    if (track.kind !== 'cam' && track.kind !== 'screen') return true
    if (this.state.audioOnly) return false
    if (track.kind === 'screen') return true
    const cut = this.state.downlink === 'videoCut' || this.state.downlink === 'audioOnly'
    return !cut || this.kept.includes(key)
  }

  /** Subscribes to what is desired and missing, unsubscribes what is received and not desired */
  reconcile(): void {
    this.updatePaused()
    if (this.closed || this.state.status !== 'connected') return
    for (const [key, track] of this.desired) {
      if (key in this.state.received || this.pending.has(key) || this.ended.has(key)) continue
      if (this.retryTimers.has(key) || !this.wants(key)) continue
      void this.subscribeTo(key, track)
    }
    for (const key of Object.keys(this.state.received)) {
      if (this.wants(key)) continue
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
    // The room keeps our level while we reconnect; one that forgot us gets it again
    this.signalSent = null
    this.reportSignal()
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

  /** The cameras listed and not received because of the adaptation or audio-only */
  private updatePaused(): void {
    const paused = [...this.desired]
      .filter(([key, track]) => track.kind === 'cam' && !track.muted && !this.wants(key))
      .map(([key]) => key)
      .sort()
    const now = this.state.pausedVideos
    if (paused.length === now.length && paused.every((key, i) => key === now[i])) return
    this.update({ pausedVideos: paused })
  }

  /** Stops everything; the published tracks end on the SFU with the session */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.ready = false
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    if (this.signalTimer !== null) clearTimeout(this.signalTimer)
    this.signalTimer = null
    if (this.uplinkTimer !== null) clearInterval(this.uplinkTimer)
    this.clearHdRetry()
    this.clearSessionTimers()
    this.clearRetries()
    this.detach()
    this.offDemand?.()
    this.offDemand = null
    this.update({ status: 'closed', received: {}, layers: {} })
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
        // Layout changes while the connection was down were not sent
        this.scheduleLayers()
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
    this.sendingTop = null
    this.sendingScreenTop = null
    this.lastSample = null
    this.uplinkCheck = null
    this.update({
      status: 'reconnecting',
      error: null,
      published: [],
      received: {},
      layers: {},
      usingRelay: false,
      signal: null,
      rebuilds: this.state.rebuilds + 1,
    })
    this.meter.reset()
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
      this.layerTimer,
    ]) {
      if (timer !== null) clearTimeout(timer)
    }
    this.rebuildTimer = this.disconnectTimer = this.stableTimer = this.iceTimer = null
    this.layerTimer = null
  }

  /** Recomputes the layers once things settle (a burst of layout changes is one recompute) */
  private scheduleLayers(): void {
    if (this.closed || !this.demand) return
    if (this.layerTimer !== null) clearTimeout(this.layerTimer)
    this.layerTimer = setTimeout(() => {
      this.layerTimer = null
      this.applyLayers()
    }, this.layerDebounceMs)
  }

  /** Asks the SFU for each received video's layer, where it changed (media/layers.ts) */
  private applyLayers(): void {
    const demand = this.demand
    if (this.closed || !demand || !this.ready || this.state.status !== 'connected') return
    const transport = this.transport
    const inputs: LayerInput[] = []
    for (const [key, received] of Object.entries(this.state.received)) {
      if (received.kind !== 'cam' && received.kind !== 'screen') continue
      inputs.push({
        key,
        kind: received.kind,
        demand: demand.get(received.track),
        current: this.state.layers[key] ?? null,
      })
    }
    const chosen = chooseLayers(inputs, this.state.downlinkBudgetBps)
    const changes = [...chosen].filter(([key, layer]) => this.state.layers[key] !== layer)
    if (changes.length === 0) return
    this.update({ layers: { ...this.state.layers, ...Object.fromEntries(changes) } })
    for (const [key, layer] of changes) {
      const { sessionId, trackName } = this.state.received[key]
      transport.setPreferredLayer({ sessionId, trackName }, layer).catch(() => {
        // Not applied (unsubscribed meanwhile, or the call failed): forget it, so that the next
        // recompute asks again
        if (this.closed || transport !== this.transport || this.state.layers[key] !== layer) return
        const layers = { ...this.state.layers }
        delete layers[key]
        this.update({ layers })
        if (key in this.state.received) {
          setTimeout(() => this.scheduleLayers(), this.retryDelayMs)
        }
      })
    }
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
      // 純音訊模式 sends no camera, whatever the device does
      const want = kind === 'cam' && this.state.audioOnly ? null : this.wanted[kind]
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
    await this.applyTopLayer(transport)
    if (this.closed || !this.ready || transport !== this.transport) return
    await this.applyScreen(transport)
    if (this.closed || !this.ready || transport !== this.transport) return
    await this.applyScreenTop(transport)
  }

  /**
   * The camera's highest layer as HD (e6-t04) and the uplink adaptation (e2-t15) want it: the
   * lower of the two
   */
  private async applyTopLayer(transport: MediaTransport): Promise<void> {
    const own = this.state.published.find((track) => track.kind === 'cam')
    if (!own) return
    const hdTop: Layer = this.state.hd && !this.state.hdLimited ? 'high' : 'medium'
    const top = lowerLayer(hdTop, this.state.uplink.cam)
    if (this.sendingTop === top) return
    try {
      await transport.setTopLayer(own.trackName, top)
    } catch {
      // Not applied (the session is going): a rebuild publishes again and applies it then
      return
    }
    if (this.closed || transport !== this.transport) return
    this.sendingTop = top
    this.uplinkCheck = top === 'high' ? startUplinkCheck(this.now()) : null
  }

  /** The screen's highest layer as the uplink adaptation wants it (e2-t15) */
  private async applyScreenTop(transport: MediaTransport): Promise<void> {
    const own = this.state.published.find((track) => track.kind === 'screen')
    const top = this.state.uplink.screen
    if (!own || this.sendingScreenTop === top) return
    try {
      await transport.setTopLayer(own.trackName, top)
    } catch {
      return
    }
    if (this.closed || transport !== this.transport) return
    this.sendingScreenTop = top
  }

  /**
   * One uplink sample while the camera sends its 720p layer (e6-t04): several short ones in a row
   * hold HD back, and a retry is scheduled
   */
  private sampleUplink(): void {
    if (this.closed || !this.ready || this.state.status !== 'connected') return
    const own = this.state.published.find((track) => track.kind === 'cam')
    if (!own || this.sendingTop !== 'high' || this.state.lowQuality) return
    if (!this.sending.cam) {
      // Nothing goes out: judge again from the start once the camera is back
      this.uplinkCheck = null
      return
    }
    if (!this.uplinkCheck) {
      this.uplinkCheck = startUplinkCheck(this.now())
      return
    }
    const stats = this.lastSample
    if (!stats) return
    const sent = stats.outbound.find((track) => track.trackName === own.trackName)
    const limitation = sent?.qualityLimitationReason ?? null
    const sample: UplinkStats = {
      availableOutgoingBitrate: stats.availableOutgoingBitrate,
      limitation:
        limitation === 'none' || limitation === 'bandwidth' || limitation === 'cpu'
          ? limitation
          : limitation === null
            ? null
            : 'other',
    }
    if (!this.uplinkCheck || !this.state.hd || this.state.hdLimited) return
    const { check, holdBack } = nextUplinkCheck(this.uplinkCheck, sample, this.now())
    this.uplinkCheck = check
    if (!holdBack) return
    this.holdBacks += 1
    this.update({ hdLimited: true })
    this.clearHdRetry()
    this.hdRetryTimer = setTimeout(() => {
      this.hdRetryTimer = null
      if (this.closed || !this.state.hd) return
      this.update({ hdLimited: false })
      void this.syncLocal()
    }, uplinkRetryWait(this.holdBacks))
    void this.syncLocal()
  }

  private clearHdRetry(): void {
    if (this.hdRetryTimer !== null) clearTimeout(this.hdRetryTimer)
    this.hdRetryTimer = null
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
      const published = await transport.publish(want, { kind: 'screen', simulcast: true })
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
      // A new publish sends every layer; applyScreenTop applies the uplink's ceiling (e2-t15)
      this.sendingScreenTop = 'high'
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
      // The camera goes out in three layers for receivers to pick from (e2-t11)
      const published = await transport.publish(track, { kind, simulcast: kind === 'cam' })
      if (this.closed || transport !== this.transport) return
      this.sending[kind] = track
      // A new publish sends every layer; applyTopLayer turns the top one off for HD off
      if (kind === 'cam') this.sendingTop = 'high'
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
    const layer = track.kind === 'cam' || track.kind === 'screen' ? INITIAL_LAYER[track.kind] : null
    try {
      const remote = await transport.subscribe(track, layer ? { layer } : undefined)
      if (transport !== this.transport) return
      this.pending.delete(key)
      if (this.closed) return
      if (!this.wants(key)) {
        // Left the list (or the adaptation cut it) while we were subscribing
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
        layers: layer ? { ...this.state.layers, [key]: layer } : this.state.layers,
      })
      if (layer) this.scheduleLayers()
    } catch {
      if (transport !== this.transport) return
      this.pending.delete(key)
      if (this.closed || !this.wants(key)) return
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

  /**
   * One read of the connection's statistics (every pollIntervalMs): the sample, the signal level,
   * the room's byte count every STATS_INTERVAL_MS, and a step of the adaptation
   */
  private async poll(): Promise<void> {
    const transport = this.transport
    const sessionId = transport.sessionId
    if (this.closed || !this.ready || !sessionId || this.polling) return
    this.polling = true
    let stats: TransportStats
    try {
      stats = await transport.getStats()
    } catch {
      // Not connected yet; the next tick tries again
      return
    } finally {
      this.polling = false
    }
    if (this.closed || transport !== this.transport) return
    const previous = this.lastStats?.transport === transport ? this.lastStats.stats : null
    this.lastStats = { transport, stats }
    const sample = sampleStats(previous, stats)
    this.lastSample = sample
    if (stats.usingRelay !== this.state.usingRelay) this.update({ usingRelay: stats.usingRelay })
    this.polls += 1
    if (this.polls % Math.max(1, Math.round(this.statsIntervalMs / this.pollIntervalMs)) === 0) {
      this.send({
        t: 'stats',
        sessionId,
        bytesReceived: Math.round(stats.bytesReceived),
        relay: stats.usingRelay,
      })
    }
    if (sample.intervalMs > 0) {
      const expected = (key: string) => this.expectedFps(key)
      const signal = this.meter.push(connectionVerdict(sample, expected))
      if (signal !== this.state.signal) {
        this.update({ signal })
        this.reportSignal()
      }
      if (this.adapt && !this.state.audioOnly && this.state.status === 'connected') {
        this.adaptDownlink(downlinkVerdict(sample, expected))
        this.adaptUplink(sample)
      }
    }
    this.statsStore?.set({
      sample,
      layers: this.state.layers,
      signal: this.state.signal,
      downlink: this.downlink.state,
      uplink: this.uplink.state,
      paused: this.state.pausedVideos,
      audioOnly: this.state.audioOnly,
    })
  }

  /** The frame rate a received camera's layer is sent at (screens: content decides, not judged) */
  private expectedFps(key: string): number | null {
    const received = this.state.received[key]
    const layer = this.state.layers[key]
    if (received?.kind !== 'cam' || !layer) return null
    return SIMULCAST.cam.find((l) => l.layer === layer)?.maxFramerate ?? null
  }

  /** One step of the downlink's adaptation: a new budget, a cut, or the end of one */
  private adaptDownlink(verdict: SignalLevel): void {
    let askedBps = 0
    let floorBps = 0
    let videos = 0
    for (const [key, received] of Object.entries(this.state.received)) {
      if (received.kind !== 'cam' && received.kind !== 'screen') continue
      const layers = ladder(received.kind)
      const asked = layers.find((l) => l.layer === this.state.layers[key]) ?? layers[0]
      askedBps += asked.maxBitrate
      floorBps += layers[layers.length - 1].maxBitrate
      videos += 1
    }
    const before = this.downlink.state
    const after = this.downlink.step({ verdict, askedBps, floorBps, videos })
    if (after === before) return
    this.update({ downlink: after.stage, downlinkBudgetBps: after.budgetBps })
    // A new budget applies now (no layout debounce); a cut, or its end, unsubscribes or subscribes
    if (after.budgetBps !== before.budgetBps) this.applyLayers()
    if (after.stage !== before.stage) this.reconcile()
  }

  /** One step of the uplink's adaptation: the top layers we send off, or on again */
  private adaptUplink(sample: StatsSample): void {
    const sends = (kind: TrackKind) => this.state.published.some((t) => t.kind === kind && !t.muted)
    const limit = encoderLimit(sample)
    const verdict = uplinkVerdict(sample)
    const before = this.uplink.state
    const after = this.uplink.step({
      pressure: verdict === 'poor' ? 'bandwidth' : limit,
      clear: limit === null && verdict === 'good',
      cam: sends('cam'),
      screen: sends('screen'),
      availableBps: sample.availableOutgoingBitrate,
    })
    if (after === before) return
    this.update({ uplink: after })
    this.applyUplink()
  }

  /** Our camera and screen send no layer above the uplink's ceiling (e2-t15), with HD's */
  private applyUplink(): void {
    void this.syncLocal()
  }

  /** Tells the room our level, at most every SIGNAL_REPORT_MS (a change in between waits) */
  private reportSignal(): void {
    const level = this.state.signal
    if (this.closed || level === null || this.signalTimer !== null) return
    if (this.signalSent?.level === level) return
    const now = Date.now()
    const wait = this.signalSent ? this.signalSent.at + SIGNAL_REPORT_MS - now : 0
    if (wait > 0) {
      this.signalTimer = setTimeout(() => {
        this.signalTimer = null
        this.reportSignal()
      }, wait)
      return
    }
    this.signalSent = { level, at: now }
    this.send({ t: 'signal', level })
  }

  private removeReceived(key: string): void {
    const received = { ...this.state.received }
    delete received[key]
    const layers = { ...this.state.layers }
    delete layers[key]
    this.update({ received, layers })
  }

  private update(changes: Partial<RoomMediaState>): void {
    this.state = { ...this.state, ...changes }
    for (const listener of this.listeners) listener()
  }
}
