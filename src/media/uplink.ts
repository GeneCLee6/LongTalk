// The uplink check for HD (e6-t04, AC-6.4: 「上行不足不允許」). With HD on a camera sends its
// 720p layer too (encoding.ts SIMULCAST: about 1.7 Mbps for the three layers); on a thin uplink
// that only starves the other layers and the microphone. RoomMedia samples the camera's uplink
// (MediaTransport.getUplink) every UPLINK_SAMPLE_MS while HD is on and sent, and turns the 720p
// layer off when several samples in a row say the uplink is short:
//
// - the browser limits the camera for bandwidth (`qualityLimitationReason`), or
// - its estimate of what it can send (`availableOutgoingBitrate`) is under HD_MIN_UPLINK_BPS.
//
// The first UPLINK_WARMUP_MS after HD starts are not judged: the estimate starts at 1 Mbps
// (encoding.ts START_BITRATE_KBPS) and needs a few seconds to climb. While HD is held back the
// estimate cannot show a better uplink (the browser only probes up to what it is asked to send),
// so RoomMedia tries HD again after UPLINK_RETRY_MS, longer each time it is held back again.
// Pure functions: no timers, no React.
import type { QualityLimitation, UplinkStats } from './MediaTransport.ts'

/**
 * Below this estimate the camera's 720p layer is not worth sending: the three layers' caps add
 * up to 1.72 Mbps (encoding.ts), and the browser itself only turns the top layer on when the
 * estimate covers the lower two plus the top one's minimum. 1.5 Mbps leaves the audio and the
 * lower layers their room.
 */
export const HD_MIN_UPLINK_BPS = 1_500_000
export const UPLINK_SAMPLE_MS = 5_000
/** Short samples in a row before HD is held back (15 s at one sample per 5 s) */
export const UPLINK_LOW_SAMPLES = 3
export const UPLINK_WARMUP_MS = 15_000
/** The first wait before trying HD again; doubles each time, up to UPLINK_RETRY_MAX_MS */
export const UPLINK_RETRY_MS = 60_000
export const UPLINK_RETRY_MAX_MS = 8 * 60_000

export interface UplinkCheck {
  /** When HD (the top layer) started being sent, ms */
  since: number
  /** Short samples in a row */
  low: number
}

export const startUplinkCheck = (now: number): UplinkCheck => ({ since: now, low: 0 })

/** Whether one sample says the uplink is too short for HD */
export function uplinkShort(sample: UplinkStats): boolean {
  if (sample.limitation === 'bandwidth') return true
  return sample.availableOutgoingBitrate !== null && sample.availableOutgoingBitrate < HD_MIN_UPLINK_BPS
}

/** The next check after a sample at `now`, and whether HD must be held back now */
export function nextUplinkCheck(
  check: UplinkCheck,
  sample: UplinkStats,
  now: number,
): { check: UplinkCheck; holdBack: boolean } {
  if (now - check.since < UPLINK_WARMUP_MS) return { check, holdBack: false }
  const low = uplinkShort(sample) ? check.low + 1 : 0
  return { check: { ...check, low }, holdBack: low >= UPLINK_LOW_SAMPLES }
}

/** The wait before trying HD again after it was held back `times` times in a row */
export const uplinkRetryWait = (times: number): number =>
  Math.min(UPLINK_RETRY_MS * 2 ** Math.max(0, times - 1), UPLINK_RETRY_MAX_MS)

const LIMITATION_ORDER: readonly QualityLimitation[] = ['none', 'other', 'cpu', 'bandwidth']

const asLimitation = (value: unknown): QualityLimitation | null =>
  value === 'none' || value === 'bandwidth' || value === 'cpu'
    ? value
    : typeof value === 'string'
      ? 'other'
      : null

/**
 * Reads a sender's stats report (RTCRtpSender.getStats, which also carries the transport's
 * candidate pair) and, where the sender's report has no pair, the PeerConnection's: the worst
 * limitation across the outbound streams that are sending, and the selected pair's estimate
 */
export function readUplink(
  senderReport: Iterable<Record<string, unknown>>,
  pcReport: Iterable<Record<string, unknown>> = [],
): UplinkStats {
  let limitation: QualityLimitation | null = null
  let available: number | null = null
  const pairBitrate = (entry: Record<string, unknown>) =>
    entry.type === 'candidate-pair' &&
    entry.nominated === true &&
    entry.state === 'succeeded' &&
    typeof entry.availableOutgoingBitrate === 'number'
      ? entry.availableOutgoingBitrate
      : null
  for (const entry of senderReport) {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video' && entry.active !== false) {
      const reason = asLimitation(entry.qualityLimitationReason)
      if (
        reason !== null &&
        (limitation === null ||
          LIMITATION_ORDER.indexOf(reason) > LIMITATION_ORDER.indexOf(limitation))
      ) {
        limitation = reason
      }
    }
    available ??= pairBitrate(entry)
  }
  if (available === null) {
    for (const entry of pcReport) available ??= pairBitrate(entry)
  }
  return { availableOutgoingBitrate: available, limitation }
}
