// How good the connection is (e2-t13, e2-t15; AC-2.7), from one StatsSample: a verdict for what
// we receive (downlink), one for what we send (uplink), and the signal level the nameplates show
// (三段：好／普通／差). Pure functions; the thresholds are here so the tests can pin them down.
//
// Downlink: packet loss over the interval (video and audio apart, weighted by packets), audio
// concealment (samples the decoder made up), the audio jitter buffer, video freezes and decoded
// frame rate. Freezes and a low frame rate count only together with some loss: without loss the
// publisher (its camera, CPU or uplink) is the cause, and lowering what we receive would not help.
// RTT is left to the signal level: a long path is not congestion.
// Uplink: the encoder's qualityLimitationReason (bandwidth, cpu) and the loss the SFU reports back.
import type { SignalLevel } from '../../shared/protocol.ts'
import type { InboundSample, StatsSample } from './stats.ts'

export type { SignalLevel }

const RANK: Record<SignalLevel, number> = { good: 0, fair: 1, poor: 2 }
export const worse = (a: SignalLevel, b: SignalLevel): SignalLevel => (RANK[a] >= RANK[b] ? a : b)

/** Below this many packets in an interval, loss is too noisy to judge (one in twenty is 5 %) */
export const MIN_PACKETS = 50

export const DOWNLINK = {
  /** Video loss over the interval */
  videoLossFair: 0.015,
  videoLossPoor: 0.05,
  audioLossFair: 0.02,
  audioLossPoor: 0.05,
  /** Audio samples concealed over the interval */
  concealedFair: 0.03,
  concealedPoor: 0.08,
  /** Average wait in the audio jitter buffer */
  jitterBufferFairMs: 200,
  jitterBufferPoorMs: 400,
  audioJitterFairMs: 40,
  /** Freezes count only with at least this much video loss (otherwise: the sender) */
  freezeNeedsLoss: 0.005,
  /** Frozen this long in one interval, summed over the videos: poor */
  freezePoorMs: 600,
  /** A video decoding fewer frames than this share of its layer's rate, with loss: fair */
  lowFpsShare: 0.5,
  lowFpsNeedsLoss: 0.01,
} as const

export const UPLINK = {
  videoLossFair: 0.03,
  videoLossPoor: 0.1,
  audioLossFair: 0.02,
  audioLossPoor: 0.05,
} as const

export const RTT = { fairMs: 300, poorMs: 700 } as const

const sumLoss = (tracks: readonly InboundSample[]) => {
  const lost = tracks.reduce((sum, t) => sum + t.lost, 0)
  const packets = tracks.reduce((sum, t) => sum + t.packets, 0) + lost
  return { packets, rate: packets > 0 ? lost / packets : 0 }
}

/**
 * The downlink's verdict for one interval. `expectedFps` gives the frame rate a received video
 * should decode at (its layer's, layers.ts), by trackKey; without it the frame rate is not judged.
 */
export function downlinkVerdict(
  sample: StatsSample,
  expectedFps: (key: string) => number | null = () => null,
): SignalLevel {
  const video = sample.inbound.filter((t) => t.media === 'video')
  const audio = sample.inbound.filter((t) => t.media === 'audio')
  let level: SignalLevel = 'good'
  const v = sumLoss(video)
  if (v.packets >= MIN_PACKETS) {
    if (v.rate >= DOWNLINK.videoLossPoor) level = 'poor'
    else if (v.rate >= DOWNLINK.videoLossFair) level = worse(level, 'fair')
  }
  const a = sumLoss(audio)
  if (a.packets >= MIN_PACKETS) {
    if (a.rate >= DOWNLINK.audioLossPoor) level = 'poor'
    else if (a.rate >= DOWNLINK.audioLossFair) level = worse(level, 'fair')
  }
  for (const track of audio) {
    const concealed = track.concealedRatio ?? 0
    if (concealed >= DOWNLINK.concealedPoor) level = 'poor'
    else if (concealed >= DOWNLINK.concealedFair) level = worse(level, 'fair')
    const buffer = track.jitterBufferMs ?? 0
    if (buffer >= DOWNLINK.jitterBufferPoorMs) level = 'poor'
    else if (buffer >= DOWNLINK.jitterBufferFairMs) level = worse(level, 'fair')
    if ((track.jitterMs ?? 0) >= DOWNLINK.audioJitterFairMs) level = worse(level, 'fair')
  }
  if (v.packets > 0 && v.rate >= DOWNLINK.freezeNeedsLoss) {
    const frozenMs = video.reduce((sum, t) => sum + t.freezeMs, 0)
    if (frozenMs >= DOWNLINK.freezePoorMs) level = 'poor'
    else if (video.some((t) => t.freezes > 0)) level = worse(level, 'fair')
  }
  for (const track of video) {
    const expected = expectedFps(`${track.sessionId}/${track.trackName}`)
    if (!expected || track.fps === null || (track.lossRate ?? 0) < DOWNLINK.lowFpsNeedsLoss) {
      continue
    }
    if (track.fps < expected * DOWNLINK.lowFpsShare) level = worse(level, 'fair')
  }
  return level
}

/** True when the encoder of a sent camera or screen is held back by bandwidth or CPU */
export function encoderLimited(sample: StatsSample): boolean {
  return sample.outbound.some(
    (t) =>
      (t.kind === 'cam' || t.kind === 'screen') &&
      (t.qualityLimitationReason === 'bandwidth' || t.qualityLimitationReason === 'cpu'),
  )
}

/** The uplink's verdict for one interval: the SFU's loss reports, and a held-back encoder */
export function uplinkVerdict(sample: StatsSample): SignalLevel {
  let level: SignalLevel = encoderLimited(sample) ? 'fair' : 'good'
  for (const track of sample.outbound) {
    const loss = track.lossRate ?? 0
    const audio = track.kind === 'mic' || track.kind === 'screenAudio'
    const poor = audio ? UPLINK.audioLossPoor : UPLINK.videoLossPoor
    const fair = audio ? UPLINK.audioLossFair : UPLINK.videoLossFair
    if (loss >= poor) level = 'poor'
    else if (loss >= fair) level = worse(level, 'fair')
  }
  return level
}

export function rttVerdict(rttMs: number | null): SignalLevel {
  if (rttMs === null) return 'good'
  if (rttMs >= RTT.poorMs) return 'poor'
  if (rttMs >= RTT.fairMs) return 'fair'
  return 'good'
}

/** The whole connection for one interval: the worst of the downlink, the uplink and the RTT */
export function connectionVerdict(
  sample: StatsSample,
  expectedFps?: (key: string) => number | null,
): SignalLevel {
  return worse(
    worse(downlinkVerdict(sample, expectedFps), uplinkVerdict(sample)),
    rttVerdict(sample.rttMs),
  )
}

/** How many intervals the signal level looks back over (with STATS_POLL_MS: 6 s) */
export const SIGNAL_WINDOW = 3

/**
 * The nameplate's signal level, steadied: the second-worst verdict of the last SIGNAL_WINDOW, so
 * a single bad interval does not flash 差 on everyone's screen, and two of three do.
 */
export class SignalMeter {
  #recent: SignalLevel[] = []

  push(verdict: SignalLevel): SignalLevel {
    this.#recent = [...this.#recent, verdict].slice(-SIGNAL_WINDOW)
    return this.level
  }

  get level(): SignalLevel {
    const sorted = [...this.#recent].sort((a, b) => RANK[b] - RANK[a])
    return sorted[Math.min(1, sorted.length - 1)] ?? 'good'
  }

  reset(): void {
    this.#recent = []
  }
}
