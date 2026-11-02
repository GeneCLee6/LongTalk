import {
  DEFAULT_AUDIO_ONLY_GB,
  DEFAULT_LOW_QUALITY_GB,
  GB,
  type UsageState,
  type UsageStatus,
} from '../shared/usage.ts'
import type { UsageDelta } from './room-host.ts'

// The month's Realtime egress count (e11-t13, shared/usage.ts explains the method). Pure, so
// Vitest runs it directly; UsageDO (usage-do.ts) only stores the record.

export interface UsageEnv {
  /** GB this month after which cameras send low quality; default 800 */
  USAGE_LOW_QUALITY_GB?: string
  /** GB this month after which new video tracks are refused; default 950 */
  USAGE_AUDIO_ONLY_GB?: string
}

export type UsageThresholds = { lowQualityBytes: number; audioOnlyBytes: number }

/** What UsageDO stores: one month's count */
export type UsageRecord = {
  month: string
  /** The count: the sum, flush by flush, of the larger of the two numbers */
  bytes: number
  /** What the browsers reported, summed (for comparison) */
  clientBytes: number
  /** The server estimate, summed (for comparison) */
  estimateBytes: number
}

/** One flush may add at most this much: a bug or a forged number must not end the month alone */
export const MAX_FLUSH_BYTES = 50 * GB

/** The UTC calendar month of a time, `YYYY-MM` */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

function gigabytes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The thresholds from the vars (wrangler.jsonc), in bytes. A missing or invalid value falls back
 * to its default; an audio-only threshold below the low-quality one is raised to it.
 */
export function thresholdsFromEnv(env: UsageEnv): UsageThresholds {
  const low = gigabytes(env.USAGE_LOW_QUALITY_GB, DEFAULT_LOW_QUALITY_GB)
  const audioOnly = Math.max(gigabytes(env.USAGE_AUDIO_ONLY_GB, DEFAULT_AUDIO_ONLY_GB), low)
  return { lowQualityBytes: Math.round(low * GB), audioOnlyBytes: Math.round(audioOnly * GB) }
}

export function usageState(bytes: number, thresholds: UsageThresholds): UsageState {
  if (bytes >= thresholds.audioOnlyBytes) return 'audioOnly'
  if (bytes >= thresholds.lowQualityBytes) return 'low'
  return 'normal'
}

const emptyRecord = (month: string): UsageRecord => ({
  month,
  bytes: 0,
  clientBytes: 0,
  estimateBytes: 0,
})

const clampBytes = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), MAX_FLUSH_BYTES) : 0

/** This month's count; a record from an earlier month starts again from zero (the monthly reset) */
export class UsageLedger {
  private current: UsageRecord

  constructor(stored: UsageRecord | null, now: number) {
    this.current = stored ?? emptyRecord(monthOf(now))
    this.roll(now)
  }

  /** The stored record, after any reset */
  get record(): UsageRecord {
    return this.current
  }

  /**
   * Adds a room's flush: the larger of what its browsers reported and the server estimate.
   * Returns whether anything changed (whether to store the record).
   */
  add(delta: UsageDelta, now: number): boolean {
    const rolled = this.roll(now)
    const client = clampBytes(delta.clientBytes)
    const estimate = clampBytes(delta.estimateBytes)
    if (client === 0 && estimate === 0) return rolled
    this.current = {
      month: this.current.month,
      bytes: this.current.bytes + Math.max(client, estimate),
      clientBytes: this.current.clientBytes + client,
      estimateBytes: this.current.estimateBytes + estimate,
    }
    return true
  }

  status(now: number, thresholds: UsageThresholds): UsageStatus {
    this.roll(now)
    const { month, bytes } = this.current
    return { month, bytes, state: usageState(bytes, thresholds) }
  }

  /** Starts a new month when the calendar moved on; true when it did */
  private roll(now: number): boolean {
    const month = monthOf(now)
    if (this.current.month === month) return false
    this.current = emptyRecord(month)
    return true
  }
}

/** The one UsageDO (`idFromName(USAGE_OBJECT)`): the whole account shares one allowance */
export const USAGE_OBJECT = 'global'
