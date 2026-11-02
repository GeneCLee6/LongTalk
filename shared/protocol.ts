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
// 5. Media (B1): a member creates its SFU session through the Worker proxy (/api/sfu/<roomId>/*,
//    authorised with its session token; the room records the session as the member's), publishes,
//    and sends `tracks` with what it publishes now. The room puts the list in `Member.tracks` and
//    everyone subscribes from it. Every STATS_INTERVAL_MS the browser sends `stats` (bytes it
//    received), which the room counts towards the month's egress (shared/usage.ts); the month's
//    state is `RoomView.usage`.
//
// v1 → v2 (A4): `join`, `leave`, `welcome.token`, `Member.name` / `reconnecting`.
// v2 → v3 (B1): `tracks`, `stats`, `Member.tracks`, `RoomView.usage`.
// A browser of an older version is refused at the upgrade with CloseCode.versionMismatch and told
// to reload.
//
// View types are `type` aliases, not interfaces, so they stay assignable to JsonValue.
import type { JsonValue, PatchOp } from './patch.ts'
import type { UsageState } from './usage.ts'

/** Bumped on any change a browser of the previous version could not understand */
export const PROTOCOL_VERSION = 3

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

/** What a published track is, as the room and the UI care about it (MediaTransport's TrackKind) */
export type TrackKind = 'mic' | 'cam' | 'screen' | 'screenAudio'

export const TRACK_KINDS: readonly TrackKind[] = ['mic', 'cam', 'screen', 'screenAudio']

/** One track a member publishes: its global address on the SFU and what it is */
export type MemberTrack = {
  /** The publisher's SFU session (always the member's current one) */
  sessionId: string
  trackName: string
  kind: TrackKind
}

/** Realtime session ids and our track names: short, URL-safe */
const SFU_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const isSfuId = (value: unknown): value is string =>
  typeof value === 'string' && SFU_ID_PATTERN.test(value)

/**
 * One person in the room. Roles arrive with e1-t04 / e1-t06. The session token is never part of
 * the view: only its owner gets it, in `welcome`.
 */
export type Member = {
  id: string
  name: string
  joinedAt: number
  /** The socket dropped without `leave`; the member keeps its place for RECONNECT_GRACE_MS */
  reconnecting: boolean
  /** What the member publishes now, at most one track of each kind */
  tracks: MemberTrack[]
}

/** What every member sees of the room: the state `snapshot` sends and `patch` keeps up to date */
export type RoomView = {
  room: RoomInfo
  members: Record<string, Member>
  /** The month's Realtime egress state (shared/usage.ts); `normal` until the room hears otherwise */
  usage: UsageState
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

/**
 * Everything this member publishes now on its SFU session (replaces the previous list). Ignored
 * unless `sessionId` is the session the member created through the proxy last.
 */
export type TracksMessage = {
  t: 'tracks'
  sessionId: string
  tracks: { trackName: string; kind: TrackKind }[]
}

/** The transport's cumulative bytes received on `sessionId` (the SFU's egress to this browser) */
export type StatsMessage = { t: 'stats'; sessionId: string; bytesReceived: number }

export type ClientMessage =
  JoinMessage | ResyncMessage | LeaveMessage | TracksMessage | StatsMessage

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
    case 'tracks':
      return parseTracks(value)
    case 'stats':
      return isSfuId(value.sessionId) &&
        Number.isSafeInteger(value.bytesReceived) &&
        (value.bytesReceived as number) >= 0
        ? { t: 'stats', sessionId: value.sessionId, bytesReceived: value.bytesReceived as number }
        : null
    default:
      return null
  }
}

function parseTracks(value: Record<string, unknown>): TracksMessage | null {
  if (!isSfuId(value.sessionId) || !Array.isArray(value.tracks)) return null
  if (value.tracks.length > TRACK_KINDS.length) return null
  const tracks: TracksMessage['tracks'] = []
  const kinds = new Set<TrackKind>()
  for (const item of value.tracks as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const { trackName, kind } = item as Record<string, unknown>
    if (!isSfuId(trackName) || !TRACK_KINDS.includes(kind as TrackKind)) return null
    // One track of each kind
    if (kinds.has(kind as TrackKind)) return null
    kinds.add(kind as TrackKind)
    tracks.push({ trackName, kind: kind as TrackKind })
  }
  return { t: 'tracks', sessionId: value.sessionId, tracks }
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
    view.members !== null &&
    typeof view.usage === 'string'
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
