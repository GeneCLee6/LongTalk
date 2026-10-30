// The messages between a browser and its room's Durable Object (RoomDO), over one WebSocket per
// member: GET /api/rooms/<roomId>/ws?v=<PROTOCOL_VERSION>. Shared by the Worker and the browser.
//
// 1. The browser opens the socket and sends `join` (its name, and the session token it was given
//    last time, if any). The server answers `welcome`: the member's id, the session token to keep
//    and the whole room (`state`). A token the room still knows (the member is connected, or
//    disconnected for less than RECONNECT_GRACE_MS) brings back the same member; any other token
//    makes a new member. A socket that does not join within JOIN_TIMEOUT_MS is closed.
// 2. Every change after that is a `patch` (shared/patch.ts) numbered `rev`, sent to everyone.
//    A browser that sees a gap in `rev` sends `resync` and gets a `snapshot`.
// 3. Heartbeat: the browser sends the text frame `ping` every HEARTBEAT_INTERVAL_MS and gets
//    `pong` (answered without waking the object); a socket silent for STALE_AFTER_MS is closed.
// 4. A socket that closes without `leave` (reload, network) leaves its member in the room marked
//    `reconnecting` for RECONNECT_GRACE_MS; `leave` removes the member at once.
//
// v1 → v2 (A4): `join`, `leave`, `welcome.token`, `Member.name` / `reconnecting`. A v1 browser is
// refused at the upgrade with CloseCode.versionMismatch and told to reload.
//
// View types are `type` aliases, not interfaces, so they stay assignable to JsonValue.
import type { JsonValue, PatchOp } from './patch.ts'

/** Bumped on any change a browser of the previous version could not understand */
export const PROTOCOL_VERSION = 2

export const HEARTBEAT_PING = 'ping'
export const HEARTBEAT_PONG = 'pong'
export const HEARTBEAT_INTERVAL_MS = 15_000
/** Three missed heartbeats */
export const STALE_AFTER_MS = 45_000
/** How often the room checks for stale sockets and expired members while anyone is in it */
export const SWEEP_INTERVAL_MS = 15_000
/** A socket must send `join` this soon after opening */
export const JOIN_TIMEOUT_MS = 10_000
/** How long a disconnected member keeps its place (ARCHITECTURE.md §4) */
export const RECONNECT_GRACE_MS = 60_000

/** Hard cap on members connected to one room (M3's target is 50, F36) */
export const MAX_MEMBERS = 50
/** Sockets that opened but have not joined yet, on top of MAX_MEMBERS */
export const MAX_PENDING_SOCKETS = 10
/** Client messages larger than this are refused without parsing */
export const MAX_CLIENT_MESSAGE_CHARS = 4_096
/** A display name's length in characters (code points), after normalizeName */
export const MAX_NAME_CHARS = 40

/** WebSocket close codes the server uses; the browser must not retry on the 44xx ones */
export const CloseCode = {
  /** The browser speaks another protocol version: reload the page */
  versionMismatch: 4400,
  /** No room with this id (never created, or closed) */
  roomNotFound: 4404,
  /** MAX_MEMBERS already connected */
  roomFull: 4409,
  /** No heartbeat for STALE_AFTER_MS, or no `join` within JOIN_TIMEOUT_MS */
  stale: 4408,
  /** The same session joined from another socket (a second tab, or a reload that beat the close) */
  replaced: 4410,
} as const

/** The room as POST /api/rooms creates it */
export type RoomInfo = {
  id: string
  createdAt: number
}

/** What GET /api/rooms/<id> answers, for the pre-join screen */
export type RoomSummary = RoomInfo & { memberCount: number }

/**
 * One person in the room. Roles arrive with e1-t04 / e1-t06, tracks with e2-t03. The session
 * token is never part of the view: only its owner gets it, in `welcome`.
 */
export type Member = {
  id: string
  name: string
  joinedAt: number
  /** The socket dropped without `leave`; the member keeps its place for RECONNECT_GRACE_MS */
  reconnecting: boolean
}

/** What every member sees of the room: the state `snapshot` sends and `patch` keeps up to date */
export type RoomView = {
  room: RoomInfo
  members: Record<string, Member>
}

// ── Server → browser ─────────────────────────────────────────────────────────────────────────

export type WelcomeMessage = {
  t: 'welcome'
  v: typeof PROTOCOL_VERSION
  /** This connection's member id */
  you: string
  /** Send this in the next `join` (after a reload) to come back as the same member */
  token: string
  rev: number
  state: RoomView
}

export type SnapshotMessage = { t: 'snapshot'; rev: number; state: RoomView }

/** The changes from rev − 1 to `rev` */
export type PatchMessage = { t: 'patch'; rev: number; ops: PatchOp[] }

export type ErrorMessage = { t: 'error'; code: 'bad_message' }

export type ServerMessage = WelcomeMessage | SnapshotMessage | PatchMessage | ErrorMessage

// ── Browser → server ─────────────────────────────────────────────────────────────────────────

/** The first message on every socket; `token` is null for someone new */
export type JoinMessage = { t: 'join'; name: string; token: string | null }

export type ResyncMessage = { t: 'resync' }

/** Leaving on purpose: the member is removed at once instead of waiting for RECONNECT_GRACE_MS */
export type LeaveMessage = { t: 'leave' }

export type ClientMessage = JoinMessage | ResyncMessage | LeaveMessage

// ── POST /api/rooms ──────────────────────────────────────────────────────────────────────────

export type CreateRoomResponse = { id: string }

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

function parseObject(raw: string, maxChars: number): Record<string, unknown> | null {
  if (raw.length > maxChars) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// Control characters and the bidirectional overrides that could make a name render as someone
// else's (U+202A–202E, U+2066–2069)
const UNSAFE_NAME_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu

/**
 * A display name as the room stores it: unsafe characters removed, runs of whitespace collapsed,
 * trimmed; null when nothing is left or it is longer than MAX_NAME_CHARS. The browser uses it
 * before sending, the server again on `join`.
 */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
  if (name === '' || [...name].length > MAX_NAME_CHARS) return null
  return name
}

/** 32 random bytes, base64url without padding */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value)
}

/** A new session token (crypto.getRandomValues, in the Worker) */
export function newSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A browser's message, or null when it is not one this version understands */
export function parseClientMessage(raw: string): ClientMessage | null {
  const value = parseObject(raw, MAX_CLIENT_MESSAGE_CHARS)
  switch (value?.t) {
    case 'join': {
      const name = normalizeName(value.name)
      if (name === null) return null
      // A malformed token is someone new, not an error: the browser may hold one from an
      // older version
      return { t: 'join', name, token: isSessionToken(value.token) ? value.token : null }
    }
    case 'resync':
      return { t: 'resync' }
    case 'leave':
      return { t: 'leave' }
    default:
      return null
  }
}

const isRev = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

function isRoomView(value: unknown): value is RoomView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Record<string, unknown>
  return (
    typeof view.room === 'object' &&
    view.room !== null &&
    typeof view.members === 'object' &&
    view.members !== null
  )
}

/**
 * The server's message, or null when it is not one this version understands. Checks the shape
 * the browser relies on, not every field: the server is trusted, the check guards against
 * version skew and proxies, not attackers.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  const value = parseObject(raw, Number.POSITIVE_INFINITY)
  if (!value) return null
  switch (value.t) {
    case 'welcome':
      return value.v === PROTOCOL_VERSION &&
        typeof value.you === 'string' &&
        typeof value.token === 'string' &&
        isRev(value.rev) &&
        isRoomView(value.state)
        ? (value as WelcomeMessage)
        : null
    case 'snapshot':
      return isRev(value.rev) && isRoomView(value.state) ? (value as SnapshotMessage) : null
    case 'patch':
      return isRev(value.rev) && Array.isArray(value.ops) ? (value as PatchMessage) : null
    case 'error':
      return value as ErrorMessage
    default:
      return null
  }
}

/** GET: the room's RoomSummary, or 404 */
export function roomInfoPath(roomId: string): string {
  return `/api/rooms/${roomId}`
}

/** The WebSocket path for a room (relative to the site's origin) */
export function roomSocketPath(roomId: string): string {
  return `/api/rooms/${roomId}/ws?v=${PROTOCOL_VERSION}`
}

/** Typed helper so a view can be diffed and patched (shared/patch.ts) */
export const viewAsJson = (view: RoomView): JsonValue => view
