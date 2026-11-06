// When 背景模糊 turns itself off (e6-t06, AC-6.5), and what the room sends meanwhile. Pure rules, in
// the room's first JS with the hook (useBackgroundBlur.ts); the pipeline itself is a lazy chunk.
//
// The rule is 「fps < 15 → off, with a notice」, judged on what the pipeline is responsible for. A
// camera that only gives 12 fps in a dim room, with the pipeline keeping up with every frame, is
// not overload: turning the blur off would show the room and win nothing back. So:
//
// - the masks cannot keep up (fewer than MIN_MASK_FPS a second, or under half the frames when the
//   video is under MIN_BLUR_FPS): the person's outline lags behind them, off;
// - the video is under MIN_BLUR_FPS while drawing it takes BUSY_LIMIT of the page's time: off;
// - the video is under MIN_BLUR_FPS and the pipeline is mostly idle: the camera's doing, stays on.
//
// Over budget BLUR_OVER_SECONDS seconds in a row counts; the first BLUR_WARMUP_SECONDS after a
// start or a new camera do not (the wasm is warming up, a camera is adjusting).

/** PRD: fps 低於 15 自動關閉 */
export const MIN_BLUR_FPS = 15
/** Fewer new masks a second than this and the outline visibly trails the person */
export const MIN_MASK_FPS = 5
/** The share of the page's time that drawing the frames may take while the video is too slow */
export const BUSY_LIMIT = 0.5
export const BLUR_OVER_SECONDS = 5
export const BLUR_WARMUP_SECONDS = 3

/** One second of the pipeline, as it reports it */
export interface BlurReport {
  /** Frames sent out in that second */
  fps: number
  /** New masks in that second */
  maskFps: number
  /** The share of that second spent drawing frames on the page, 0–1 */
  busy: number
  /** How long the latest mask took in the worker, ms */
  maskMs: number
}

export function blurOverBudget({ fps, maskFps, busy }: BlurReport): boolean {
  if (fps >= MIN_MASK_FPS && maskFps < MIN_MASK_FPS) return true
  if (fps >= MIN_BLUR_FPS) return false
  return busy >= BUSY_LIMIT || maskFps < fps / 2
}

/** Counts seconds over budget; true once it should turn off */
export class BlurFpsWatch {
  #seen = 0
  #over = 0

  /** A new start or a new camera: warm up again */
  reset(): void {
    this.#seen = 0
    this.#over = 0
  }

  push(report: BlurReport): boolean {
    this.#seen += 1
    if (this.#seen <= BLUR_WARMUP_SECONDS) return false
    this.#over = blurOverBudget(report) ? this.#over + 1 : 0
    return this.#over >= BLUR_OVER_SECONDS
  }
}

/**
 * What the room sends for the camera, and what our own tile shows of it.
 *
 * - No camera: nothing.
 * - Blur not wanted: the camera. Turned off, or turned off by itself: the original track again.
 * - Blur ready: its track.
 * - Blur wanted and not ready: while the camera was already going out when it was turned on
 *   (`rawWhileLoading`) it keeps going, so nobody loses the picture while the model loads. A camera
 *   that comes on with the blur already wanted (joining with it remembered, the camera button)
 *   sends nothing until it is ready: someone who chose to hide their room does not show it for
 *   the seconds the model takes.
 */
export function cameraToSend({
  camera,
  blurWanted,
  blurTrack,
  rawWhileLoading,
}: {
  camera: MediaStreamTrack | null
  blurWanted: boolean
  blurTrack: MediaStreamTrack | null
  rawWhileLoading: boolean
}): MediaStreamTrack | null {
  if (!camera) return null
  if (!blurWanted) return camera
  return blurTrack ?? (rawWhileLoading ? camera : null)
}
