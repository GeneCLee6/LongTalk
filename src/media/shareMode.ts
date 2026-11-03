// Text and motion modes for a screen share (e3-t06, AC-3.4; ADR-001 「編碼參數」 and
// 「分享模式」): how the published screen is encoded, switched live from the sharing bar without
// picking the screen again, and the hint that the content moves too much for 文字. Pure: the
// transport applies the parameters (MediaTransport.setShareMode, CLAUDE.md rule 2), the room's
// share sampler feeds the detector. No React, no DOM.
//
// - 文字 (`text`, the default): resolution first. contentHint `detail`, the full capture (up to
//   1080p) in the top layer, up to 30 fps, and `balanced` degradation: what D1's field test
//   settled on (2026-11-03: `maintain-resolution` held 1080p and fell to a frame or two a second
//   under pressure; 15 fps was choppy for scrolling). A still document sends almost nothing at
//   any frame rate: the encoder only spends bits on what changes.
// - 動態 (`motion`): frame rate first. contentHint `motion`, `maintain-framerate` degradation
//   (under pressure the encoder lowers resolution, never the frame rate), the top layer at most
//   720p and the second at most 360p, both at 30 fps: a video or an animation stays smooth.

import { SIMULCAST } from './encoding.ts'

export type ShareMode = 'text' | 'motion'

export const SHARE_MODES: readonly ShareMode[] = ['text', 'motion']

export const isShareMode = (value: unknown): value is ShareMode =>
  value === 'text' || value === 'motion'

/** One layer's ceiling in a mode: its short side at most this, at most this many fps */
export interface ShareModeLayer {
  /** null: the capture's own size (no cap) */
  maxShortSide: number | null
  maxFramerate: number
  maxBitrate: number
}

export interface ShareModeParameters {
  contentHint: 'detail' | 'motion'
  degradationPreference: RTCDegradationPreference
  /** By rid (encoding.ts SIMULCAST.screen: `f`, `h`) */
  layers: Readonly<Record<string, ShareModeLayer>>
  /** A sender that refused simulcast: its one encoding */
  single: ShareModeLayer
}

const [TOP, SECOND] = SIMULCAST.screen

export const SHARE_MODE_PARAMETERS: Record<ShareMode, ShareModeParameters> = {
  text: {
    contentHint: 'detail',
    degradationPreference: 'balanced',
    layers: {
      [TOP.rid]: { maxShortSide: null, maxFramerate: TOP.maxFramerate, maxBitrate: TOP.maxBitrate },
      // Half size (encoding.ts): the capture's short side over two
      [SECOND.rid]: {
        maxShortSide: null,
        maxFramerate: SECOND.maxFramerate,
        maxBitrate: SECOND.maxBitrate,
      },
    },
    single: { maxShortSide: null, maxFramerate: 30, maxBitrate: TOP.maxBitrate },
  },
  motion: {
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
    layers: {
      [TOP.rid]: { maxShortSide: 720, maxFramerate: 30, maxBitrate: TOP.maxBitrate },
      [SECOND.rid]: { maxShortSide: 360, maxFramerate: 30, maxBitrate: SECOND.maxBitrate },
    },
    single: { maxShortSide: 720, maxFramerate: 30, maxBitrate: TOP.maxBitrate },
  },
}

/** A layer's scale-down for a capture `shortSide` px high, never below the layer's own scale */
function scaleFor(base: number, cap: ShareModeLayer, shortSide: number | null): number {
  if (cap.maxShortSide === null || !shortSide || shortSide <= 0) return base
  const scale = Math.max(base, shortSide / cap.maxShortSide)
  // Two decimals: an encoder given 1.4999… and 1.5 makes the same picture
  return Math.round(scale * 100) / 100
}

/**
 * A screen sender's encodings in `mode`, for a capture whose short side is `shortSide` px (the
 * track's settings; null when unknown: the layers' own scales). Each simulcast layer (by rid) gets
 * the mode's frame rate, bitrate and size ceiling; `active` (the uplink's top layer, e2-t15) and
 * anything else is kept. A single encoding gets the mode's `single` ceiling.
 */
export function withShareMode(
  encodings: readonly RTCRtpEncodingParameters[],
  mode: ShareMode,
  shortSide: number | null,
): RTCRtpEncodingParameters[] {
  const params = SHARE_MODE_PARAMETERS[mode]
  const layered = encodings.length > 1 && encodings.every((encoding) => encoding.rid)
  return encodings.map((encoding) => {
    const layer = layered ? SIMULCAST.screen.find((l) => l.rid === encoding.rid) : undefined
    const cap = layered ? params.layers[encoding.rid!] : params.single
    if (!cap) return { ...encoding }
    const base = layer?.scaleResolutionDownBy ?? 1
    return {
      ...encoding,
      scaleResolutionDownBy: scaleFor(base, cap, shortSide),
      maxFramerate: cap.maxFramerate,
      maxBitrate: cap.maxBitrate,
    }
  })
}

// ── The dynamic-content hint ─────────────────────────────────────────────────────────────────
//
// While sharing in 文字, a small copy of the screen is sampled once a second (the presenter
// view's thumbnail, src/room/shareSampler.ts). A sample "moves" when more than MOTION_CHANGE of
// its pixels changed brightness by more than PIXEL_DELTA since the one before: a playing video,
// an animation, a game. Typing, a moving cursor or one slide change do not; scrolling a document
// does for a moment. The hint comes when MOTION_NEEDED of the last MOTION_WINDOW samples moved
// (sustained motion, not a scroll), once per share: dismissed or followed, it does not come back
// until the share is picked again.

/** Brightness (0–255) a pixel must change by to count as changed (compression noise stays below) */
export const PIXEL_DELTA = 24
/** The share of pixels that must change for a sample to count as moving */
export const MOTION_CHANGE = 0.04
/** Samples looked at, one a second */
export const MOTION_WINDOW = 8
/** Moving samples among them for the hint */
export const MOTION_NEEDED = 6

/** One pixel's brightness from RGBA bytes (Rec. 601 weights, integers) */
const luma = (data: ArrayLike<number>, i: number) =>
  (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000

/**
 * The share of pixels whose brightness changed by more than PIXEL_DELTA between two RGBA frames
 * of the same size (0–1); 0 for frames of different sizes (the source changed: not motion)
 */
export function frameChange(before: ArrayLike<number>, after: ArrayLike<number>): number {
  if (before.length !== after.length || before.length < 4) return 0
  let changed = 0
  const pixels = Math.floor(before.length / 4)
  for (let i = 0; i < pixels * 4; i += 4) {
    if (Math.abs(luma(before, i) - luma(after, i)) > PIXEL_DELTA) changed += 1
  }
  return changed / pixels
}

/** Sustained motion from per-second change ratios: true once enough of the recent ones moved */
export class MotionMeter {
  readonly #recent: boolean[] = []

  /** One sample's change ratio (frameChange); returns whether the content moves, sustained */
  push(change: number): boolean {
    this.#recent.push(change > MOTION_CHANGE)
    if (this.#recent.length > MOTION_WINDOW) this.#recent.shift()
    return this.moving
  }

  get moving(): boolean {
    return this.#recent.filter(Boolean).length >= MOTION_NEEDED
  }

  reset(): void {
    this.#recent.length = 0
  }
}
