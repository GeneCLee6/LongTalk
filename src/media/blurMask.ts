// From the model's confidence per pixel to the alpha mask the page draws with (e6-t06): smoothed
// over time, so the outline does not flicker from one mask to the next, and softened into a short
// ramp, so the edge of the person is not a hard line. Pure, for tests; the worker runs it.

/** Below this confidence a pixel is background, above MASK_HIGH it is the person */
export const MASK_LOW = 0.35
export const MASK_HIGH = 0.75
/** How much of the new mask goes into the smoothed one (the rest is the previous masks) */
export const MASK_BLEND = 0.7

/**
 * Writes `smoothed` (kept between masks, same length as `confidence`) and the mask's RGBA pixels:
 * only alpha matters, for `source-in` on the page. `first`: nothing to smooth with yet.
 */
export function writeMask(
  confidence: ArrayLike<number>,
  smoothed: Float32Array,
  rgba: Uint8ClampedArray,
  first: boolean,
): void {
  const range = MASK_HIGH - MASK_LOW
  for (let i = 0; i < confidence.length; i++) {
    const value = first
      ? confidence[i]
      : smoothed[i] + (confidence[i] - smoothed[i]) * MASK_BLEND
    smoothed[i] = value
    const alpha = (value - MASK_LOW) / range
    rgba[i * 4 + 3] = alpha <= 0 ? 0 : alpha >= 1 ? 255 : alpha * 255
  }
}
