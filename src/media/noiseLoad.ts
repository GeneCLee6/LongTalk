// When the advanced noise suppression is too much for this computer (e6-t02, AC-6.2: CPU 超過門檻
// 自動關並提示). The worklet reports every second how long RNNoise took (rnnoiseCore.ts
// LoadMeter); a second is over budget when the frames took more than LOAD_LIMIT of the audio
// they hold, or one frame took more than SPIKE_MS (most of a 2.7 ms render quantum: the audio
// thread is about to miss its deadline, which is heard as crackling). OVERLOAD_SECONDS over
// budget in a row turn it off; one good second starts the count again, so a single busy moment
// (another tab loading) does not.
//
// Measured (ADR-001 「進階噪音抑制」): about 1–3 % of real time on a recent laptop, so the limit
// leaves a slow machine plenty of room before it gives up.

/** The share of real time RNNoise may take, averaged over a second */
export const LOAD_LIMIT = 0.35
/** The slowest a single frame may be, ms */
export const SPIKE_MS = 2.4
/** Seconds over budget in a row before the suppression is turned off */
export const OVERLOAD_SECONDS = 5

export interface LoadReport {
  /** Processing time over audio time, 0..1 (more than 1: it cannot keep up at all) */
  load: number
  /** The slowest frame in the second, ms */
  maxMs: number
}

export const overBudget = (report: LoadReport): boolean =>
  report.load > LOAD_LIMIT || report.maxMs > SPIKE_MS

/** Counts seconds over budget; `push` says when it is time to turn the suppression off */
export class OverloadWatch {
  private over = 0

  push(report: LoadReport): boolean {
    this.over = overBudget(report) ? this.over + 1 : 0
    return this.over >= OVERLOAD_SECONDS
  }

  reset(): void {
    this.over = 0
  }
}
