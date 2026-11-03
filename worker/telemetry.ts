import {
  ERROR_ALERT_PER_HOUR,
  JOIN_ALERT_FAIL_RATIO,
  JOIN_ALERT_MIN,
  emptyCounts,
  type AlertCode,
  type ClientEvent,
  type ErrorSample,
  type EventCounts,
  type RatingScore,
  type TelemetrySummary,
} from '../shared/telemetry.ts'

// The counters behind /admin (e11-t03, shared/telemetry.ts says what is counted and why). Pure,
// so Vitest runs it directly; TelemetryDO (telemetry-do.ts) stores the record and holds the rate
// limit.

/** Daily counters are kept this long (the retention table's 90 days for telemetry) */
export const TELEMETRY_DAYS = 90
/** Hourly counters are kept this long (enough for the last 24 hours and the error alert) */
export const TELEMETRY_HOURS = 48
/** Distinct client errors kept for /admin */
export const MAX_ERROR_SAMPLES = 20

/** What TelemetryDO stores */
export type TelemetryRecord = {
  /** By UTC hour, `YYYY-MM-DDTHH` */
  hours: Record<string, EventCounts>
  /** By UTC day, `YYYY-MM-DD` */
  days: Record<string, EventCounts>
  /** Newest first */
  errors: ErrorSample[]
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export const hourKey = (ms: number): string => new Date(ms).toISOString().slice(0, 13)
export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function count(into: EventCounts, event: ClientEvent): void {
  switch (event.type) {
    case 'join':
      if (event.ok) into.joinOk++
      else into.joinFail[event.reason] = (into.joinFail[event.reason] ?? 0) + 1
      return
    case 'reconnect':
      into.reconnect[event.layer] = (into.reconnect[event.layer] ?? 0) + 1
      return
    case 'rebuild':
      into.rebuild++
      return
    case 'media':
      into.media++
      if (event.relay) into.relayed++
      return
    case 'error':
      into.errors++
      return
    case 'rating': {
      const ratings = (into.ratings ??= {})
      ratings[event.score] = (ratings[event.score] ?? 0) + 1
      return
    }
  }
}

function addCounts(into: EventCounts, from: EventCounts): void {
  into.joinOk += from.joinOk
  into.rebuild += from.rebuild
  into.media += from.media
  into.relayed += from.relayed
  into.errors += from.errors
  for (const [reason, n] of Object.entries(from.joinFail) as [
    keyof EventCounts['joinFail'],
    number,
  ][]) {
    into.joinFail[reason] = (into.joinFail[reason] ?? 0) + n
  }
  for (const [layer, n] of Object.entries(from.reconnect) as [
    keyof EventCounts['reconnect'],
    number,
  ][]) {
    into.reconnect[layer] = (into.reconnect[layer] ?? 0) + n
  }
  // Counters stored before D4 have no ratings
  for (const [score, n] of Object.entries(from.ratings ?? {})) {
    const key = Number(score) as RatingScore
    const ratings = (into.ratings ??= {})
    ratings[key] = (ratings[key] ?? 0) + (n ?? 0)
  }
}

const sum = (list: EventCounts[]): EventCounts => {
  const total = emptyCounts()
  for (const counts of list) addCounts(total, counts)
  return total
}

const failedJoins = (counts: EventCounts): number =>
  Object.values(counts.joinFail).reduce((total, n) => total + (n ?? 0), 0)

/** The deployment's event counters: hourly for TELEMETRY_HOURS, daily for TELEMETRY_DAYS */
export class TelemetryLedger {
  private data: TelemetryRecord

  constructor(record: TelemetryRecord | null) {
    this.data = record
      ? { hours: { ...record.hours }, days: { ...record.days }, errors: [...record.errors] }
      : { hours: {}, days: {}, errors: [] }
  }

  get record(): TelemetryRecord {
    return this.data
  }

  /** Counts `events` at `now`, keeps one sample per distinct client error, drops old periods */
  add(events: readonly ClientEvent[], now: number): void {
    const hour = (this.data.hours[hourKey(now)] ??= emptyCounts())
    const day = (this.data.days[dayKey(now)] ??= emptyCounts())
    for (const event of events) {
      count(hour, event)
      count(day, event)
      if (event.type === 'error') this.keepError(event, now)
    }
    this.prune(now)
  }

  summary(now: number): TelemetrySummary {
    this.prune(now)
    const since24h = hourKey(now - 23 * HOUR_MS)
    const since7d = dayKey(now - 6 * DAY_MS)
    const hours = Object.entries(this.data.hours)
    const days = Object.entries(this.data.days).sort(([a], [b]) => (a < b ? 1 : -1))
    const last24h = sum(hours.filter(([key]) => key >= since24h).map(([, counts]) => counts))
    const last7d = sum(days.filter(([key]) => key >= since7d).map(([, counts]) => counts))
    return {
      now,
      last24h,
      last7d,
      days: days.map(([day, counts]) => ({ day, ...counts })),
      recentErrors: this.data.errors,
      alerts: this.alerts(now, last24h),
    }
  }

  /**
   * The simplest free alert (no e-mail, no webhook): flags /admin shows in red. `errors`: at
   * least ERROR_ALERT_PER_HOUR client errors in this UTC hour and the previous one together;
   * `joinFailures`: at least JOIN_ALERT_FAIL_RATIO of at least JOIN_ALERT_MIN joins in 24 hours.
   */
  private alerts(now: number, last24h: EventCounts): AlertCode[] {
    const alerts: AlertCode[] = []
    const recentErrors =
      (this.data.hours[hourKey(now)]?.errors ?? 0) +
      (this.data.hours[hourKey(now - HOUR_MS)]?.errors ?? 0)
    if (recentErrors >= ERROR_ALERT_PER_HOUR) alerts.push('errors')
    const failed = failedJoins(last24h)
    const tried = failed + last24h.joinOk
    if (tried >= JOIN_ALERT_MIN && failed / tried >= JOIN_ALERT_FAIL_RATIO) {
      alerts.push('joinFailures')
    }
    return alerts
  }

  private keepError(event: Extract<ClientEvent, { type: 'error' }>, now: number): void {
    const same = this.data.errors.findIndex(
      (sample) =>
        sample.kind === event.kind &&
        sample.name === event.name &&
        sample.message === event.message &&
        sample.source === event.source,
    )
    const previous = same >= 0 ? this.data.errors.splice(same, 1)[0] : null
    const { kind, name, message, source } = event
    this.data.errors.unshift({
      at: now,
      kind,
      name,
      message,
      source,
      count: (previous?.count ?? 0) + 1,
    })
    this.data.errors.length = Math.min(this.data.errors.length, MAX_ERROR_SAMPLES)
  }

  private prune(now: number): void {
    const oldestHour = hourKey(now - (TELEMETRY_HOURS - 1) * HOUR_MS)
    for (const key of Object.keys(this.data.hours)) {
      if (key < oldestHour) delete this.data.hours[key]
    }
    const oldestDay = dayKey(now - (TELEMETRY_DAYS - 1) * DAY_MS)
    for (const key of Object.keys(this.data.days)) {
      if (key < oldestDay) delete this.data.days[key]
    }
  }
}

/** Per client (a hash of its IP), per window: what POST /api/events accepts */
export const EVENT_RATE = { events: 60, errors: 10, ratings: 3, windowMs: 10 * 60_000 } as const
/** Clients tracked at once; beyond this the expired ones go, then everyone (memory, not safety) */
const MAX_TRACKED_CLIENTS = 10_000

type Window = { start: number; events: number; errors: number; ratings: number }

/**
 * Fixed-window rate limit per client: at most EVENT_RATE.events events (of which
 * EVENT_RATE.errors client errors and EVENT_RATE.ratings ratings) per EVENT_RATE.windowMs. In
 * memory only: an eviction forgets it, which at worst lets one window through twice.
 */
export class EventRateLimit {
  private readonly windows = new Map<string, Window>()

  /** The events `client` may still send now, in order; the rest are dropped */
  take(client: string, events: readonly ClientEvent[], now: number): ClientEvent[] {
    let window = this.windows.get(client)
    if (!window || now - window.start >= EVENT_RATE.windowMs) {
      if (!window && this.windows.size >= MAX_TRACKED_CLIENTS) this.prune(now)
      window = { start: now, events: 0, errors: 0, ratings: 0 }
      this.windows.set(client, window)
    }
    const accepted: ClientEvent[] = []
    for (const event of events) {
      if (window.events >= EVENT_RATE.events) break
      if (event.type === 'error') {
        if (window.errors >= EVENT_RATE.errors) continue
        window.errors++
      }
      // One person leaving a few rooms is fine; one IP stuffing the average is not
      if (event.type === 'rating') {
        if (window.ratings >= EVENT_RATE.ratings) continue
        window.ratings++
      }
      window.events++
      accepted.push(event)
    }
    return accepted
  }

  private prune(now: number): void {
    for (const [client, window] of this.windows) {
      if (now - window.start >= EVENT_RATE.windowMs) this.windows.delete(client)
    }
    if (this.windows.size >= MAX_TRACKED_CLIENTS) this.windows.clear()
  }
}

/** The part of Durable Object storage TelemetryStore needs (a Map-backed fake in tests) */
export interface TelemetryStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

/** The storage key of the one TelemetryRecord */
export const TELEMETRY_RECORD_KEY = 'telemetry'

/**
 * TelemetryDO's state without the runtime: the ledger, the rate limit and when they reach
 * storage. Writes through: every batch that counted something is stored before `record`
 * answers. (Before the 2026-11-03 field test fix it saved from an alarm 30 s later; an object
 * with no WebSockets and no timers may leave memory after about 10 s idle, and the alarm then
 * woke a fresh instance that stored the old record again, so a quiet deployment's last events,
 * such as the ratings given on leaving, never reached /admin.)
 */
export class TelemetryStore {
  private readonly limit = new EventRateLimit()
  private readonly storage: TelemetryStorage
  private readonly ledger: TelemetryLedger

  private constructor(storage: TelemetryStorage, ledger: TelemetryLedger) {
    this.storage = storage
    this.ledger = ledger
  }

  static async load(storage: TelemetryStorage): Promise<TelemetryStore> {
    const stored = await storage.get<TelemetryRecord>(TELEMETRY_RECORD_KEY)
    return new TelemetryStore(storage, new TelemetryLedger(stored ?? null))
  }

  /** Counts what `client` may send now, stores it, and answers what was accepted */
  async record(
    client: string,
    events: readonly ClientEvent[],
    now: number,
  ): Promise<ClientEvent[]> {
    const accepted = this.limit.take(client, events, now)
    if (accepted.length === 0) return accepted
    this.ledger.add(accepted, now)
    await this.storage.put(TELEMETRY_RECORD_KEY, this.ledger.record)
    return accepted
  }

  summary(now: number): TelemetrySummary {
    return this.ledger.summary(now)
  }
}
