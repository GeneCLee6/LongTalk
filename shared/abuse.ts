// Abuse protection (I1, e11-t05): the limits the Worker and the rooms enforce, the IP blocklist
// as /admin sees it, and the answers the browser gets. Every client is a keyed hash of its network
// (worker/client-key.ts), never the address itself.

/** A sliding window: at most `count` in any `windowMs` */
export type RateWindow = { count: number; windowMs: number }

/**
 * Rooms one network may create (POST /api/rooms), in every one of these windows: a few meetings
 * in a row are fine, a script is not. Counted in GuardDO, so the limit holds worldwide.
 */
export const ROOM_CREATE_LIMITS: readonly RateWindow[] = [
  { count: 10, windowMs: 10 * 60_000 },
  { count: 60, windowMs: 24 * 60 * 60_000 },
]

/**
 * Accounts one network may make (I2, POST /api/account/register/options): a family or an office
 * signing up together is fine, a script is not. Counted in GuardDO like rooms.
 */
export const ACCOUNT_CREATE_LIMITS: readonly RateWindow[] = [
  { count: 5, windowMs: 60 * 60_000 },
  { count: 20, windowMs: 24 * 60 * 60_000 },
]

/** Sign-in attempts one network may start (I2, POST /api/account/login/options) */
export const SIGNIN_LIMITS: readonly RateWindow[] = [
  { count: 30, windowMs: 10 * 60_000 },
  { count: 300, windowMs: 24 * 60 * 60_000 },
]

/**
 * What GuardDO counts per network (GuardStore.limit): rooms made (`create`, random rooms and
 * persistent ones alike), accounts made, sign-ins started
 */
export type LimitKind = 'create' | 'register' | 'signin'
export const LIMITS: Readonly<Record<LimitKind, readonly RateWindow[]>> = {
  create: ROOM_CREATE_LIMITS,
  register: ACCOUNT_CREATE_LIMITS,
  signin: SIGNIN_LIMITS,
}

/**
 * WebSocket upgrades one network may make into one room (RoomDO): a whole office joining at
 * once and reconnecting stays under it; a reconnect loop or a socket flood does not
 */
export const ROOM_CONNECT_RATE: RateWindow = { count: 60, windowMs: 60_000 }

/**
 * Frames one connection may send (RoomDO), every message type together. A busy member sends a
 * few a second at most (stats, signal, tracks, chat CHAT_RATE, reactions REACTION_RATE); the
 * per-type limits stay as they are. Over it the socket is closed with CloseCode.rateLimited.
 */
export const SOCKET_MESSAGE_RATE: RateWindow = { count: 120, windowMs: 10_000 }

/**
 * Requests one network may make to /api/rooms/* per Worker isolate (pre-join lookups and socket
 * upgrades): a cheap first line in memory, best effort (each isolate counts on its own)
 */
export const ISOLATE_ROOM_RATE: RateWindow = { count: 60, windowMs: 10_000 }

/** How long a block can last, in hours (the /admin choices) */
export const BLOCK_HOURS = [1, 24, 24 * 7, 24 * 30] as const
export type BlockHours = (typeof BLOCK_HOURS)[number]

/** The most blocks kept at once (the one ending soonest goes first) */
export const MAX_BLOCKS = 500
/** The most recent offenders /admin lists */
export const MAX_OFFENDERS = 50
/** A block's note: what the owner wrote down about it */
export const MAX_BLOCK_NOTE_CHARS = 80

/** What a client did that counted against it */
export type OffenceKind = 'createLimit' | 'turnstile' | 'connectLimit' | 'flood' | 'accountLimit'
export const OFFENCE_KINDS: readonly OffenceKind[] = [
  'createLimit',
  'turnstile',
  'connectLimit',
  'flood',
  'accountLimit',
]

/** One blocked network: its key (a hash), until when, and the owner's note */
export type BlockEntry = { key: string; at: number; until: number; note: string }

/** A client that recently hit a limit: how often, of which kind, and when last */
export type Offender = {
  key: string
  last: number
  counts: Partial<Record<OffenceKind, number>>
}

export type AbuseSummary = {
  blocks: BlockEntry[]
  offenders: Offender[]
  /** Whether POST /api/rooms asks for a Turnstile token (both keys are set) */
  turnstile: boolean
  /** Whether client keys use the IP_HASH_PEPPER secret */
  pepper: boolean
}

export const ADMIN_BLOCKS_PATH = '/api/admin/blocks'

/**
 * POST /api/admin/blocks: block either an address the owner types (the Worker hashes it, it is
 * never stored) or a key from the offenders list
 */
export type BlockRequest = { ip?: string; key?: string; hours: BlockHours; note?: string }

/** A client key as the Worker makes them: 24 hex digits */
export const isClientKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)

/** Loosely an IPv4 or IPv6 address (the Worker normalises it; anything else is refused) */
export const looksLikeIp = (value: string): boolean =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (/^[0-9a-fA-F:.]+$/.test(value) && value.includes(':'))

/** A request body to POST /api/admin/blocks, or null */
export function parseBlockRequest(raw: unknown): BlockRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (!(BLOCK_HOURS as readonly unknown[]).includes(body.hours)) return null
  const note =
    typeof body.note === 'string' ? body.note.trim().slice(0, MAX_BLOCK_NOTE_CHARS) : undefined
  if (typeof body.ip === 'string' && body.key === undefined) {
    const ip = body.ip.trim()
    return looksLikeIp(ip) ? { ip, hours: body.hours as BlockHours, note } : null
  }
  if (isClientKey(body.key) && body.ip === undefined) {
    return { key: body.key, hours: body.hours as BlockHours, note }
  }
  return null
}

/**
 * What POST /api/rooms answers when it refuses (the browser's text for each is in the
 * dictionaries): `turnstile_required` carries the site key to run the widget with;
 * `rate_limited` carries the seconds to wait
 */
export type CreateRoomRefusal =
  | { error: 'turnstile_required'; siteKey: string }
  | { error: 'turnstile_failed' }
  | { error: 'rate_limited'; retryAfter: number }
  | { error: 'blocked' }

/** The header POST /api/rooms reads the Turnstile token from */
export const TURNSTILE_HEADER = 'cf-turnstile-response'

/**
 * Sliding-window counter over `windows`: whether one more is allowed at `now` (and if so it is
 * counted), or how many milliseconds until it would be. `times` is oldest first and is trimmed
 * to the longest window.
 */
export function takeFromWindows(
  times: number[],
  windows: readonly RateWindow[],
  now: number,
): { ok: true; times: number[] } | { ok: false; times: number[]; retryAfterMs: number } {
  const longest = Math.max(...windows.map((w) => w.windowMs))
  const recent = times.filter((at) => now - at < longest)
  let wait = 0
  for (const { count, windowMs } of windows) {
    const inWindow = recent.filter((at) => now - at < windowMs)
    if (inWindow.length >= count) {
      // The oldest one that has to leave the window for one more to fit
      const leaving = inWindow[inWindow.length - count]
      wait = Math.max(wait, leaving + windowMs - now)
    }
  }
  if (wait > 0) return { ok: false, times: recent, retryAfterMs: wait }
  recent.push(now)
  return { ok: true, times: recent }
}
