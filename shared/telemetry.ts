// Minimal telemetry (D3, e11-t03): what a browser may report to POST /api/events, and how the
// Worker checks it. Self-hosted, no third-party account (owner decision, E11's open question):
// the Worker counts the events in TelemetryDO (what /admin shows) and, when the binding exists,
// writes each one to Workers Analytics Engine (for ad-hoc queries, DEPLOY.md §8).
//
// Privacy: an event says what happened, never who or what was said: no names, no room ids, no
// chat text, no IP addresses (the Worker uses the IP for the rate limit in memory only). A
// client error's message is cut short and scrubbed of URLs, e-mail addresses and long numbers.
//
// Adding a kind: add it to ClientEvent and to parseEvent; a Worker that does not know a kind yet
// drops just that event, so browsers may be deployed first. D4 added `rating` (e4-t18): the
// after-leave screen's one question, a score and nothing else (no comment, no room, no member).
import type { AbuseSummary } from './abuse.ts'
import type { FilesStatus } from './files.ts'
import type { UsageStatus } from './usage.ts'

/** At most this many events per request */
export const MAX_EVENTS_PER_BATCH = 20
/** Request bodies larger than this (bytes) are refused unread */
export const MAX_EVENTS_BODY_BYTES = 8_192
/** A client error's name and message, after scrubbing, are cut to these lengths */
export const MAX_ERROR_NAME_CHARS = 40
export const MAX_ERROR_MESSAGE_CHARS = 160
export const MAX_ERROR_SOURCE_CHARS = 80

export const EVENTS_PATH = '/api/events'

/** Why joining a room failed, as the browser saw it (RoomConnection's final statuses) */
export type JoinFailure = 'notFound' | 'full' | 'outdated' | 'lost' | 'replaced'
export const JOIN_FAILURES: readonly JoinFailure[] = [
  'notFound',
  'full',
  'outdated',
  'lost',
  'replaced',
]

/** Which connection dropped: the room's WebSocket or the media session */
export type ConnectionLayer = 'socket' | 'media'
export const CONNECTION_LAYERS: readonly ConnectionLayer[] = ['socket', 'media']

/** The after-leave question's scale (e4-t18, E4: 「一題評分（1–5）」); 5 is best */
export const RATING_SCORES = [1, 2, 3, 4, 5] as const
export type RatingScore = (typeof RATING_SCORES)[number]

export const isRatingScore = (value: unknown): value is RatingScore =>
  typeof value === 'number' && (RATING_SCORES as readonly number[]).includes(value)

/**
 * - `join`: the room welcomed us (`ok`) or refused / could not be reached before it did
 * - `reconnect`: a connection that was up dropped and the browser started reconnecting
 * - `rebuild`: the media session was thrown away and built anew (RoomMedia)
 * - `media`: the media session has been up for a while; `relay`: it goes through TURN
 * - `error`: an uncaught error or unhandled rejection in the page (sampled, rate-limited)
 * - `rating`: the score given on the after-leave screen (e4-t18), at most once per leave
 */
export type ClientEvent =
  | { type: 'join'; ok: true }
  | { type: 'join'; ok: false; reason: JoinFailure }
  | { type: 'reconnect'; layer: ConnectionLayer }
  | { type: 'rebuild' }
  | { type: 'media'; relay: boolean }
  | { type: 'error'; kind: 'error' | 'rejection'; name: string; message: string; source: string }
  | { type: 'rating'; score: RatingScore }

export type ClientEventType = ClientEvent['type']

export type EventBatch = { events: ClientEvent[] }

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)

const clip = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? [...value].slice(0, max).join('') : null

/**
 * Removes what could identify someone from an error's text: URLs (they may carry a room id),
 * e-mail addresses, runs of 6+ digits; control characters go too. Cut to `max` characters.
 */
export function scrubErrorText(text: string, max: number = MAX_ERROR_MESSAGE_CHARS): string {
  const scrubbed = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>')
    .replace(/[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}/gi, '<email>')
    // A room password from a link (F3), should one ever end up in an error's text
    .replace(/\bpwd=[^\s&'"]*/gi, 'pwd=<password>')
    .replace(/\d{6,}/g, '<n>')
    .replace(/\/r\/[1-9A-HJ-NP-Za-km-z]{10}\b/g, '/r/<room>')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
  return [...scrubbed].slice(0, max).join('')
}

/** One event as the Worker accepts it, or null (unknown kind, or not well formed) */
export function parseEvent(value: unknown): ClientEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  switch (event.type) {
    case 'join':
      if (event.ok === true) return { type: 'join', ok: true }
      return event.ok === false && isOneOf(JOIN_FAILURES, event.reason)
        ? { type: 'join', ok: false, reason: event.reason }
        : null
    case 'reconnect':
      return isOneOf(CONNECTION_LAYERS, event.layer)
        ? { type: 'reconnect', layer: event.layer }
        : null
    case 'rebuild':
      return { type: 'rebuild' }
    case 'media':
      return typeof event.relay === 'boolean' ? { type: 'media', relay: event.relay } : null
    case 'error': {
      if (event.kind !== 'error' && event.kind !== 'rejection') return null
      const name = clip(event.name, MAX_ERROR_NAME_CHARS)
      const message = clip(event.message, 4 * MAX_ERROR_MESSAGE_CHARS)
      const source = clip(event.source, 4 * MAX_ERROR_SOURCE_CHARS)
      if (name === null || message === null || source === null) return null
      // Scrubbed again on the server: the browser is not trusted to have done it
      return {
        type: 'error',
        kind: event.kind,
        name: scrubErrorText(name, MAX_ERROR_NAME_CHARS),
        message: scrubErrorText(message),
        source: scrubErrorText(source, MAX_ERROR_SOURCE_CHARS),
      }
    }
    case 'rating':
      return isRatingScore(event.score) ? { type: 'rating', score: event.score } : null
    default:
      return null
  }
}

/**
 * A request body's events: a JSON object `{ events: [...] }` with 1–MAX_EVENTS_PER_BATCH items.
 * Items the Worker does not understand are dropped one by one; null when the body is not a batch
 * at all or nothing in it is understood.
 */
export function parseEventBatch(raw: string): ClientEvent[] | null {
  if (raw.length > MAX_EVENTS_BODY_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const items = (value as Record<string, unknown>).events
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_EVENTS_PER_BATCH) {
    return null
  }
  const events = items.map(parseEvent).filter((event): event is ClientEvent => event !== null)
  return events.length > 0 ? events : null
}

// ── What /admin reads ────────────────────────────────────────────────────────────────────────

/** Counters for one period (an hour or a day, UTC) */
export type EventCounts = {
  joinOk: number
  /** Failed joins by reason */
  joinFail: Partial<Record<JoinFailure, number>>
  reconnect: Partial<Record<ConnectionLayer, number>>
  rebuild: number
  /** Media sessions reported, and how many of them went through TURN */
  media: number
  relayed: number
  errors: number
  /**
   * After-leave ratings by score (e4-t18). Optional: counters stored before D4 do not have it,
   * read them with `ratingsOf`
   */
  ratings?: Partial<Record<RatingScore, number>>
}

/** A period's ratings by score, 0 where none (also for counters stored before D4) */
export function ratingsOf(counts: EventCounts): Record<RatingScore, number> {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const score of RATING_SCORES) out[score] = counts.ratings?.[score] ?? 0
  return out
}

/** How many ratings, and their average (null when there are none) */
export function ratingStats(counts: EventCounts): { count: number; average: number | null } {
  const byScore = ratingsOf(counts)
  let count = 0
  let total = 0
  for (const score of RATING_SCORES) {
    count += byScore[score]
    total += score * byScore[score]
  }
  return { count, average: count === 0 ? null : total / count }
}

/** A client error as /admin lists it (already scrubbed) */
export type ErrorSample = {
  at: number
  kind: 'error' | 'rejection'
  name: string
  message: string
  source: string
  /** How many times this same error was reported since it was first kept */
  count: number
}

/**
 * - `errors`: at least ERROR_ALERT_PER_HOUR client errors in this UTC hour and the previous one
 * - `joinFailures`: in the last 24 hours at least JOIN_ALERT_MIN joins were tried and at least
 *   JOIN_ALERT_FAIL_RATIO of them failed
 */
export type AlertCode = 'errors' | 'joinFailures'

export const ERROR_ALERT_PER_HOUR = 20
export const JOIN_ALERT_MIN = 10
export const JOIN_ALERT_FAIL_RATIO = 0.2

export type TelemetrySummary = {
  now: number
  /** The last 24 hours and the last 7 days, summed */
  last24h: EventCounts
  last7d: EventCounts
  /** One entry per UTC day that saw events, newest first (up to TELEMETRY_DAYS) */
  days: ({ day: string } & EventCounts)[]
  /** The latest distinct client errors, newest first */
  recentErrors: ErrorSample[]
  alerts: AlertCode[]
}

/** GET /api/admin/summary (owner only, ADMIN_TOKEN) */
export type AdminSummary = {
  telemetry: TelemetrySummary
  /** The month's Realtime egress guard (shared/usage.ts), for the same page */
  usage: UsageStatus | null
  /** Whether events also go to Workers Analytics Engine (the EVENTS binding) */
  analyticsEngine: boolean
  /** The blocklist and recent offenders (I1, e11-t05); null when the guard could not be read */
  abuse: AbuseSummary | null
  /** What the upload bucket holds, the last sweep and backup (I5); null when unreadable */
  files: FilesStatus | null
}

export const ADMIN_SUMMARY_PATH = '/api/admin/summary'

export const emptyCounts = (): EventCounts => ({
  joinOk: 0,
  joinFail: {},
  reconnect: {},
  rebuild: 0,
  media: 0,
  relayed: 0,
  errors: 0,
  ratings: {},
})
