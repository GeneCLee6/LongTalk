// The Realtime free-tier guard (e11-t13, AC-11.11). The owner runs LongTalk on Cloudflare's free
// allowance only: 1,000 GB of egress a month, shared by the SFU and TURN. A singleton UsageDO
// (worker/usage-do.ts) keeps this calendar month's estimate; past the thresholds the rooms are
// told to send low quality, then new video tracks are refused (audio keeps working).
//
// How a month's bytes are counted: every room flushes, about every SWEEP_INTERVAL_MS while anyone
// is in it, two numbers for the interval since its last flush, and the larger one is added:
// - what its browsers reported (`stats`: the transport's cumulative bytesReceived, which is the
//   SFU's egress to that browser), and
// - the server's own estimate: elapsed time × every track a connected member could receive ×
//   the bitrate assumed for its kind, the video part capped at MAX_ASSUMED_VIDEO_BPS per receiver
//   (L1: a browser receives what is on its screen within a budget, not everyone's top layer).
// The estimate does not trust the browsers, so a browser that reports nothing cannot hide its
// traffic; the reports catch what the estimate gets wrong (a camera sending more than assumed).
//
// TURN (e2-t07): a browser behind a strict NAT receives through Cloudflare's TURN relay. TURN
// shares the 1,000 GB allowance, but traffic between Realtime TURN and the SFU "is not charged
// twice" (Cloudflare's pricing page): what is billed is TURN's egress to the browser, which is the
// same media plus TURN's framing (and TCP/TLS when the relay runs over turns:443). So both
// numbers count a relayed receiver's bytes × RELAY_OVERHEAD; the browser says in `stats` whether
// its selected candidate pair is relayed.
import type { TrackKind } from './protocol.ts'

/**
 * - `normal`: nothing to do
 * - `low`: past the low-quality threshold; cameras send low resolution
 * - `audioOnly`: past the audio-only threshold; new video tracks are refused
 */
export type UsageState = 'normal' | 'low' | 'audioOnly'

/** What GET /api/usage answers */
export type UsageStatus = {
  /** UTC calendar month the count is for, `YYYY-MM` */
  month: string
  /** Estimated egress this month, bytes */
  bytes: number
  state: UsageState
}

/** One GB as Cloudflare bills it (decimal) */
export const GB = 1_000_000_000

/** Defaults for the USAGE_LOW_QUALITY_GB and USAGE_AUDIO_ONLY_GB vars */
export const DEFAULT_LOW_QUALITY_GB = 800
export const DEFAULT_AUDIO_ONLY_GB = 950

/**
 * Bits per second the server estimate assumes for a track the SFU forwards to one receiver.
 * On the high side on purpose: B1 sends one 720p camera layer (simulcast is e2-t11).
 */
export const ASSUMED_BITRATE: Record<TrackKind, number> = {
  mic: 64_000,
  cam: 1_500_000,
  screen: 2_500_000,
  screenAudio: 64_000,
}

/**
 * The most video the server estimate assumes one receiver gets: AC-10.3's 6 Mbps, above the
 * browser's own budget (src/media/layers.ts, 3.4 Mbps) on purpose. Without the cap a 25-person
 * room would count as 25 × 24 × 1.5 Mbps, about 400 GB an hour, when the budget allows about
 * 40 GB. A browser that takes more than this shows up in its own `stats`.
 */
export const MAX_ASSUMED_VIDEO_BPS = 6_000_000

/**
 * What a relayed receiver's egress is counted at, relative to the media it receives: TURN's
 * ChannelData header is 4 bytes a packet (under 1 %), TCP/TLS framing over turns:443 a few
 * percent more; rounded up on purpose, like ASSUMED_BITRATE.
 */
export const RELAY_OVERHEAD = 1.1

/** How often a browser reports its received bytes over the room socket */
export const STATS_INTERVAL_MS = 10_000

/** A report above this rate is clamped: one browser must not be able to push the count up alone */
export const MAX_REPORTED_BITRATE = 25_000_000

/** Video kinds: the ones refused once the month reaches the audio-only threshold */
export const isVideoKind = (kind: TrackKind): boolean => kind === 'cam' || kind === 'screen'

/** GET: this month's UsageStatus */
export const USAGE_PATH = '/api/usage'
