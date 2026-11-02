// Reconnect pacing (e2-t08), shared by the room socket (RoomConnection) and the media session
// (RoomMedia): exponential backoff 1, 2, 4, 8 s (then 8 s) with jitter, so a room full of
// browsers that lost the network together does not come back in lockstep, and a bound after
// which the caller gives up and asks the person instead of trying forever.

export interface BackoffOptions {
  /** First delay, ms */
  baseMs?: number
  /** Largest delay, ms */
  maxMs?: number
  /** Each delay is scaled by a random factor in [1 − jitter, 1 + jitter] */
  jitter?: number
  /** Give up once this long has passed since the first failure, ms */
  giveUpAfterMs?: number
  random?: () => number
  now?: () => number
}

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 8_000
export const RECONNECT_JITTER = 0.25

export class Backoff {
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly jitter: number
  private readonly giveUpAfterMs: number
  private readonly random: () => number
  private readonly now: () => number
  private attempt = 0
  private since: number | null = null

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? RECONNECT_BASE_MS
    this.maxMs = options.maxMs ?? RECONNECT_MAX_MS
    this.jitter = options.jitter ?? RECONNECT_JITTER
    this.giveUpAfterMs = options.giveUpAfterMs ?? Number.POSITIVE_INFINITY
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
  }

  /** The wait before the next attempt, or null when it is time to give up */
  next(): number | null {
    const now = this.now()
    this.since ??= now
    if (now - this.since >= this.giveUpAfterMs) return null
    const delay = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs)
    this.attempt += 1
    const factor = 1 + this.jitter * (this.random() * 2 - 1)
    return Math.round(delay * factor)
  }

  /** Attempts so far since the last reset */
  get attempts(): number {
    return this.attempt
  }

  /** Back to the first delay (an attempt succeeded, or the network came back) */
  reset(): void {
    this.attempt = 0
    this.since = null
  }

  /** The next delay starts from the first again, but the give-up clock keeps running */
  restart(): void {
    this.attempt = 0
  }
}
