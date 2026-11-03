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
// 6. Mute (B2): every track in `tracks` carries `muted`. Turning the microphone or camera off
//    keeps the track published (the sender stops sending, nothing is renegotiated) and sends
//    `tracks` again with `muted: true`; everyone sees it in `Member.tracks`. A member with no
//    track of a kind (never opened, or refused) counts as muted for that kind.
// 7. Reconnect (B3): a socket that drops (not one closed with a 44xx code but `stale`) is opened
//    again by the browser with exponential backoff and jitter, joining with the same token, so
//    within RECONNECT_GRACE_MS it is the same member with the same tracks; the browser sends
//    `tracks` again after every `welcome`, for anything it changed while the socket was down.
//    `stats` also says whether the browser's media goes through a TURN relay (`relay`), which the
//    free-tier guard counts with TURN's overhead (shared/usage.ts).
// 8. Host and lifecycle (C2): the first member to join is the host (`Member.role`); a host that
//    leaves, or stays reconnecting for HOST_HANDOFF_MS, hands the role to the earliest-joined
//    connected member. A room with nobody in it (no member, no socket) for EMPTY_ROOM_TTL_MS is
//    closed: its state is deleted and its id answers 404 / CloseCode.roomNotFound from then on.
// 9. Names (C2): `rename` changes the member's own display name; `renameRoom` changes the room's
//    name (`RoomInfo.name`; null shows a default made from `createdBy`), host only for now
//    (worker/roles.ts arrives with e1-t06). A refused `renameRoom` is answered with `error`
//    code `forbidden`.
// 10. Screen sharing (D1): one member shares at a time (`RoomInfo.share`). A member who picked
//    what to share sends `share`; the room grants it when nobody shares (or the member already
//    does), and answers `error` code `share_busy` when someone else does, unless `takeOver` is
//    set: then the share moves to the new member at once and the previous sharer's screen track
//    is dropped from its list (its browser sees the change and stops capturing). Once granted, the
//    sharer publishes its screen like any track and lists it in `tracks` (kind `screen`); a
//    `screen` track from a member who does not hold the share is dropped from its list. `unshare`
//    ends the member's own share; leaving, or being removed after RECONNECT_GRACE_MS, ends it too.
//    A host stopping someone else's share is RoomHost.stopShare, put on the wire with F1
//    (e1-t06, worker/roles.ts). In an audio-only month (shared/usage.ts) `share` is refused with
//    `audio_only`: the SFU proxy would refuse the screen's video anyway.
// 11. Chat (D3, shared/chat.ts): `chat` sends a message (≤ MAX_CHAT_CHARS, normalizeChatText on
//    both ends). The room keeps the latest CHAT_HISTORY messages in storage, apart from the view
//    (no patch carries chat): right after every `welcome` it sends the whole history as `chat`
//    frames of at most CHAT_CHUNK messages, the first with `reset` (replace what you have, which
//    also brings a member who reconnected up to date), and every accepted message after that as
//    `chat` with that one message, to everyone (the sender too: that is its acknowledgement).
//    A member over CHAT_RATE is answered `error` code `rate_limited`.
// 12. Host controls (F1, e1-t07): `host` asks the room to act on one member (`muteMember`,
//    `camOff`, `stopShare`, `remove`) or on the whole room (`muteAll`, `endMeeting`). The room
//    decides with worker/roles.ts (shared/roles.ts' table) and answers `error` code `forbidden`
//    when the member may not. Muting and turning a camera off mark the track `muted` in the
//    target's list at once and send the target `notice`, on which its browser turns the
//    microphone or camera off itself (and says so); nobody can turn anyone else's back on, only
//    the member themselves. Stopping a share ends it like `unshare` and sends `notice` too.
//    `remove` closes the member's socket with CloseCode.removed and bans its browser (the `client`
//    id every `join` carries) for BAN_MS: a `join` from it is closed with CloseCode.removed until
//    then. `endMeeting` closes every socket with CloseCode.ended and the room at once (its id
//    answers 404 / CloseCode.roomNotFound from then on, like a room closed when empty).
// 13. Lock and waiting room (F2, e1-t09, e1-t10): `host` `lock` / `waitingRoom` with `on` switch
//    `RoomInfo.locked` / `RoomInfo.waitingRoom` (worker/roles.ts `lockRoom`, `waitingRoom`).
//    A locked room closes every `join` with a token it does not know with CloseCode.locked; a
//    member coming back within RECONNECT_GRACE_MS (its token) still gets in, and so does
//    someone already waiting. With the waiting room on, someone new joins as `waiting`: instead
//    of `welcome` the room sends `lobby` (its id, token, place in the queue, the room's name and
//    whether someone who can admit is connected), again whenever that changes, and nothing
//    else: no view, no patch, no chat; the SFU proxy and TURN refuse it (`media`). Everyone in
//    the room sees who waits in `RoomView.waiting`. `admit` (one), `admitAll` and `deny`
//    (worker/roles.ts `admit`) decide: an admitted member gets its `welcome` and the chat
//    history and is a participant from then on; a denied one is closed with CloseCode.denied
//    and its browser cannot ask again for DENY_COOLDOWN_MS. Turning the waiting room off admits
//    everyone in it. Someone waiting WAIT_TIMEOUT_MS is closed with CloseCode.waitExpired.
// 14. Spotlight (G2, e4-t11): `spotlight` with a member's id puts that member in everyone's main
//    area (`RoomInfo.spotlight`); with null it ends the spotlight (worker/roles.ts `spotlight`:
//    host or co-host; refused with `forbidden`, also for an id that is not a member in the room).
//    One at a time: a new spotlight replaces the old. It ends when the member leaves or is
//    removed, not while they reconnect. Each browser decides how to show it: a member's own pin
//    (local, never sent) wins over the spotlight, and a share keeps the main area (shared/layout.ts).
//
// v1 → v2 (A4): `join`, `leave`, `welcome.token`, `Member.name` / `reconnecting`.
// v2 → v3 (B1): `tracks`, `stats`, `Member.tracks`, `RoomView.usage`.
// v3 → v4 (B2): `MemberTrack.muted`, and `muted` on every entry of `tracks`.
// v4 → v5 (B3): `stats.relay`; the browser reconnects on its own (also after `stale`).
// v5 → v6 (C2): `Member.role`, `RoomInfo.name` / `createdBy` / `startedAt`, `rename`,
//   `renameRoom`, error code `forbidden`.
// v6 → v7 (D1): `RoomInfo.share`, `share`, `unshare`, error codes `share_busy`, `audio_only`.
// v7 → v8 (D3): `chat` both ways, error code `rate_limited`; MAX_CLIENT_MESSAGE_CHARS 4096 → 16384.
// v8 → v9 (F1): `join.client`, `host`, `notice`, roles `cohost` / `waiting`, close codes
//   `removed`, `ended`.
// v9 → v10 (F2): `RoomInfo.locked` / `waitingRoom`, `RoomView.waiting`, `lobby`, `host` actions
//   `lock`, `waitingRoom`, `admit`, `admitAll`, `deny`, close codes `locked`, `denied`,
//   `waitExpired`.
// v10 → v11 (G2): `RoomInfo.spotlight`, `spotlight`.
// A browser of an older version is refused at the upgrade with CloseCode.versionMismatch and told
// to reload.
//
// View types are `type` aliases, not interfaces, so they stay assignable to JsonValue.
import { isChatMessage, normalizeChatText, type ChatMessage } from './chat.ts'
import type { JsonValue, PatchOp } from './patch.ts'
import type { Role } from './roles.ts'
import type { UsageState } from './usage.ts'

/** Bumped on any change a browser of the previous version could not understand */
export const PROTOCOL_VERSION = 11

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
/**
 * Client messages larger than this (UTF-16 code units) are refused without parsing: room for a
 * MAX_CHAT_CHARS message of astral characters (2 units each) with every escape JSON may add
 */
export const MAX_CLIENT_MESSAGE_CHARS = 16_384
/** A display name's length in characters (code points), after normalizeName */
export const MAX_NAME_CHARS = 40
/** A room name's length in characters (code points), after normalizeName */
export const MAX_ROOM_NAME_CHARS = 60

/** A room with nobody in it (no member, no socket) is closed after this long (AC-1.3) */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000
/** A host reconnecting for this long hands the role to a connected member (AC-1.3) */
export const HOST_HANDOFF_MS = 60_000
/** A removed member's browser cannot join the room again for this long (AC-1.4) */
export const BAN_MS = 10 * 60_000
/** The most browsers a room keeps banned at once (the oldest ban goes first) */
export const MAX_BANS = 200
/** A browser turned away from the waiting room cannot ask again for this long (F2) */
export const DENY_COOLDOWN_MS = 60_000
/** Someone waiting this long without being admitted is sent away (F2) */
export const WAIT_TIMEOUT_MS = 15 * 60_000

/**
 * WebSocket close codes the server uses. The browser does not reconnect after the 44xx ones but
 * `stale` (a socket the server stopped hearing from, e.g. a phone that slept: the member is
 * reconnecting and comes back with its token)
 */
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
  /** The host removed this member, or its browser is still banned (BAN_MS, F1) */
  removed: 4403,
  /** The host ended the meeting: the room is closed (F1) */
  ended: 4411,
  /** The room is locked: nobody new gets in, not even into the waiting room (F2) */
  locked: 4423,
  /** The host turned this browser away from the waiting room, or it asked again too soon (F2) */
  denied: 4406,
  /** Waited WAIT_TIMEOUT_MS without being admitted (F2) */
  waitExpired: 4412,
} as const

/** What POST /api/rooms decides about a room */
export type RoomInit = {
  id: string
  createdAt: number
}

/** The room as everyone sees it */
export type RoomInfo = RoomInit & {
  /** Set by the host (`renameRoom`); null shows the default name, made from `createdBy` */
  name: string | null
  /** The first member's name when it joined (null until someone joins) */
  createdBy: string | null
  /** When the first member joined: the top bar's elapsed time counts from it */
  startedAt: number | null
  /** Who shares the screen now (D1, one at a time); null when nobody does */
  share: ShareInfo | null
  /** Nobody new may join, not even into the waiting room (F2, e1-t09) */
  locked: boolean
  /** Someone new waits until a host or co-host admits them (F2, e1-t10) */
  waitingRoom: boolean
  /** The member a host or co-host put in everyone's main area (G2, e4-t11); null for nobody */
  spotlight: string | null
}

/** The room's one screen share (D1, e3-t02) */
export type ShareInfo = {
  memberId: string
  /** When the member was granted the share */
  since: number
}

/** Someone in the waiting room (F2), as the members in the room see them */
export type WaitingEntry = {
  id: string
  name: string
  /** When they started waiting: the queue's order; WAIT_TIMEOUT_MS counts from it */
  since: number
  reconnecting: boolean
}

/** The waiting room's queue in order: first come, first in (ties by id, so every end agrees) */
export function waitingQueue(waiting: Readonly<Record<string, WaitingEntry>> | undefined) {
  return Object.values(waiting ?? {}).sort(
    (a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** What a member may do in the room: shared/roles.ts (F1, e1-t06) */
export type { Role }

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
  /** Published but not sending: the member turned the microphone or camera off (B2) */
  muted: boolean
}

/** Realtime session ids and our track names: short, URL-safe */
const SFU_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const isSfuId = (value: unknown): value is string =>
  typeof value === 'string' && SFU_ID_PATTERN.test(value)

/**
 * One person in the room. The session token is never part of the view: only its owner gets it,
 * in `welcome`.
 */
export type Member = {
  id: string
  name: string
  /**
   * One member is the host whenever anyone is connected (C2, e1-t04); `cohost` comes with
   * e1-t16. Never `waiting` in the view: who waits is `RoomView.waiting` (F2)
   */
  role: Role
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
  /** Who waits to be admitted (F2), by id; first come, first in (`since`) */
  waiting: Record<string, WaitingEntry>
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

/**
 * - `forbidden`: the member may not do that (`renameRoom` from someone who is not the host)
 * - `share_busy`: `share` without `takeOver` while someone else shares (ask, then take over)
 * - `audio_only`: `share` in a month that is audio-only (shared/usage.ts)
 * - `rate_limited`: `chat` faster than CHAT_RATE (D3); the message was not kept
 */
export type ErrorCode = 'bad_message' | 'forbidden' | 'share_busy' | 'audio_only' | 'rate_limited'

/**
 * What a host (or co-host) did to this member (F1): `muted` (the microphone; `all` when it was
 * 全員靜音), `camOff`, `shareStopped`. `by` is that member's id. The browser turns its microphone
 * or camera off on `muted` / `camOff` (the room already lists the track muted) and says what
 * happened.
 */
export type NoticeKind = 'muted' | 'camOff' | 'shareStopped'

export type NoticeMessage = { t: 'notice'; notice: NoticeKind; by: string; all?: true }

export type ErrorMessage = { t: 'error'; code: ErrorCode }

/**
 * What someone in the waiting room gets instead of `welcome` (F2), on joining and whenever it
 * changes: its member id and token (a reload comes back to the same place), its place in the
 * queue (1 is next) out of `count`, the room's name, and whether a host or co-host is connected
 * to admit it.
 */
export type LobbyMessage = {
  t: 'lobby'
  v: typeof PROTOCOL_VERSION
  you: string
  token: string
  position: number
  count: number
  room: Pick<RoomInfo, 'name' | 'createdBy'>
  hostPresent: boolean
}

/**
 * Chat messages (D3, shared/chat.ts), oldest first. `reset`: the first frame of the history the
 * room sends after every `welcome`; replace every message you have with these (more frames of
 * the history may follow without it). Without `reset`: new messages, append them.
 */
export type ChatServerMessage = { t: 'chat'; messages: ChatMessage[]; reset?: true }

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | PatchMessage
  | ErrorMessage
  | ChatServerMessage
  | NoticeMessage
  | LobbyMessage

// ── Browser → server ─────────────────────────────────────────────────────────────────────────

/**
 * The first message on every socket; `token` is null for someone new. `client` is this browser's
 * own random id (localStorage, src/room/session.ts), what a ban is kept against (F1); null when
 * missing or malformed.
 */
export type JoinMessage = { t: 'join'; name: string; token: string | null; client: string | null }

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
  tracks: { trackName: string; kind: TrackKind; muted: boolean }[]
}

/**
 * The transport's cumulative bytes received on `sessionId` (the SFU's egress to this browser),
 * and whether the selected candidate pair goes through a TURN relay (B3)
 */
export type StatsMessage = { t: 'stats'; sessionId: string; bytesReceived: number; relay: boolean }

/** The member's own display name from now on (C2, e1-t05) */
export type RenameMessage = { t: 'rename'; name: string }

/** The room's name (host only, C2, e1-t05) */
export type RenameRoomMessage = { t: 'renameRoom'; name: string }

/**
 * Start sharing the screen (D1): sent once the member picked what to share. `takeOver`: the
 * member confirmed taking the share from whoever has it.
 */
export type ShareMessage = { t: 'share'; takeOver: boolean }

/** Stop sharing (the member's own share) */
export type UnshareMessage = { t: 'unshare' }

/** Spotlight a member for everyone, or (null) end the spotlight (G2, e4-t11; host or co-host) */
export type SpotlightMessage = { t: 'spotlight'; memberId: string | null }

/** A chat message to everyone in the room (D3); `text` is normalizeChatText's */
export type ChatClientMessage = { t: 'chat'; text: string }

/** The host controls that act on one member (F1); `memberId` says who */
export type HostMemberAction = 'muteMember' | 'camOff' | 'stopShare' | 'remove'

/** The host controls that act on the whole room (F1; `admitAll` F2) */
export type HostRoomAction = 'muteAll' | 'endMeeting' | 'admitAll'

/** Admit or turn away one person in the waiting room (F2); `memberId` says who */
export type HostWaitingAction = 'admit' | 'deny'

/** The room's switches (F2): `on` says which way */
export type HostSwitchAction = 'lock' | 'waitingRoom'

export type HostAction = HostMemberAction | HostRoomAction | HostWaitingAction | HostSwitchAction

const HOST_MEMBER_ACTIONS: readonly string[] = ['muteMember', 'camOff', 'stopShare', 'remove']
const HOST_ROOM_ACTIONS: readonly string[] = ['muteAll', 'endMeeting', 'admitAll']
const HOST_WAITING_ACTIONS: readonly string[] = ['admit', 'deny']
const HOST_SWITCH_ACTIONS: readonly string[] = ['lock', 'waitingRoom']

/** A host control (F1, e1-t07; F2); the room checks the member may (worker/roles.ts) */
export type HostMessage =
  | { t: 'host'; action: HostMemberAction; memberId: string }
  | { t: 'host'; action: HostRoomAction }
  | { t: 'host'; action: HostWaitingAction; memberId: string }
  | { t: 'host'; action: HostSwitchAction; on: boolean }

export type ClientMessage =
  | ChatClientMessage
  | HostMessage
  | JoinMessage
  | ResyncMessage
  | LeaveMessage
  | TracksMessage
  | StatsMessage
  | RenameMessage
  | RenameRoomMessage
  | ShareMessage
  | UnshareMessage
  | SpotlightMessage

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
 * A display name (or, with MAX_ROOM_NAME_CHARS, a room name) as the room stores it: unsafe
 * characters removed, runs of whitespace collapsed, trimmed; null when nothing is left or it is
 * longer than `maxChars`. The browser uses it before sending, the server again on receipt.
 */
export function normalizeName(raw: unknown, maxChars: number = MAX_NAME_CHARS): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
  if (name === '' || [...name].length > maxChars) return null
  return name
}

/** 32 random bytes, base64url without padding */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value)
}

/** A browser's own id (F1): 16–64 URL-safe characters */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value)
}

/** Member ids are the room's own (crypto.randomUUID): anything else is not worth a lookup */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const isMemberId = (value: unknown): value is string =>
  typeof value === 'string' && MEMBER_ID_PATTERN.test(value)

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
      return {
        t: 'join',
        name,
        token: isSessionToken(value.token) ? value.token : null,
        client: isClientId(value.client) ? value.client : null,
      }
    }
    case 'resync':
      return { t: 'resync' }
    case 'leave':
      return { t: 'leave' }
    case 'tracks':
      return parseTracks(value)
    case 'rename': {
      const name = normalizeName(value.name)
      return name === null ? null : { t: 'rename', name }
    }
    case 'renameRoom': {
      const name = normalizeName(value.name, MAX_ROOM_NAME_CHARS)
      return name === null ? null : { t: 'renameRoom', name }
    }
    case 'share':
      return typeof value.takeOver === 'boolean' ? { t: 'share', takeOver: value.takeOver } : null
    case 'unshare':
      return { t: 'unshare' }
    case 'spotlight':
      return value.memberId === null || isMemberId(value.memberId)
        ? { t: 'spotlight', memberId: value.memberId }
        : null
    case 'chat': {
      const text = normalizeChatText(value.text)
      return text === null ? null : { t: 'chat', text }
    }
    case 'host': {
      const action = value.action
      if (typeof action !== 'string') return null
      if (HOST_ROOM_ACTIONS.includes(action)) {
        return { t: 'host', action: action as HostRoomAction }
      }
      if (HOST_MEMBER_ACTIONS.includes(action) && isMemberId(value.memberId)) {
        return { t: 'host', action: action as HostMemberAction, memberId: value.memberId }
      }
      if (HOST_WAITING_ACTIONS.includes(action) && isMemberId(value.memberId)) {
        return { t: 'host', action: action as HostWaitingAction, memberId: value.memberId }
      }
      if (HOST_SWITCH_ACTIONS.includes(action) && typeof value.on === 'boolean') {
        return { t: 'host', action: action as HostSwitchAction, on: value.on }
      }
      return null
    }
    case 'stats':
      return isSfuId(value.sessionId) &&
        Number.isSafeInteger(value.bytesReceived) &&
        (value.bytesReceived as number) >= 0 &&
        typeof value.relay === 'boolean'
        ? {
            t: 'stats',
            sessionId: value.sessionId,
            bytesReceived: value.bytesReceived as number,
            relay: value.relay,
          }
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
    const { trackName, kind, muted } = item as Record<string, unknown>
    if (!isSfuId(trackName) || !TRACK_KINDS.includes(kind as TrackKind)) return null
    if (typeof muted !== 'boolean') return null
    // One track of each kind
    if (kinds.has(kind as TrackKind)) return null
    kinds.add(kind as TrackKind)
    tracks.push({ trackName, kind: kind as TrackKind, muted })
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
    case 'chat':
      return Array.isArray(value.messages) && value.messages.every(isChatMessage)
        ? (value as ChatServerMessage)
        : null
    case 'notice':
      return typeof value.notice === 'string' && typeof value.by === 'string'
        ? (value as NoticeMessage)
        : null
    case 'lobby':
      return value.v === PROTOCOL_VERSION &&
        typeof value.you === 'string' &&
        typeof value.token === 'string' &&
        isRev(value.position) &&
        isRev(value.count) &&
        typeof value.room === 'object' &&
        value.room !== null &&
        typeof value.hostPresent === 'boolean'
        ? (value as LobbyMessage)
        : null
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
