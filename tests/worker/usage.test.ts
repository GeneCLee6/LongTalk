import { describe, expect, it } from 'vitest'
import { GB } from '../../shared/usage.ts'
import {
  MAX_FLUSH_BYTES,
  UsageLedger,
  monthOf,
  thresholdsFromEnv,
  usageState,
} from '../../worker/usage.ts'

const OCT = Date.UTC(2026, 9, 31, 12)
const defaults = thresholdsFromEnv({})

describe('usage thresholds', () => {
  it('defaults to 800 GB for low quality and 950 GB for audio only', () => {
    expect(defaults).toEqual({ lowQualityBytes: 800 * GB, audioOnlyBytes: 950 * GB })
  })

  it('reads the vars, ignoring values that are not positive numbers', () => {
    expect(thresholdsFromEnv({ USAGE_LOW_QUALITY_GB: '1', USAGE_AUDIO_ONLY_GB: '2.5' })).toEqual({
      lowQualityBytes: GB,
      audioOnlyBytes: 2.5 * GB,
    })
    for (const bad of ['', 'lots', '-5', '0']) {
      expect(thresholdsFromEnv({ USAGE_LOW_QUALITY_GB: bad, USAGE_AUDIO_ONLY_GB: bad })).toEqual(
        defaults,
      )
    }
    // Audio-only never comes before low quality
    expect(thresholdsFromEnv({ USAGE_LOW_QUALITY_GB: '900', USAGE_AUDIO_ONLY_GB: '100' })).toEqual({
      lowQualityBytes: 900 * GB,
      audioOnlyBytes: 900 * GB,
    })
  })

  it('maps bytes to a state at each threshold', () => {
    expect(usageState(0, defaults)).toBe('normal')
    expect(usageState(800 * GB - 1, defaults)).toBe('normal')
    expect(usageState(800 * GB, defaults)).toBe('low')
    expect(usageState(950 * GB - 1, defaults)).toBe('low')
    expect(usageState(950 * GB, defaults)).toBe('audioOnly')
    expect(usageState(2000 * GB, defaults)).toBe('audioOnly')
  })
})

describe('UsageLedger', () => {
  it('names months in UTC', () => {
    expect(monthOf(OCT)).toBe('2026-10')
    // The month turns at 00:00 UTC (08:00 in Taiwan)
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 59, 59))).toBe('2026-10')
    expect(monthOf(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe('2026-11')
  })

  it('adds the larger of the reported bytes and the estimate, flush by flush', () => {
    const ledger = new UsageLedger(null, OCT)
    expect(ledger.add({ clientBytes: 300, estimateBytes: 100 }, OCT)).toBe(true)
    expect(ledger.add({ clientBytes: 50, estimateBytes: 400 }, OCT)).toBe(true)
    expect(ledger.record).toEqual({
      month: '2026-10',
      bytes: 700,
      clientBytes: 350,
      estimateBytes: 500,
    })
    expect(ledger.status(OCT, defaults)).toEqual({ month: '2026-10', bytes: 700, state: 'normal' })
  })

  it('stores nothing for an empty flush, and ignores nonsense', () => {
    const ledger = new UsageLedger(null, OCT)
    expect(ledger.add({ clientBytes: 0, estimateBytes: 0 }, OCT)).toBe(false)
    expect(ledger.add({ clientBytes: -5, estimateBytes: Number.NaN }, OCT)).toBe(false)
    expect(ledger.add({ clientBytes: Number.POSITIVE_INFINITY, estimateBytes: 0 }, OCT)).toBe(false)
    expect(ledger.record.bytes).toBe(0)
  })

  it('caps one flush, so one bad number cannot end the month', () => {
    const ledger = new UsageLedger(null, OCT)
    ledger.add({ clientBytes: 900 * GB, estimateBytes: 0 }, OCT)
    expect(ledger.record.bytes).toBe(MAX_FLUSH_BYTES)
  })

  it('crosses into low quality, then audio only, as the month fills', () => {
    const ledger = new UsageLedger(
      { month: '2026-10', bytes: 799 * GB, clientBytes: 0, estimateBytes: 799 * GB },
      OCT,
    )
    expect(ledger.status(OCT, defaults).state).toBe('normal')
    ledger.add({ clientBytes: 0, estimateBytes: GB }, OCT)
    expect(ledger.status(OCT, defaults).state).toBe('low')
    for (let i = 0; i < 3; i++) ledger.add({ clientBytes: 0, estimateBytes: MAX_FLUSH_BYTES }, OCT)
    expect(ledger.status(OCT, defaults)).toEqual({
      month: '2026-10',
      bytes: 950 * GB,
      state: 'audioOnly',
    })
  })

  it('starts again from zero on the first of the month (UTC)', () => {
    const stored = { month: '2026-10', bytes: 960 * GB, clientBytes: 0, estimateBytes: 960 * GB }
    const ledger = new UsageLedger(stored, OCT)
    expect(ledger.status(OCT, defaults).state).toBe('audioOnly')
    const nov = Date.UTC(2026, 10, 1, 0, 0, 1)
    expect(ledger.status(nov, defaults)).toEqual({ month: '2026-11', bytes: 0, state: 'normal' })
    // A new month is stored even when the flush itself is empty
    const fresh = new UsageLedger(stored, OCT)
    expect(fresh.add({ clientBytes: 0, estimateBytes: 0 }, nov)).toBe(true)
    expect(fresh.record).toEqual({ month: '2026-11', bytes: 0, clientBytes: 0, estimateBytes: 0 })
  })

  it('drops a record from an earlier month when it loads', () => {
    const ledger = new UsageLedger(
      { month: '2026-09', bytes: 999 * GB, clientBytes: 0, estimateBytes: 0 },
      OCT,
    )
    expect(ledger.record).toEqual({ month: '2026-10', bytes: 0, clientBytes: 0, estimateBytes: 0 })
  })
})
