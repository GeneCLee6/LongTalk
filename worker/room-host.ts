import {
  PAST_AUTHOR,
  WHITEBOARD_LAYER,
  isWhiteboard,
  type AnnotationOp,
  type Stroke,
} from '../shared/annotation.ts'
import { DEFAULT_ANNOTATION_POLICY, type AnnotationPolicy } from '../shared/roles.ts'
import {
  ANNOTATION_FLUSH_MS,
  BOARD_SAVE_MS,
  ANNOTATION_FRAME_RATE,
  ANNOTATION_STROKE_RATE,
} from '../shared/annotation-limits.ts'
import { CHAT_CHUNK, CHAT_HISTORY, ChatRateLimit, type ChatMessage } from '../shared/chat.ts'
import { INTERACT_RATE, POLL_START_RATE } from '../shared/interact.ts'
import { RoomInteract, type InteractState } from './room-interact.ts'
import { chatVisible } from '../shared/breakout.ts'
import { RoomBreakout, type BreakoutPhase, type BreakoutState } from './room-breakout.ts'
import type { ChatFile } from '../shared/files.ts'
import {
  RoomFiles,
  type FileAccess,
  type FilesGone,
  type FilesState,
  type GrantDecision,
  type GrantRequest,
  type UploadClaim,
} from './room-files.ts'
import { diff } from '../shared/patch.ts'
import {
  BAN_MS,
  CONSENT_TIMEOUT_MS,
  CloseCode,
  DENY_COOLDOWN_MS,
  EMPTY_ROOM_TTL_MS,
  ENDED_TOMBSTONE_MS,
  HEARTBEAT_PING,
  HOST_HANDOFF_MS,
  JOIN_TIMEOUT_MS,
  MAX_BANS,
  MAX_MEMBERS,
  MAX_PENDING_SOCKETS,
  MAX_SHARES,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  SIGNAL_RATE,
  STALE_AFTER_MS,
  SWEEP_INTERVAL_MS,
  WAIT_TIMEOUT_MS,
  isSignalLevel,
  parseClientMessage,
  shareOrder,
  viewAsJson,
  waitingQueue,
  type AnnotationsMessage,
  type BreakoutOpenMessage,
  type HostMessage,
  type JoinMessage,
  type LobbyMessage,
  type Member,
  type MemberTrack,
  type NoticeMessage,
  type PollStartMessage,
  type RoomInfo,
  type RoomInit,
  type RecordingInfo,
  type RoomSummary,
  type RoomView,
  type ShareInfo,
  type ServerMessage,
  type SignalLevel,
  type StatsMessage,
  type TrackKind,
  type TracksMessage,
  type WaitingEntry,
} from '../shared/protocol.ts'
import { ROOM_CONNECT_RATE, SOCKET_MESSAGE_RATE, type OffenceKind } from '../shared/abuse.ts'
import { REACTION_RATE, type Reaction } from '../shared/reactions.ts'
import {
  ASSUMED_BITRATE,
  isVideoKind,
  MAX_ASSUMED_VIDEO_BPS,
  MAX_REPORTED_BITRATE,
  RELAY_OVERHEAD,
  type UsageState,
} from '../shared/usage.ts'
import {
  PasswordGuard,
  hashPassword,
  verifyPassword,
  type GuessRecord,
  type PasswordRecord,
} from './password.ts'
import {
  authorize,
  mayClearLayer,
  mayCloseBoard,
  mayDraw,
  mayOpenBoard,
  type Action,
} from './roles.ts'
import { RoomAnnotations, type AnnotationSegment, type AnnotationWrite } from './room-annotations.ts'
import { Scheduler, type Schedule } from './scheduler.ts'
import type { PersistentRoomInfo } from '../shared/account.ts'
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentMessage,
  type AgentHelloMessage,
  type AgentServerMessage,
} from '../shared/control.ts'
import { RoomPairing, type PairingState } from './room-pairing.ts'

/**
 * The server estimate counts at most this long between two flushes: the sweep flushes every
 * SWEEP_INTERVAL_MS while anyone is in the room, so a longer gap means the room was empty or
 * evicted, not that media flowed all along.
 */
export const MAX_USAGE_GAP_MS = 4 * SWEEP_INTERVAL_MS

/** A `stats` report counts at most this long since the member's previous one */
const MAX_REPORT_GAP_MS = 6 * SWEEP_INTERVAL_MS

/**
 * The room's WebSockets, addressed by a connection id the adapter gives each socket when it
 * opens (the DO's hibernatable sockets, or a fake in tests). A connection is not a member: it
 * becomes one on `join`, and a member outlives its connection for RECONNECT_GRACE_MS.
 */
export interface RoomSockets {
  send(connId: string, message: ServerMessage): void
  /**
   * What goes to a desktop agent's socket only (N2, shared/control.ts AgentServerMessage). Optional
   * for tests that never pair
   */
  post?(connId: string, message: AgentServerMessage): void
  close(connId: string, code: number, reason: string): void
}

/** A member as stored, so the session survives the object being evicted while nobody is connected */
export type SessionRecord = {
  token: string
  member: Member
  /** The connection the member is on, or null while it is reconnecting */
  conn: string | null
  /** When its connection dropped (null while connected) */
  awaySince: number | null
  /** The SFU session the member created through the proxy last (absent in rooms stored by v2) */
  sfu?: string | null
  /** The browser's own id from `join` (F1; absent in rooms stored before v9): what a ban is on */
  client?: string | null
  /** A desktop agent's (N2): who issued its pairing code, as they were then, for `agentWelcome` */
  pairedBy?: PairedBy | null
}

/** The member whose pairing code brought a desktop agent in, with their name at the time (N2) */
export type PairedBy = { id: string; name: string }

/**
 * A removed member's browser (F1, AC-1.4): `client` is the id its `join` carried. Kept until
 * `until` (BAN_MS after the removal) in the room's storage, so it outlasts an eviction. `denied`
 * (F2): turned away from the waiting room, kept out only for DENY_COOLDOWN_MS.
 */
export type Ban = { client: string; until: number; denied?: true }

/** Why a browser may not join now (a ban, F1, or a denial's cool-down, F2) */
type BanKind = 'removed' | 'denied'

/**
 * What the SFU proxy may do for a session token (worker/sfu.ts): the member's id and the kind of
 * every remote track it asked to pull, in order.
 */
export type SfuAccess =
  | { ok: true; memberId: string; pulls: TrackKind[] }
  | {
      ok: false
      /**
       * - `unauthorized`: no such room, or the token is not a member's
       * - `forbidden`: the SFU session is not the member's
       * - `not_found`: a track to pull is not published in this room
       */
      reason: 'unauthorized' | 'forbidden' | 'not_found'
    }

/** A track on the SFU, as the proxy sees a pull */
export type SfuTrackRef = { sessionId: string; trackName: string }

/** Egress counted since the previous flush (shared/usage.ts), in bytes */
export type UsageDelta = { clientBytes: number; estimateBytes: number }

/** What each `host` action asks worker/roles.ts for (F1, F2) */
const HOST_RULE: Readonly<Record<HostMessage['action'], Action>> = {
  muteMember: 'muteMember',
  camOff: 'camOff',
  stopShare: 'stopShare',
  remove: 'remove',
  muteAll: 'muteAll',
  endMeeting: 'endMeeting',
  lock: 'lockRoom',
  waitingRoom: 'waitingRoom',
  admit: 'admit',
  admitAll: 'admit',
  deny: 'admit',
  setPassword: 'setPassword',
  setCohost: 'setCohost',
  makeHost: 'makeHost',
  lowerHand: 'lowerHand',
  // I4 (e8-t02): stopping someone's recording is the host's `record`; allowing it is its own
  stopRecording: 'record',
  allowRecord: 'allowRecord',
  // J3 (e7-t05)
  annotationPolicy: 'annotationPolicy',
}

const NO_CONNS: ReadonlySet<string> = new Set()

/** Who takes the host role first (AC-1.3, F3): a co-host before anyone else, then who joined first */
const before = (a: Member, b: Member): boolean =>
  a.role === 'cohost' && b.role !== 'cohost'
    ? true
    : a.role !== 'cohost' && b.role === 'cohost'
      ? false
      : a.joinedAt < b.joinedAt

/** The kinds only a member who shares may list (D1) */
const SCREEN_KINDS: ReadonlySet<TrackKind> = new Set(['screen', 'screenAudio'])

/**
 * A live socket the adapter found when it woke up. `ip`: its network address as
 * worker/password.ts addressKey keeps it (never the address itself), for the guess limit (F3)
 */
export type OpenSocket = {
  conn: string
  openedAt: number
  ip?: string | null
  /** The account signed in on the upgrade (I2), as the Worker checked it; null for none */
  account?: string | null
  /** A desktop agent's socket (/api/rooms/<id>/agent, N2), not a browser's (/ws) */
  agent?: boolean
}

/**
 * A personal persistent room (I2, e1-t13): its slug (also its id) and the account that owns it.
 * Kept in the room's storage next to its settings; never sent to anyone.
 */
export type PersistentRecord = { slug: string; owner: string; createdAt: number }

/** What the owner may change from /me (I2): `password` null clears it, a string sets it */
export type SettingsChange = {
  name?: string | null
  waitingRoom?: boolean
  locked?: boolean
  password?: string | null
  /** L5, e1-t18 */
  startMuted?: boolean
  allowAnnotation?: boolean
  allowRecording?: boolean
}

/** A persistent room's settings as /me lists them (shared/account.ts, without the slug's row) */
export type RoomSettings = Omit<PersistentRoomInfo, 'slug' | 'createdAt'>

/** What else survives the object being evicted (F3) */
export type RestoreExtras = {
  /** The room's password, as a salted digest */
  password?: PasswordRecord | null
  /** Wrong password guesses still counting */
  guesses?: readonly GuessRecord[]
  /** Until when a meeting that was ended answers CloseCode.ended */
  endedUntil?: number | null
  /** A personal persistent room's slug and owner (I2) */
  persistent?: PersistentRecord | null
  /** Files shared in the chat and uploads under way (I5) */
  files?: FilesState | null
  /** The strokes on the shares, as stored (J2) */
  annotations?: readonly AnnotationSegment[]
  /** How this meeting stands with the saved whiteboard (J4); absent: it has not read it yet */
  board?: BoardState | null
  /** The poll, its votes, the countdown and the agenda (L5) */
  interact?: InteractState | null
  /** The breakout rooms and who is in which (L3) */
  breakout?: BreakoutState | null
  /** Open pairing codes and wrong codes still counting (N2) */
  pairing?: PairingState | null
}

/** A persistent room's meeting that has read its saved whiteboard (J4, e7-t08) */
export type BoardState = {
  /** It changed since it was last saved */
  dirty: boolean
}

/**
 * Where a persistent room's whiteboard lives between meetings (J4, e7-t08; worker/board-store.ts).
 * Only `load` rejects: a save that failed resolves false, a deletion that failed is logged
 */
export interface RoomBoards {
  load(record: PersistentRecord): Promise<readonly Stroke[] | null>
  save(record: PersistentRecord, strokes: readonly Stroke[]): Promise<boolean>
  /** The meeting never managed to read it: what was saved stays under what this one drew */
  merge(record: PersistentRecord, strokes: readonly Stroke[]): Promise<boolean>
  remove(record: PersistentRecord): Promise<void>
}

/** What survives the object being evicted */
export interface RoomStorage {
  saveRoom(info: RoomInfo): void
  saveRev(rev: number): void
  saveSessions(sessions: SessionRecord[]): void
  /** When egress was last counted and the month's state, so both survive the object being evicted */
  saveUsage(usage: UsageCursor): void
  /** The alarm's jobs (scheduler.ts), saved whenever they change */
  saveSchedule(schedule: Schedule): void
  /** A chat message the room accepted (D3): each is stored on its own, by id */
  saveChat(message: ChatMessage): void
  /** A chat message that fell out of the last CHAT_HISTORY */
  dropChat(id: number): void
  /** The banned browsers (F1), saved whenever the list changes */
  saveBans(bans: Ban[]): void
  /** The room's password as a salted digest, or null for none (F3) */
  savePassword(record: PasswordRecord | null): void
  /** Wrong password guesses still counting (F3), saved whenever they change */
  saveGuesses(guesses: GuessRecord[]): void
  /** Until when an ended meeting answers CloseCode.ended (F3); saved after `clear`; null drops it */
  saveEnded(until: number | null): void
  /**
   * A persistent room's slug and owner (I2), saved after `clear` too; null drops it. Optional:
   * a room that is never persistent (tests) needs none
   */
  savePersistent?(record: PersistentRecord | null): void
  /** Files shared in the chat and uploads under way (I5), saved whenever they change */
  saveFiles?(state: FilesState): void
  /** Segments of strokes that changed (J2, worker/room-annotations.ts); optional like the above */
  saveAnnotations?(writes: AnnotationWrite[]): void
  /** How this meeting stands with the saved whiteboard (J4); optional like the above */
  saveBoardState?(state: BoardState): void
  /** The poll, its votes, the countdown and the agenda (L5), saved whenever they change */
  saveInteract?(state: InteractState): void
  /** The breakout rooms and who is in which (L3), saved whenever they change; null: none open */
  saveBreakout?(state: BreakoutState | null): void
  /** Open pairing codes and wrong codes still counting (N2), saved whenever they change; null: none */
  savePairing?(state: PairingState | null): void
  /** The room closed: everything stored goes (the adapter also drops the alarm) */
  clear(): void
}

/**
 * Stored rooms from before v6 have no name, creator or start time; from before v7 no share; from
 * before v15 one `share` (or null) instead of `shares`
 */
type StoredRoomInfo = RoomInit &
  Partial<Omit<RoomInfo, keyof RoomInit>> & { share?: ShareInfo | null }

/** A stored room's shares, whichever version stored it (H5: `share` became `shares`) */
function storedShares(info: StoredRoomInfo): Record<string, ShareInfo> {
  if (info.shares) return info.shares
  return info.share ? { [info.share.memberId]: info.share } : {}
}

/** A stored room as this version keeps it: defaults for what older versions did not store */
function restoredInfo(info: StoredRoomInfo): RoomInfo {
  const { share: _share, ...rest } = info
  return {
    name: null,
    createdBy: null,
    startedAt: null,
    locked: false,
    waitingRoom: false,
    passwordSetAt: null,
    persistent: false,
    spotlight: null,
    // Rooms stored before v17 record nothing (I4)
    recordings: {},
    // Rooms stored before v21 have neither (J3)
    annotationPolicy: DEFAULT_ANNOTATION_POLICY,
    whiteboard: null,
    // Rooms stored before v22 have none of these (L5)
    startMuted: false,
    allowAnnotation: true,
    allowRecording: true,
    ...rest,
    shares: storedShares(info),
  }
}

/** Who may annotate when a meeting starts (L5, e1-t18): the owner may have turned it off */
const startingPolicy = (allowed: boolean | undefined): AnnotationPolicy =>
  allowed === false ? 'off' : DEFAULT_ANNOTATION_POLICY

/** What the alarm did, for the adapter */
export type AlarmResult = {
  /** The sweep ran: hand the egress to UsageDO */
  swept: boolean
  /** The room was empty for EMPTY_ROOM_TTL_MS and is gone */
  closed: boolean
}

export type UsageCursor = { at: number; state: UsageState }

export interface RoomHostDeps {
  sockets: RoomSockets
  storage: RoomStorage
  now: () => number
  newMemberId: () => string
  newToken: () => string
  /**
   * A connection hit an abuse limit (I1): the adapter tells GuardDO, so /admin lists the
   * client. `connId` is null for an upgrade refused before it had one; `ip` its address key.
   */
  offence?: (connId: string | null, ip: string | null, kind: OffenceKind) => void
  /**
   * The room closed with files stored (I5): the adapter deletes them from R2 right away. Best
   * effort: whatever is missed goes with the hourly sweep (worker/sweep.ts).
   */
  filesGone?: (gone: FilesGone) => void
  /**
   * Runs `work` after `ms`, keeping the object awake until then (J2: the adapter's setTimeout; a
   * pending timer holds off hibernation, so strokes reach storage before memory goes). Without it
   * strokes are stored by the next alarm. An eviction before it fires loses at most that long.
   */
  later?: (ms: number, work: () => void) => void
  /** A persistent room's whiteboard between meetings (J4); absent: it goes with the meeting */
  boards?: RoomBoards
}

export type Admission = { ok: true } | { ok: false; code: number; reason: string }

type Connection = {
  /** The member on this connection, null until it joins */
  member: string | null
  openedAt: number
  lastSeen: number
  /** Its network address as addressKey keeps it (F3), null when unknown */
  ip: string | null
  /** Its `join` waits for the password check (F3): another `join` is refused meanwhile */
  joining: boolean
  /** The account signed in when it opened (I2), null for none */
  account: string | null
  /**
   * A desktop agent's socket (N2): only agent messages are taken on it (parseAgentMessage), and it
   * gets no room view, chat or strokes; a browser's socket never takes an agent message
   */
  agent: boolean
}

type Session = {
  token: string
  conn: string | null
  awaySince: number | null
  sfu: string | null
  /** The browser's own id from its last `join`, null when it sent none */
  client: string | null
  /** A desktop agent's: who paired it (N2); null for a browser */
  pairedBy: PairedBy | null
}

/** The last `stats` a member sent on its current SFU session */
type Baseline = { sessionId: string; bytes: number; at: number }

/**
 * One room's signalling: connections, members and their sessions, heartbeat and diff push. Never
 * touches a Cloudflare API, so Vitest runs it directly; `RoomDO` (room.ts) is the glue to storage
 * and WebSockets.
 *
 * Every change goes through `publish`: it diffs the view everyone last received against the
 * current one, sends the difference as one numbered patch and stores the sessions.
 */
export class RoomHost {
  private readonly deps: RoomHostDeps
  private info: RoomInfo | null = null
  private readonly members = new Map<string, Member>()
  private readonly sessions = new Map<string, Session>()
  private readonly byToken = new Map<string, string>()
  private readonly conns = new Map<string, Connection>()
  private rev = 0
  /** The view every connected member has (after the last patch) */
  private sent: RoomView | null = null
  private usage: UsageState = 'normal'
  private usageAt = 0
  /** Bytes the browsers reported since the last flush */
  private reported = 0
  private readonly baselines = new Map<string, Baseline>()
  /**
   * Members whose last `stats` said their media goes through a TURN relay (e2-t07). Not stored:
   * after an eviction the next report (STATS_INTERVAL_MS) says it again.
   */
  private readonly relayed = new Set<string>()
  /** The alarm's jobs: `sweep`, `close`, `handoff` (scheduler.ts) */
  private schedule = new Scheduler()
  /** The schedule as last stored, to store it only when it changes */
  private storedSchedule = '{}'
  /** The latest CHAT_HISTORY chat messages, oldest first (D3) */
  private chat: ChatMessage[] = []
  /** Files shared in the chat and uploads under way (I5): limits and who may have what */
  private files = new RoomFiles()
  /** The id of the last chat message the room accepted (0 before the first) */
  private chatId = 0
  /** CHAT_RATE per member; in memory only (an eviction forgets it) */
  private readonly chatRate = new ChatRateLimit()
  /** Reactions per member (G3, REACTION_RATE), in memory like the chat's */
  private readonly reactionRate = new ChatRateLimit(REACTION_RATE)
  /** `signal` reports per member (H2, SIGNAL_RATE), in memory */
  private readonly signalRate = new ChatRateLimit(SIGNAL_RATE)
  /** Every frame per connection (I1, SOCKET_MESSAGE_RATE), in memory */
  private readonly socketRate = new ChatRateLimit(SOCKET_MESSAGE_RATE)
  /** Upgrades per network address (I1, ROOM_CONNECT_RATE), in memory */
  private readonly connectRate = new ChatRateLimit(ROOM_CONNECT_RATE)
  /** Removed (F1) and denied (F2) browsers and until when, by client id */
  private readonly bans = new Map<string, { until: number; kind: BanKind }>()
  /** The `lobby` each waiting member was sent last (F2), to send it only when it changes */
  private readonly lobbies = new Map<string, string>()
  /** The room's password as a salted digest (F3); null for none */
  private password: PasswordRecord | null = null
  /** Counts `setPassword` calls, so a slower digest never overwrites a newer password */
  private passwordSeq = 0
  /** The wrong-guess limit (F3, AC-1.8) */
  private guard = new PasswordGuard()
  /** Until when this ended meeting answers CloseCode.ended (F3); null otherwise */
  private endedUntil: number | null = null
  /** A personal persistent room's slug and owner (I2, e1-t13); null for a random room */
  private persistent: PersistentRecord | null = null
  /**
   * When each connected member last came in (joined, was admitted, reconnected; I4): a recording's
   * CONSENT_TIMEOUT_MS counts from this or the recording's start, whichever is later. Not stored:
   * after an eviction everyone counts from the restore
   */
  private readonly cameIn = new Map<string, number>()
  /** The strokes on the shares (J2, e7-t04) */
  private annotations = new RoomAnnotations()
  /** A storage write of the strokes is on its way (`later`) */
  private annotationsFlushing = false
  /** This meeting has read the saved whiteboard (J4) */
  private boardLoaded = false
  /** The whiteboard changed since it was last saved (J4) */
  private boardDirty = false
  /** The read under way, so people arriving together wait for one */
  private boardLoading: Promise<void> | null = null
  /** `annotate` frames and new strokes per member (J2), in memory like the chat's */
  private readonly annotationFrames = new ChatRateLimit(ANNOTATION_FRAME_RATE)
  private readonly annotationStrokes = new ChatRateLimit(ANNOTATION_STROKE_RATE)
  /** The poll, the countdown and the agenda (L5, e5-t07, e5-t08) */
  private interact = new RoomInteract()
  /** Polls started and everything else of those per member (L5), in memory like the chat's */
  private readonly pollRate = new ChatRateLimit(POLL_START_RATE)
  private readonly interactRate = new ChatRateLimit(INTERACT_RATE)
  /** The breakout rooms and who is in which (L3, e10-t04) */
  private breakout = new RoomBreakout()
  /** Open pairing codes and the wrong-code limits (N2, e9-t02) */
  private pairing = new RoomPairing()

  constructor(deps: RoomHostDeps) {
    this.deps = deps
  }

  /**
   * Rebuilds the room after the object was evicted or woke from hibernation: the room, rev and
   * sessions from storage, the connections from the live sockets. A connection counts as last
   * seen when it opened until the adapter reports its heartbeats (`heartbeat`). A stored member
   * whose socket is gone is marked reconnecting.
   */
  restore(
    info: StoredRoomInfo | null,
    rev: number,
    sessions: readonly SessionRecord[],
    sockets: readonly OpenSocket[],
    usage: UsageCursor | null = null,
    schedule: Schedule | null = null,
    chat: readonly ChatMessage[] = [],
    bans: readonly Ban[] = [],
    extras: RestoreExtras = {},
  ): void {
    // Rooms stored before v6 have no name, creator or start time
    this.info = info ? restoredInfo(info) : null
    this.password = info ? (extras.password ?? null) : null
    // A room stored with a password time but no digest (never expected): no password
    if (this.info && this.password === null && this.info.passwordSetAt !== null) {
      this.info = { ...this.info, passwordSetAt: null }
    }
    this.guard = new PasswordGuard(extras.guesses ?? [])
    this.persistent = info ? (extras.persistent ?? null) : null
    // A persistent room keeps its settings after a meeting ends, and the tombstone with them (I2)
    this.endedUntil = info && !this.persistent ? null : (extras.endedUntil ?? null)
    this.rev = rev
    this.schedule = new Scheduler(schedule)
    this.storedSchedule = JSON.stringify(this.schedule)
    this.members.clear()
    this.sessions.clear()
    this.byToken.clear()
    this.conns.clear()
    this.baselines.clear()
    this.relayed.clear()
    this.chatRate.clear()
    this.reactionRate.clear()
    this.signalRate.clear()
    this.bans.clear()
    this.lobbies.clear()
    this.cameIn.clear()
    for (const ban of bans) {
      this.bans.set(ban.client, { until: ban.until, kind: ban.denied ? 'denied' : 'removed' })
    }
    this.chat = [...chat].sort((a, b) => a.id - b.id).slice(-CHAT_HISTORY)
    this.chatId = this.chat.at(-1)?.id ?? 0
    this.files = new RoomFiles(info ? extras.files : null)
    this.annotationFrames.clear()
    this.annotationStrokes.clear()
    this.interact = new RoomInteract(info ? extras.interact : null)
    this.breakout = new RoomBreakout(info ? extras.breakout : null)
    this.pairing = new RoomPairing(info ? extras.pairing : null)
    this.pollRate.clear()
    this.interactRate.clear()
    this.reported = 0
    this.usage = usage?.state ?? 'normal'
    this.usageAt = usage?.at ?? this.deps.now()
    for (const { conn, openedAt, ip, account, agent } of sockets) {
      this.conns.set(conn, {
        member: null,
        openedAt,
        lastSeen: openedAt,
        ip: ip ?? null,
        joining: false,
        account: account ?? null,
        agent: agent === true,
      })
    }
    for (const record of sessions) {
      // Members stored by protocol v2 have no tracks, by v3 no `muted`, by v5 no role, by v12 no
      // hand, by v13 no signal
      const tracks = (record.member.tracks ?? []).map((track) => ({
        ...track,
        muted: track.muted ?? false,
      }))
      const role = record.member.role ?? 'participant'
      const hand = typeof record.member.hand === 'number' ? record.member.hand : null
      const signal = isSignalLevel(record.member.signal) ? record.member.signal : null
      // ... by v16 no permission to record (I4)
      const mayRecord = record.member.mayRecord === true
      this.members.set(record.member.id, {
        ...record.member,
        role,
        tracks,
        hand,
        signal,
        mayRecord,
      })
      this.sessions.set(record.member.id, {
        token: record.token,
        conn: record.conn,
        awaySince: record.awaySince,
        sfu: record.sfu ?? null,
        client: record.client ?? null,
        pairedBy: record.pairedBy ?? null,
      })
      this.byToken.set(record.token, record.member.id)
    }
    // Sharers that are no longer members (a defensive repair: removing a member ends its share)
    const shares = this.info?.shares ?? {}
    const kept = Object.fromEntries(
      Object.entries(shares).filter(([memberId]) => this.members.has(memberId)),
    )
    if (Object.keys(kept).length !== Object.keys(shares).length) {
      this.info = { ...this.info!, shares: kept }
    }
    // And for who is in a breakout room (L3)
    for (const id of this.breakout.assigned) {
      if (!this.inRoomMember(id) && this.breakout.forget(id)) this.saveBreakout()
    }
    // And for pairing codes whose member left (N2)
    for (const id of this.pairingOwners()) {
      if (!this.inRoomMember(id) && this.pairing.cancel(id)) this.savePairing()
    }
    // The same for the spotlight (G2)
    const spotlight = this.info?.spotlight ?? null
    if (spotlight !== null && !this.inRoomMember(spotlight)) {
      this.info = { ...this.info!, spotlight: null }
    }
    // And for recorders (I4); recordings stored before consent (I4's first cut) have no list
    const recordings = this.info?.recordings ?? {}
    const recording = Object.fromEntries(
      Object.entries(recordings)
        .filter(([memberId]) => this.inRoomMember(memberId))
        .map(([memberId, entry]) => [memberId, { ...entry, consented: entry.consented ?? [] }]),
    )
    if (JSON.stringify(recording) !== JSON.stringify(recordings)) {
      this.info = { ...this.info!, recordings: recording }
    }
    // Strokes of a share that ended before they left storage go now (J2). The whiteboard's stay,
    // open or closed, until someone clears them or the meeting ends (J3)
    const sharing = this.info?.shares ?? {}
    this.annotations = new RoomAnnotations(
      info ? (extras.annotations ?? []) : [],
      (share) => share === WHITEBOARD_LAYER || sharing[share] !== undefined,
    )
    this.flushAnnotations()
    this.boardLoaded = !!info && !!extras.board
    this.boardDirty = !!info && extras.board?.dirty === true
    const restoredAt = this.deps.now()
    for (const id of this.members.keys()) this.cameIn.set(id, restoredAt)
    this.sent = info ? this.view() : null
    if (!info) {
      // An ended meeting's tombstone (F3) keeps its job; a stale one goes at the next alarm
      if (this.endedUntil !== null) this.schedule.set('ended', this.endedUntil)
      return
    }
    const now = this.deps.now()
    for (const [id, session] of this.sessions) {
      const conn = session.conn === null ? undefined : this.conns.get(session.conn)
      if (conn) {
        conn.member = id
        continue
      }
      session.conn = null
      session.awaySince ??= now
      if (!this.members.get(id)!.reconnecting) this.setMember(id, { reconnecting: true })
    }
    // Sends only what changed (members marked reconnecting, a host for a room stored by v5) and
    // brings the schedule up to date (a room stored before C2 has none)
    this.publish()
  }

  get exists(): boolean {
    return this.info !== null
  }

  /** Members in the room, connected or reconnecting (not who waits, F2) */
  get memberCount(): number {
    let count = 0
    for (const member of this.members.values()) if (member.role !== 'waiting') count++
    return count
  }

  /** Whether the sweep alarm still has anything to watch */
  get active(): boolean {
    return this.conns.size > 0 || this.members.size > 0
  }

  /**
   * Called once by POST /api/rooms; false when the id is already taken. A room nobody joins
   * closes like an empty one, EMPTY_ROOM_TTL_MS later.
   */
  create(init: RoomInit): boolean {
    // An ended meeting's id is not handed out again while its tombstone lasts (F3)
    if (this.info || this.ended) return false
    this.info = {
      ...init,
      name: null,
      createdBy: null,
      startedAt: null,
      shares: {},
      locked: false,
      waitingRoom: false,
      passwordSetAt: null,
      persistent: false,
      spotlight: null,
      recordings: {},
      annotationPolicy: DEFAULT_ANNOTATION_POLICY,
      whiteboard: null,
      startMuted: false,
      allowAnnotation: true,
      allowRecording: true,
    }
    this.deps.storage.saveRoom(this.info)
    this.usageAt = this.deps.now()
    this.sent = this.view()
    this.reschedule()
    return true
  }

  /**
   * Called once by POST /api/account/rooms (I2, e1-t13): the room `slug` becomes `owner`'s, with
   * its name. False when the slug's room already exists. A persistent room never closes: between
   * meetings it keeps its settings (name, password, waiting room, lock) and nothing else.
   */
  createPersistent(record: PersistentRecord, name: string | null): boolean {
    if (this.info || this.ended) return false
    this.persistent = record
    this.deps.storage.savePersistent?.(record)
    this.create({ id: record.slug, createdAt: record.createdAt })
    this.info = { ...this.info!, name, persistent: true }
    this.deps.storage.saveRoom(this.info)
    this.sent = this.view()
    return true
  }

  /** Whether this is a personal persistent room (I2) */
  get isPersistent(): boolean {
    return this.persistent !== null
  }

  /** Whether `account` owns this room (I2): always false for a random room */
  ownedBy(account: string | null): boolean {
    return account !== null && this.persistent?.owner === account
  }

  /** A persistent room's settings for /me (I2); null for a random room */
  settings(): RoomSettings | null {
    if (!this.persistent || !this.info) return null
    return {
      name: this.info.name,
      waitingRoom: this.info.waitingRoom,
      locked: this.info.locked,
      password: this.info.passwordSetAt !== null,
      memberCount: this.memberCount,
      startMuted: this.info.startMuted === true,
      allowAnnotation: this.info.allowAnnotation !== false,
      allowRecording: this.info.allowRecording !== false,
    }
  }

  /**
   * The owner changed the room's settings on /me (I2): like the host's own switches in the room,
   * and everyone in it sees the change. The Worker checked the owner and the values. Turning the
   * waiting room off admits everyone waiting, as it does in the room.
   */
  async updateSettings(change: SettingsChange): Promise<RoomSettings | null> {
    if (!this.persistent || !this.info) return null
    if (change.name !== undefined) {
      this.info = { ...this.info, name: change.name }
      this.deps.storage.saveRoom(this.info)
      this.publish()
    }
    if (change.locked !== undefined && change.locked !== this.info.locked) {
      this.setRoom({ locked: change.locked })
    }
    if (change.waitingRoom !== undefined && change.waitingRoom !== this.info.waitingRoom) {
      this.setRoom({ waitingRoom: change.waitingRoom })
      if (!change.waitingRoom) this.admitWaiting(this.waitingIds())
    }
    if (change.startMuted !== undefined && change.startMuted !== this.info.startMuted) {
      // Only for who comes in from now on: who is here keeps the microphone as it is
      this.setRoom({ startMuted: change.startMuted })
    }
    if (change.allowRecording !== undefined && change.allowRecording !== this.info.allowRecording) {
      // Only new recordings are refused: one under way is on everyone's screen, and stops as usual
      this.setRoom({ allowRecording: change.allowRecording })
    }
    if (
      change.allowAnnotation !== undefined &&
      change.allowAnnotation !== this.info.allowAnnotation
    ) {
      // At once: who was drawing loses the tools. What is drawn stays, and can still be cleared
      this.setRoom({
        allowAnnotation: change.allowAnnotation,
        annotationPolicy: startingPolicy(change.allowAnnotation),
      })
    }
    if (change.password !== undefined) await this.setPassword(change.password)
    return this.settings()
  }

  /**
   * The owner deleted the room, or their account (I2): everyone in it is sent away as when a
   * meeting ends, and everything stored goes; the slug's room is simply not found from now on
   */
  destroy(): void {
    if (!this.persistent) return
    for (const id of [...this.conns.keys()]) {
      this.deps.sockets.close(id, CloseCode.ended, 'ended')
    }
    this.conns.clear()
    const gone = this.persistent
    this.persistent = null
    this.endedUntil = null
    // Its whiteboard too. After whatever save is under way (worker/board-store.ts)
    if (this.deps.boards) this.boardGone = this.deps.boards.remove(gone)
    this.close()
  }

  /** The deletion of a destroyed room's whiteboard, for the adapter to wait for */
  boardGone: Promise<void> | null = null

  /**
   * Someone is arriving at a persistent room (J4, e7-t08): the whiteboard saved by its last meeting
   * comes back before their welcome, so it is in the snapshot they get. Once a meeting. When R2
   * cannot say, the meeting starts without it and the next arrival or `board` job tries again: what
   * was saved is not overwritten meanwhile (`saveBoard` waits for it, `close` merges).
   */
  prepareBoard(): Promise<void> {
    const record = this.persistent
    const { boards } = this.deps
    if (!record || !boards || this.boardLoaded) return Promise.resolve()
    this.boardLoading ??= boards
      .load(record)
      .then((strokes) => {
        // Destroyed, or a new meeting, while it was on its way
        if (this.persistent !== record || !this.info) return
        this.boardLoaded = true
        this.deps.storage.saveBoardState?.({ dirty: this.boardDirty })
        if (!strokes || strokes.length === 0) return
        this.annotations.seed(WHITEBOARD_LAYER, strokes)
        this.flushAnnotations()
        // Only someone already here when an earlier try failed
        for (const id of this.roomConns()) this.sendAnnotations(id)
      })
      .catch((error: unknown) => console.error('reading a saved whiteboard failed', error))
      .finally(() => {
        this.boardLoading = null
      })
    return this.boardLoading
  }

  /** The whiteboard changed: a persistent room saves it within BOARD_SAVE_MS (J4) */
  private boardChanged(): void {
    if (!this.persistent || !this.deps.boards || this.boardDirty) return
    this.boardDirty = true
    if (this.boardLoaded) this.deps.storage.saveBoardState?.({ dirty: true })
    this.reschedule()
  }

  /** What changed goes to R2 now, once the meeting has read what was there */
  private saveBoard(): void {
    const record = this.persistent
    const { boards } = this.deps
    if (!record || !boards || !this.boardDirty) return
    if (!this.boardLoaded) {
      void this.prepareBoard()
      return
    }
    this.boardDirty = false
    this.deps.storage.saveBoardState?.({ dirty: false })
    void boards.save(record, this.annotations.strokes(WHITEBOARD_LAYER)).then((saved) => {
      // Tried again at the next job, or when the meeting closes
      if (!saved && this.persistent === record && this.info?.startedAt) this.boardChanged()
    })
  }

  /** When the alarm should fire next (the earliest job), or null for no alarm */
  nextAlarm(): number | null {
    return this.schedule.next()
  }

  /**
   * The alarm fired: runs every job that is due. `sweep` checks heartbeats and grace windows
   * (the adapter then flushes usage), `handoff` hands a host that stayed away to someone
   * connected, `close` deletes a room that stayed empty. Then schedules what is next.
   */
  alarm(): AlarmResult {
    const result: AlarmResult = { swept: false, closed: false }
    this.flushAnnotations()
    for (const job of this.schedule.take(this.deps.now())) {
      if (job === 'sweep') {
        this.sweep()
        result.swept = true
      } else if (job === 'handoff') {
        // publish hands the role over (assignHost) and sends the change
        this.publish()
      } else if (job === 'bans') {
        this.pruneBans()
      } else if (job === 'waiting') {
        this.expireWaiting()
      } else if (job === 'consent') {
        this.expireConsent()
      } else if (job === 'guesses') {
        if (this.guard.prune(this.deps.now())) this.saveGuesses()
      } else if (job === 'board') {
        this.saveBoard()
      } else if (job === 'breakout') {
        this.tickBreakout()
      } else if (job === 'pairing') {
        this.expirePairing()
      } else if (job === 'ended' && !this.info) {
        // The ended meeting's tombstone ran out (F3): from now on its id is simply not found
        this.endedUntil = null
        this.deps.storage.clear()
        return result
      } else if (job === 'ended') {
        // A persistent room's tombstone ran out (I2): its settings stay
        this.endedUntil = null
        this.deps.storage.saveEnded(null)
      } else if (job === 'close' && this.info && !this.active) {
        this.close()
        result.closed = true
        return result
      }
    }
    this.reschedule()
    return result
  }

  /**
   * For GET /api/rooms/<id>; null when the room does not exist. `owner` (I2): whether the
   * signed-in account asking owns this persistent room (its pre-join skips the lock, the
   * password and the waiting room, which never apply to it)
   */
  summary(account: string | null = null): (RoomSummary & { owner: boolean }) | null {
    return this.info
      ? { ...this.info, memberCount: this.memberCount, owner: this.ownedBy(account) }
      : null
  }

  /**
   * Whether a new WebSocket may open; `version` is the `v` query parameter, `ip` the network
   * address as addressKey keeps it (null when unknown: not limited). At most ROOM_CONNECT_RATE
   * upgrades per address (I1): over it CloseCode.rateLimited, which the browser does not retry.
   */
  admit(version: string | null, ip: string | null = null, agent = false): Admission {
    // A desktop agent's socket has a version of its own (N2, shared/control.ts)
    if (version !== String(agent ? AGENT_PROTOCOL_VERSION : PROTOCOL_VERSION)) {
      return { ok: false, code: CloseCode.versionMismatch, reason: 'protocol version mismatch' }
    }
    if (ip !== null && !this.connectRate.take(ip, this.deps.now())) {
      this.deps.offence?.(null, ip, 'connectLimit')
      return { ok: false, code: CloseCode.rateLimited, reason: 'too many connections' }
    }
    // A member coming back to a meeting the host ended learns it ended, not that it is gone (F3)
    if (!this.info && this.ended) return { ok: false, code: CloseCode.ended, reason: 'ended' }
    if (!this.info) return { ok: false, code: CloseCode.roomNotFound, reason: 'room not found' }
    if (this.conns.size >= MAX_MEMBERS + MAX_PENDING_SOCKETS)
      return { ok: false, code: CloseCode.roomFull, reason: 'room full' }
    return { ok: true }
  }

  /** Whether the host ended this meeting less than ENDED_TOMBSTONE_MS ago (F3) */
  get ended(): boolean {
    return this.endedUntil !== null && this.endedUntil > this.deps.now()
  }

  /**
   * An admitted socket is live; it has JOIN_TIMEOUT_MS to send `join`. `ip` is its network
   * address as worker/password.ts addressKey keeps it (null when unknown)
   */
  opened(
    connId: string,
    ip: string | null = null,
    account: string | null = null,
    agent = false,
  ): void {
    const now = this.deps.now()
    this.conns.set(connId, {
      member: null,
      openedAt: now,
      lastSeen: now,
      ip,
      joining: false,
      account,
      agent,
    })
    this.reschedule()
  }

  /**
   * The socket closed (or errored) without `leave` and without the server closing it: its member
   * starts reconnecting. A no-op for a connection already gone.
   */
  closed(connId: string): void {
    const conn = this.conns.get(connId)
    if (!conn) return
    this.conns.delete(connId)
    this.socketRate.forget(connId)
    // The last socket gone: nothing keeps the object awake, so the strokes are stored now (J2)
    if (this.conns.size === 0) {
      this.flushAnnotations()
      this.saveBoard()
    }
    if (conn.member === null) {
      this.reschedule()
      return
    }
    this.markAway(conn.member)
    this.publish()
  }

  /**
   * A text frame on a connection. Returns a promise only while a `join` waits for the password
   * check or a `setPassword` for its digest (F3); the adapter awaits it.
   */
  message(connId: string, raw: string): void | Promise<void> {
    const conn = this.conns.get(connId)
    if (!conn) return
    // Every frame counts (I1): a flood closes the socket, its member reconnects only by reloading
    if (!this.socketRate.take(connId, this.deps.now())) {
      this.deps.offence?.(connId, conn.ip, 'flood')
      this.conns.delete(connId)
      this.socketRate.forget(connId)
      if (conn.member !== null) {
        this.markAway(conn.member)
        this.publish()
      }
      this.deps.sockets.close(connId, CloseCode.rateLimited, 'too many messages')
      return
    }
    this.heartbeat(connId, this.deps.now())
    if (raw === HEARTBEAT_PING) return
    // A desktop agent's socket takes agent messages only, a browser's never (N2, threat model T-02)
    if (conn.agent) {
      this.agentMessage(connId, conn, raw)
      return
    }
    const message = parseClientMessage(raw)
    // Before `join` nothing else is accepted, and `join` only once (also while one is checked)
    if (!message || (conn.member === null) !== (message.t === 'join') || conn.joining) {
      this.deps.sockets.send(connId, { t: 'error', code: 'bad_message' })
      return
    }
    switch (message.t) {
      case 'join':
        return this.join(connId, message)
      case 'resync':
        // Someone waiting never gets the view (F2): its lobby again instead
        if (this.isWaiting(conn.member!)) {
          this.lobbies.delete(conn.member!)
          this.updateLobbies()
          return
        }
        this.deps.sockets.send(connId, {
          t: 'snapshot',
          rev: this.rev,
          state: this.sent ?? this.view(),
        })
        return
      case 'leave':
        // A host leaving may name who takes over (F3, e1-t17); assignHost decides otherwise
        if (message.host !== undefined) this.handOver(conn.member!, message.host)
        this.conns.delete(connId)
        this.remove(conn.member!)
        this.deps.sockets.close(connId, 1000, 'left')
        this.publish()
        return
      case 'tracks':
        this.setTracks(conn.member!, message)
        return
      case 'stats':
        this.countStats(conn.member!, message)
        return
      case 'rename':
        this.setMember(conn.member!, { name: message.name })
        this.publish()
        return
      case 'renameRoom':
        this.renameRoom(connId, conn.member!, message.name)
        return
      case 'share':
        this.startShare(connId, conn.member!)
        return
      case 'unshare':
        this.endShare(conn.member!)
        return
      case 'chat':
        this.addChat(connId, conn.member!, message.text)
        return
      case 'host':
        return this.control(connId, conn.member!, message)
      case 'spotlight':
        this.spotlight(connId, conn.member!, message.memberId)
        return
      case 'react':
        this.react(conn.member!, message.emoji)
        return
      case 'hand':
        this.raiseHand(connId, conn.member!, message.up)
        return
      case 'signal':
        this.setSignal(conn.member!, message.level)
        return
      case 'record':
        this.record(connId, conn.member!, message.on)
        return
      case 'consent':
        this.consent(conn.member!)
        return
      case 'annotate':
        this.annotate(connId, conn.member!, message.share, message.ops)
        return
      case 'clearAnnotations':
        this.clearAnnotations(connId, conn.member!, message.share, message.by)
        return
      case 'whiteboard':
        this.setWhiteboard(connId, conn.member!, message.open)
        return
      case 'pollStart':
        this.startPoll(connId, conn.member!, message)
        return
      case 'pollVote':
        this.votePoll(connId, conn.member!, message.poll, message.choices)
        return
      case 'pollEnd':
        this.endPoll(connId, conn.member!, message.poll)
        return
      case 'timer':
        if (!this.mayInteract(connId, conn.member!, 'timer')) return
        this.interact.setTimer(
          message.seconds === null
            ? null
            : { endsAt: this.deps.now() + message.seconds * 1000, seconds: message.seconds },
        )
        this.interactChanged()
        return
      case 'agenda':
        if (!this.mayInteract(connId, conn.member!, 'agenda')) return
        this.interact.setAgenda(message.items)
        this.interactChanged()
        return
      case 'agendaCurrent':
        if (!this.mayInteract(connId, conn.member!, 'agenda')) return
        // Out of range: the list changed under the button, and the patch saying so is on its way
        if (this.interact.setAgendaCurrent(message.index)) this.interactChanged()
        return
      case 'breakoutOpen':
        if (!this.mayInteract(connId, conn.member!, 'breakout')) return
        this.openBreakout(connId, conn.member!, message)
        return
      case 'breakoutMove':
        if (!this.mayInteract(connId, conn.member!, 'breakout')) return
        this.moveToGroup(connId, conn.member!, message.memberId, message.group)
        return
      case 'breakoutBroadcast':
        if (!this.mayInteract(connId, conn.member!, 'breakout')) return
        if (!this.breakout.on) {
          this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
          return
        }
        this.breakout.broadcast({
          text: message.text,
          by: this.members.get(conn.member!)!.name,
          at: this.deps.now(),
        })
        this.breakoutChanged()
        return
      case 'breakoutClose':
        if (!this.mayInteract(connId, conn.member!, 'breakout')) return
        // No rooms open, or a recall already under way: someone else just did it, and the patch
        // saying so is on its way
        this.recall(conn.member!, (now) => this.breakout.close(now, message.now))
        return
      case 'pairStart':
        this.pairStart(connId, conn.member!)
        return
      case 'pairCancel':
        if (this.pairing.cancel(conn.member!)) this.pairingChanged()
        this.deps.sockets.send(connId, { t: 'pairCode', code: null, expiresAt: null })
        return
      case 'agentRemove':
        this.agentRemove(connId, conn.member!, message.memberId)
        return
    }
  }

  // ── Desktop agents (N2, e9-t02; docs/PRD/f-remote-control-security.md §5.1) ──────────────────

  /** A desktop agent member (`Member.agent`), not a person */
  private isAgent(memberId: string | null): boolean {
    return memberId !== null && this.members.get(memberId)?.agent !== undefined
  }

  /** The agent members whose pairing code `owner` issued (one at most) */
  private agentsOf(owner: string): string[] {
    const found: string[] = []
    for (const member of this.members.values()) {
      if (member.agent?.owner === owner) found.push(member.id)
    }
    return found
  }

  /** The members holding an open pairing code */
  private pairingOwners(): string[] {
    return this.pairing.stored.codes.map((entry) => entry.owner)
  }

  private post(connId: string, message: AgentServerMessage): void {
    this.deps.sockets.post?.(connId, message)
  }

  /** Tells the member, if connected, that its code is gone (used, voided or run out) */
  private codeGone(memberId: string): void {
    const conn = this.sessions.get(memberId)?.conn
    if (conn) this.deps.sockets.send(conn, { t: 'pairCode', code: null, expiresAt: null })
  }

  private savePairing(): void {
    this.deps.storage.savePairing?.(this.pairing.empty ? null : this.pairing.stored)
  }

  private pairingChanged(): void {
    this.savePairing()
    this.reschedule()
  }

  /**
   * `pairStart`: a new one-time code for this member (worker/roles.ts `pairComputer`, within
   * INTERACT_RATE), replacing any it had; `pair_busy` while its computer is in the room
   */
  private pairStart(connId: string, memberId: string): void {
    if (!this.mayInteract(connId, memberId, 'pairComputer')) return
    if (this.agentsOf(memberId).length > 0) {
      this.deps.sockets.send(connId, { t: 'error', code: 'pair_busy' })
      return
    }
    const { code, expiresAt } = this.pairing.issue(memberId, this.deps.now())
    this.pairingChanged()
    this.deps.sockets.send(connId, { t: 'pairCode', code, expiresAt })
  }

  /**
   * `agentRemove` (「這不是我」, 「中斷我的電腦」): only the member who paired the computer, and only
   * their own; the agent is closed with CloseCode.removed like anyone a host removes (no ban: an
   * agent has no browser id, and pairing again needs a new code anyway)
   */
  private agentRemove(connId: string, memberId: string, targetId: string): void {
    const target = this.members.get(targetId)
    if (!this.allowed(memberId, 'pairComputer') || target?.agent?.owner !== memberId) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    this.removeMember(targetId)
  }

  /** A frame on a desktop agent's socket: `agentHello` first and only once, then its media */
  private agentMessage(connId: string, conn: Connection, raw: string): void {
    const message = parseAgentMessage(raw)
    if (!message || (conn.member === null) !== (message.t === 'agentHello')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'bad_message' })
      return
    }
    switch (message.t) {
      case 'agentHello':
        this.agentHello(connId, conn, message)
        return
      case 'tracks':
        this.setTracks(conn.member!, message)
        return
      case 'share':
        this.startShare(connId, conn.member!)
        return
      case 'unshare':
        this.endShare(conn.member!)
        return
      case 'leave':
        this.conns.delete(connId)
        this.remove(conn.member!)
        this.deps.sockets.close(connId, 1000, 'left')
        this.publish()
        return
      default:
        // `controlAnswer`, `controlStop`, `controlMute`: remote control comes in N3
        this.deps.sockets.send(connId, { t: 'error', code: 'bad_message' })
    }
  }

  /**
   * `agentHello`. With a token: the agent comes back within RECONNECT_GRACE_MS as the same member
   * (an unknown token, or a browser's, closes the socket with CloseCode.passwordRequired: pair
   * again). With a pairing code: a network out of tries (PAIRING_NETWORK_FAIL_RATE) is closed with
   * CloseCode.rateLimited before the code is looked at; a wrong code closes the socket at once with
   * CloseCode.passwordWrong (one guess per upgrade) and counts against the network and the room; the
   * right one makes the agent a member of the room: no password, lock or waiting room (the code's
   * owner vouched for it), but MAX_MEMBERS holds, and it lands in its owner's breakout room.
   */
  private agentHello(connId: string, conn: Connection, hello: AgentHelloMessage): void {
    if (hello.token !== null) {
      this.agentBack(connId, conn, hello.token)
      return
    }
    const now = this.deps.now()
    if (this.pairing.blocked(conn.ip, now)) {
      this.deps.offence?.(connId, conn.ip, 'connectLimit')
      this.refuse(connId, CloseCode.rateLimited, 'pairing refused')
      return
    }
    // Before the code is looked at: a full room tells nothing about it, and keeps it for later
    if (this.members.size >= MAX_MEMBERS) {
      this.refuse(connId, CloseCode.roomFull, 'room full')
      return
    }
    const ownerId = this.pairing.take(hello.pairing!, now)
    if (ownerId === null) {
      const { voided } = this.pairing.fail(conn.ip, now)
      this.pairingChanged()
      for (const id of voided) {
        this.notify(id, { t: 'notice', notice: 'pairingVoided', by: id })
        this.codeGone(id)
      }
      this.refuse(connId, CloseCode.passwordWrong, 'wrong pairing code')
      return
    }
    this.pairingChanged()
    this.codeGone(ownerId)
    const owner = this.members.get(ownerId)
    // Never expected: a member's code goes when it leaves, and none is issued while it has a computer
    if (!owner || !this.inRoomMember(ownerId) || this.agentsOf(ownerId).length > 0) {
      this.refuse(connId, CloseCode.passwordWrong, 'pairing code void')
      return
    }
    const memberId = this.deps.newMemberId()
    const token = this.deps.newToken()
    this.members.set(memberId, {
      id: memberId,
      name: hello.device,
      role: 'participant',
      joinedAt: now,
      reconnecting: false,
      tracks: [],
      hand: null,
      signal: null,
      mayRecord: false,
      agent: { owner: ownerId, device: hello.device, platform: hello.platform },
    })
    this.sessions.set(memberId, {
      token,
      conn: connId,
      awaySince: null,
      sfu: null,
      client: null,
      pairedBy: { id: ownerId, name: owner.name },
    })
    this.byToken.set(token, memberId)
    conn.member = memberId
    // In its owner's breakout room, if they are in one (L3)
    const group = this.groupOf(ownerId)
    if (group !== null && this.breakout.move(memberId, group)) this.saveBreakout()
    this.publish()
    this.agentWelcome(connId, memberId)
    this.notify(ownerId, { t: 'notice', notice: 'agentPaired', by: memberId })
  }

  /** `agentHello` with a token: the agent member it belongs to, taken over by this socket */
  private agentBack(connId: string, conn: Connection, token: string): void {
    const memberId = this.byToken.get(token)
    if (memberId === undefined || !this.isAgent(memberId)) {
      this.refuse(connId, CloseCode.passwordRequired, 'unknown token')
      return
    }
    const session = this.sessions.get(memberId)!
    if (session.conn !== null && session.conn !== connId) {
      this.conns.delete(session.conn)
      this.deps.sockets.close(session.conn, CloseCode.replaced, 'session taken over')
    }
    session.conn = connId
    session.awaySince = null
    conn.member = memberId
    this.setMember(memberId, { reconnecting: false })
    this.publish()
    this.agentWelcome(connId, memberId)
  }

  /** The agent is in the room: who paired it and the room's name, for its local confirmation */
  private agentWelcome(connId: string, memberId: string): void {
    const session = this.sessions.get(memberId)!
    this.post(connId, {
      t: 'agentWelcome',
      memberId,
      token: session.token,
      owner: session.pairedBy?.id ?? '',
      ownerName: session.pairedBy?.name ?? '',
      // null: the agent shows the default name made from `createdBy`, as the browsers do
      roomName: this.info!.name,
      createdBy: this.info!.createdBy,
    })
  }

  /**
   * The `pairing` job: codes that ran out are gone (their members get `pairCode` null), and old
   * wrong codes stop counting
   */
  private expirePairing(): void {
    const expired = this.pairing.prune(this.deps.now())
    this.savePairing()
    for (const id of expired) this.codeGone(id)
  }

  /** The breakout rooms changed: stored, and everyone sees it */
  private breakoutChanged(): void {
    this.saveBreakout()
    this.publish()
  }

  private saveBreakout(): void {
    this.deps.storage.saveBreakout?.(this.breakout.stored)
  }

  /** The breakout room a member is in (L3); null for the main room */
  private groupOf(memberId: string | null): string | null {
    return memberId === null ? null : this.breakout.groupOf(memberId)
  }

  /**
   * `breakoutOpen` (L3, e10-t04): one set of rooms at a time. Only members in the meeting are
   * placed (someone who left, or waits, stays out: the panel was out of date); everyone else is in
   * the main room. What belongs to the whole meeting ends first, while everyone is still in the
   * main room: the poll (its results go to the main room's chat), every recording (a recorder would
   * hear only their own room, and the consent clock would count people in every room), the
   * spotlight, and the whiteboard leaves the stage (its strokes stay for after the recall).
   */
  private openBreakout(connId: string, actor: string, message: BreakoutOpenMessage): void {
    if (this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'breakout_active' })
      return
    }
    const poll = this.interact.pollView
    if (poll) this.finishPoll(actor, poll.id)
    for (const recorder of Object.keys(this.info!.recordings)) {
      this.notify(recorder, { t: 'notice', notice: 'recordingStopped', by: actor })
      this.endRecording(recorder)
    }
    const assign = Object.fromEntries(
      Object.entries(message.assign).filter(([id]) => this.inRoomMember(id)),
    )
    const shares = this.info!.shares
    this.breakout.open(message.groups, assign, message.minutes, this.deps.now())
    if (this.info!.spotlight !== null || this.info!.whiteboard !== null) {
      this.info = { ...this.info!, spotlight: null, whiteboard: null }
      this.deps.storage.saveRoom(this.info)
    }
    this.regrouped(actor, new Map(this.breakout.assigned.map((id) => [id, null])), shares)
  }

  /**
   * `breakoutMove` (L3): a member (the actor too: that is how a host enters a room) into a room or
   * back to the main room. Refused with `forbidden` when no rooms are open, the member is not in
   * the meeting or the room does not exist: each means the panel was out of date.
   *
   * Pulls the member already has across the old boundary are not torn down here: the SFU proxy
   * only refuses new ones (sfuAccess). An honest browser drops them as its scoped view changes; a
   * modified one keeps what it had until it renegotiates. Accepted for a room among friends.
   */
  private moveToGroup(connId: string, actor: string, memberId: string, group: string | null): void {
    if (!this.inRoomMember(memberId) || !this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    const from = this.breakout.groupOf(memberId)
    if (from === group) return
    const shares = this.info!.shares
    if (!this.breakout.move(memberId, group)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    this.regrouped(actor, new Map([[memberId, from]]), shares)
  }

  /**
   * A recall (`breakoutClose`, or the clock; `by` is who, or null for the clock): the grace
   * started, or everyone who was in a room is back in the main room
   */
  private recall(by: string | null, step: (now: number) => BreakoutPhase | null): void {
    const before = new Map(this.breakout.assigned.map((id) => [id, this.breakout.groupOf(id)]))
    const shares = this.info!.shares
    const phase = step(this.deps.now())
    if (phase === 'closing') this.breakoutChanged()
    else if (phase === 'ended') this.regrouped(by, before, shares, true)
  }

  /** The `breakout` job: the time ran out (the recall starts), or the recall's grace did */
  private tickBreakout(): void {
    this.recall(null, (now) => this.breakout.tick(now))
  }

  /**
   * Members changed rooms (`moved`: each one's room before; null the main room): stored, too many
   * shares in a room stopped, everyone sees it, then what follows the room is sent again. `shares`
   * are the shares before, so a sharer whose share just stopped still counts as having moved one.
   */
  private regrouped(
    by: string | null,
    moved: ReadonlyMap<string, string | null>,
    shares: RoomInfo['shares'],
    everyone = false,
  ): void {
    this.saveBreakout()
    this.fitShares(by)
    this.publish()
    this.regroup(moved, shares, everyone)
  }

  /**
   * MAX_SHARES per breakout room (L3): a move or the end of the rooms may bring more together. The
   * newest go (shareOrder), each sharer told who stopped it (themselves when it was the clock)
   */
  private fitShares(by: string | null): void {
    const counts = new Map<string | null, number>()
    for (const { memberId } of shareOrder(this.info!.shares)) {
      const group = this.groupOf(memberId)
      const count = (counts.get(group) ?? 0) + 1
      counts.set(group, count)
      if (count <= MAX_SHARES) continue
      this.notify(memberId, { t: 'notice', notice: 'shareStopped', by: by ?? memberId })
      this.endShare(memberId)
    }
  }

  /**
   * After members changed rooms: each gets the chat of the room it is in now, replacing what it had
   * (`reset`, and `regroup`: none of it is new), and the strokes on that room's shares. A share
   * follows its sharer, so a sharer's old and new rooms both get the strokes again; the end of the
   * rooms (`everyone`) sends them to every connection.
   */
  private regroup(
    moved: ReadonlyMap<string, string | null>,
    shares: RoomInfo['shares'],
    everyone: boolean,
  ): void {
    const rooms = new Set<string | null>()
    for (const [id, from] of moved) {
      if (!shares[id]) continue
      rooms.add(from)
      rooms.add(this.groupOf(id))
    }
    for (const id of moved.keys()) {
      const conn = this.sessions.get(id)?.conn ?? null
      if (conn !== null && this.inRoomMember(id) && !this.isAgent(id)) {
        this.sendChatHistory(conn, true)
      }
    }
    for (const [conn, { member, agent }] of this.conns) {
      if (member === null || agent || !this.inRoomMember(member)) continue
      if (everyone || moved.has(member) || rooms.has(this.groupOf(member))) {
        this.sendAnnotations(conn)
      }
    }
  }

  /**
   * Whether the member may do `action` now (worker/roles.ts, CLAUDE.md rule 1) and is within
   * INTERACT_RATE; answers `forbidden` or `rate_limited` otherwise (L5)
   */
  private mayInteract(connId: string, memberId: string, action: Action): boolean {
    if (!this.allowed(memberId, action)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return false
    }
    if (!this.interactRate.take(memberId, this.deps.now())) {
      this.deps.sockets.send(connId, { t: 'error', code: 'rate_limited' })
      return false
    }
    return true
  }

  private interactChanged(): void {
    this.deps.storage.saveInteract?.(this.interact.stored)
    this.publish()
  }

  /**
   * `pollStart` (L5, e5-t07): one poll at a time, at most POLL_START_RATE per member. Its id is the
   * room's clock; two in the same millisecond would need the first to have ended, so no answer can
   * reach the wrong one.
   */
  private startPoll(connId: string, memberId: string, message: PollStartMessage): void {
    if (!this.allowed(memberId, 'poll')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    // One poll for the whole meeting would reach into every breakout room (L3)
    if (this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'breakout_active' })
      return
    }
    if (this.interact.pollOn) {
      this.deps.sockets.send(connId, { t: 'error', code: 'poll_active' })
      return
    }
    const now = this.deps.now()
    if (!this.pollRate.take(memberId, now)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'rate_limited' })
      return
    }
    const { question, options, multi, anonymous } = message
    const by = this.members.get(memberId)!.name
    this.interact.startPoll({ id: now, by, question, options, multi, anonymous })
    this.interactChanged()
  }

  /**
   * `pollVote` (L5, e5-t07): the member's answer, replacing an earlier one. Answers that do not fit
   * the poll are `bad_message`; a poll that just ended is no error. The member's own answer comes
   * back to them alone: the view does not say on an anonymous poll.
   */
  private votePoll(connId: string, memberId: string, poll: number, choices: number[]): void {
    if (!this.mayInteract(connId, memberId, 'votePoll')) return
    const name = this.members.get(memberId)!.name
    const outcome = this.interact.vote(poll, memberId, name, choices)
    if (!outcome.ok) {
      if (outcome.reason === 'invalid') {
        this.deps.sockets.send(connId, { t: 'error', code: 'bad_message' })
      } else if (outcome.reason === 'full') {
        this.deps.sockets.send(connId, { t: 'error', code: 'rate_limited' })
      }
      return
    }
    if (outcome.changed) this.interactChanged()
    this.sendOwnVote(connId, memberId)
  }

  /** What the member answered to the poll on now, if anything (L5) */
  private sendOwnVote(connId: string, memberId: string): void {
    const vote = this.interact.voteOf(memberId)
    if (vote) this.deps.sockets.send(connId, { t: 'pollVoted', ...vote })
  }

  /**
   * `pollEnd` (L5, e5-t07): the poll leaves the view and its results go to the chat, a message from
   * who ended it, like a file (I5). A poll already over is no error: someone else just ended it.
   */
  private endPoll(connId: string, memberId: string, poll: number): void {
    if (!this.mayInteract(connId, memberId, 'poll')) return
    this.finishPoll(memberId, poll)
  }

  /** Ends the poll `poll`, if it is the one on now: its results go to the chat, from `memberId` */
  private finishPoll(memberId: string, poll: number): void {
    const result = this.interact.endPoll(poll)
    if (!result) return
    this.interactChanged()
    this.postChat({
      id: ++this.chatId,
      from: memberId,
      name: this.members.get(memberId)!.name,
      text: result.question,
      at: this.deps.now(),
      poll: result,
    })
  }

  /** Whose a layer is (J3): the sharer's their share, the whiteboard whoever opened it */
  private ownsLayer(memberId: string, share: string): boolean {
    return isWhiteboard(share) ? this.info?.whiteboard?.by === memberId : share === memberId
  }

  /** Who may draw on a layer (J3, e7-t05): the room's policy and the table (worker/roles.ts) */
  private mayDrawOn(memberId: string, share: string): boolean {
    const member = this.members.get(memberId)
    if (!member || !this.info) return false
    return mayDraw(this.info.annotationPolicy, member.role, this.ownsLayer(memberId, share))
  }

  /**
   * `annotate` (J2, e7-t03, e7-t04): one frame of what a member did to a layer. Decided here
   * (CLAUDE.md rule 1): the member is in the meeting, the layer exists, what they draw the policy
   * allows (J3), a stroke they change or take away is theirs, and they are within the limits
   * (shared/annotation-limits.ts). Taking back one's own marks needs no permission to draw, so a
   * policy turned off mid-stroke leaves nothing half-drawn. What is accepted goes to everyone else
   * in the room as one frame; the sender hears only about what it must take back. A share that just
   * stopped is not an error: the sender is told the layer is gone.
   */
  private annotate(connId: string, memberId: string, share: string, ops: AnnotationOp[]): void {
    const now = this.deps.now()
    const added = ops.flatMap((op) => (op.op === 'add' ? [op.stroke.id] : []))
    const refuse = (code: 'forbidden' | 'annotation_limit', ids: readonly string[]) => {
      this.deps.sockets.send(connId, { t: 'error', code })
      if (ids.length === 0) return
      this.sendLayer([connId], share, null, ids.map((id) => ({ op: 'remove', id })))
    }
    if (!this.allowed(memberId, 'annotate')) {
      refuse('forbidden', added)
      return
    }
    if (isWhiteboard(share)) {
      // A closed board keeps its strokes: refused, but not "the layer is gone"
      if (!this.info?.whiteboard) {
        refuse('forbidden', added)
        return
      }
    } else if (!this.info?.shares[share]) {
      this.sendLayer([connId], share, null, [{ op: 'clear' }])
      return
    } else if (!this.seesLayer(memberId, share)) {
      // A share in another breakout room (L3): not this member's to draw on
      refuse('forbidden', added)
      return
    }
    if (!this.annotationFrames.take(memberId, now)) {
      refuse('annotation_limit', added)
      return
    }
    const onward: AnnotationOp[] = []
    const back: AnnotationOp[] = []
    const fellOut = (ids: readonly string[]) => {
      for (const id of ids) {
        onward.push({ op: 'remove', id })
        back.push({ op: 'remove', id })
      }
    }
    /** The sender must lose this stroke, and if the room holds it, so must everyone else */
    const takeBack = (id: string) => {
      back.push({ op: 'remove', id })
      if (this.annotations.remove(share, memberId, id)) onward.push({ op: 'remove', id })
    }
    const drawing = this.mayDrawOn(memberId, share)
    let limited = false
    let denied = false
    const whiteboard = isWhiteboard(share)
    for (const op of ops) {
      if (!drawing && (op.op === 'add' || op.op === 'update' || op.op === 'laser')) {
        denied = true
        if (op.op === 'add') takeBack(op.stroke.id)
        continue
      }
      switch (op.op) {
        case 'add': {
          const { id } = op.stroke
          const stroke: Stroke = { ...op.stroke, by: memberId }
          // Cleared while it was still being drawn (J4): it does not come back at the end of it
          if (this.annotations.refusedAsCleared(share, id, op.live === true)) {
            back.push({ op: 'remove', id })
            break
          }
          // Past a board's limits (J3); someone else's id cannot be asked about, `put` refuses it
          if (this.annotations.overflows(share, stroke)) {
            limited = true
            takeBack(id)
            break
          }
          if (!this.annotations.has(share, id) && !this.annotationStrokes.take(memberId, now)) {
            limited = true
            back.push({ op: 'remove', id })
            break
          }
          const put = this.annotations.put(share, stroke, op.live === true)
          // Someone else's id: never a stroke of ours to replace
          if (!put) {
            back.push({ op: 'remove', id })
            break
          }
          onward.push(op.live ? { op: 'add', stroke, live: true } : { op: 'add', stroke })
          fellOut(put.evicted)
          break
        }
        case 'update': {
          const put = this.annotations.update(share, memberId, op.id, op.at, op.points)
          if (put) {
            onward.push(op)
            fellOut(put.evicted)
          }
          break
        }
        case 'remove':
          if (this.annotations.remove(share, memberId, op.id)) onward.push(op)
          break
        case 'clear':
          this.annotations.clearBy(share, memberId)
          onward.push({ op: 'clear', by: memberId })
          break
        case 'laser':
          onward.push(op)
          break
      }
    }
    if (limited) this.deps.sockets.send(connId, { t: 'error', code: 'annotation_limit' })
    if (denied) this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
    if (back.length > 0) this.sendLayer([connId], share, null, back)
    if (whiteboard && onward.some((op) => op.op !== 'laser')) this.boardChanged()
    if (onward.length > 0) {
      const others = this.layerConns(share).filter((id) => id !== connId)
      this.sendLayer(others, share, memberId, onward)
    }
    this.flushAnnotationsLater()
  }

  private sendLayer(
    conns: readonly string[],
    share: string,
    by: string | null,
    ops: AnnotationOp[],
  ): void {
    if (conns.length === 0) return
    const frame: ServerMessage = { t: 'annotation', share, by, ops }
    for (const id of conns) this.deps.sockets.send(id, frame)
  }

  /** A connection for each member in the meeting */
  private roomConns(): string[] {
    return [...this.conns].filter(([, conn]) => this.inRoom(conn)).map(([id]) => id)
  }

  /**
   * Whether a member has a layer (L3): the whiteboard is the whole meeting's, a share only its
   * sharer's breakout room's (a share layer's id is the sharer's member id)
   */
  private seesLayer(memberId: string | null, share: string): boolean {
    return isWhiteboard(share) || this.groupOf(share) === this.groupOf(memberId)
  }

  /** A connection for each member in the meeting who has the layer (L3) */
  private layerConns(share: string): string[] {
    return [...this.conns]
      .filter(([, conn]) => this.inRoom(conn) && this.seesLayer(conn.member, share))
      .map(([id]) => id)
  }

  /**
   * The strokes a member is sent whole (after a welcome, a move between breakout rooms, a saved
   * whiteboard arriving): the whiteboard and the shares of their own room only (L3). Still one
   * `reset` first and one `done` last, as RoomAnnotations.snapshot makes them.
   */
  private snapshotFor(memberId: string): AnnotationsMessage[] {
    const frames = this.annotations
      .snapshot()
      .filter((frame) => frame.share !== null && this.seesLayer(memberId, frame.share))
      .map(({ reset: _reset, done: _done, ...frame }): AnnotationsMessage => frame)
    if (frames.length === 0) frames.push({ t: 'annotations', share: null, strokes: [] })
    frames[0] = { ...frames[0], reset: true }
    frames[frames.length - 1] = { ...frames[frames.length - 1], done: true }
    return frames
  }

  /** Sends the connection its member's snapshot of the strokes */
  private sendAnnotations(connId: string): void {
    const conn = this.conns.get(connId)
    const memberId = conn?.member ?? null
    if (memberId === null || conn?.agent) return
    for (const frame of this.snapshotFor(memberId)) this.deps.sockets.send(connId, frame)
  }

  /**
   * `clearAnnotations` (J3, e7-t05; AC-7.3): a layer, or (`by`) one member's strokes on it, go for
   * everyone and from storage at once. Who may: shared/roles.ts mayClearLayer (a host, a co-host,
   * who owns the layer); it works with the policy off too, which is when it may matter most. Those
   * who lost something, and the sharer whose share it is, are told who did it.
   */
  private clearAnnotations(
    connId: string,
    memberId: string,
    share: string,
    by: string | null,
  ): void {
    const member = this.members.get(memberId)
    // A share in another breakout room (L3) is not there for this member
    const exists =
      isWhiteboard(share) ||
      (this.info?.shares[share] !== undefined && this.seesLayer(memberId, share))
    if (!member || !exists || !mayClearLayer(member.role, this.ownsLayer(memberId, share))) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    const authors = this.annotations.authors(share)
    const affected = new Set(by === null ? authors.keys() : authors.has(by) ? [by] : [])
    // Nothing of theirs there: nothing to do, nobody to tell
    if (affected.size === 0) return
    this.annotations.noteClearedWhileDrawn(share, by)
    if (by === null) this.annotations.clearShare(share)
    else this.annotations.clearBy(share, by)
    this.flushAnnotations()
    if (isWhiteboard(share)) this.boardChanged()
    this.sendLayer(this.layerConns(share), share, memberId, [
      by === null ? { op: 'clear' } : { op: 'clear', by },
    ])
    if (!isWhiteboard(share)) affected.add(share)
    affected.delete(memberId)
    affected.delete(PAST_AUTHOR)
    for (const id of affected) {
      this.notify(id, {
        t: 'notice',
        notice: 'annotationsCleared',
        by: memberId,
        layer: share,
        ...(by === null ? { all: true as const } : {}),
      })
    }
  }

  /**
   * `whiteboard` (J3, e7-t06): the room's board comes on the stage, or leaves it (its strokes stay:
   * only clearing or the meeting's end takes them). shared/roles.ts mayOpenBoard, mayCloseBoard
   */
  private setWhiteboard(connId: string, memberId: string, open: boolean): void {
    const member = this.members.get(memberId)
    if (!member || !this.info) return
    const board = this.info.whiteboard
    const allowed = open
      ? mayOpenBoard(this.info.annotationPolicy, member.role)
      : mayCloseBoard(member.role, board?.by === memberId)
    if (!allowed) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    // The room's one board would be every breakout room's stage (L3); closing it is always fine
    if (open && this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'breakout_active' })
      return
    }
    if (open === (board !== null)) return
    this.setRoom({ whiteboard: open ? { by: memberId, since: this.deps.now() } : null })
  }

  /** Writes the changed segments of strokes, at most every ANNOTATION_FLUSH_MS (J2) */
  private flushAnnotationsLater(): void {
    if (this.annotationsFlushing || !this.annotations.hasWrites || !this.deps.later) return
    this.annotationsFlushing = true
    this.deps.later(ANNOTATION_FLUSH_MS, () => {
      this.annotationsFlushing = false
      this.flushAnnotations()
    })
  }

  /** Writes the changed segments of strokes now */
  private flushAnnotations(): void {
    if (!this.annotations.hasWrites) return
    this.deps.storage.saveAnnotations?.(this.annotations.takeWrites())
  }

  /** A share stopped (or its member left): its layer goes, for everyone and in storage at once */
  private clearShareAnnotations(share: string): void {
    if (!this.annotations.clearShare(share)) return
    this.flushAnnotations()
    this.sendLayer(this.layerConns(share), share, null, [{ op: 'clear' }])
  }

  /** The strokes on a share, oldest first (for tests and the recorder's side of the room) */
  annotationsOf(share: string): readonly Stroke[] {
    return this.annotations.strokes(share)
  }

  /**
   * `consent` (I4, CLAUDE.md rule 4): the member agrees to every recording on now (not their
   * own); everyone sees it in `RecordingInfo.consented`. Someone waiting is not in the meeting yet:
   * nothing to agree to.
   */
  private consent(memberId: string): void {
    if (!this.inRoomMember(memberId)) return
    const recordings = this.info!.recordings
    let changed = false
    const next: Record<string, RecordingInfo> = {}
    for (const [id, entry] of Object.entries(recordings)) {
      if (id !== memberId && !entry.consented.includes(memberId)) {
        next[id] = { ...entry, consented: [...entry.consented, memberId] }
        changed = true
      } else next[id] = entry
    }
    if (!changed) return
    this.info = { ...this.info!, recordings: next }
    this.deps.storage.saveRoom(this.info)
    this.publish()
  }

  /**
   * When each connected member in the meeting must have agreed to the recordings on now (I4):
   * CONSENT_TIMEOUT_MS after the latest of the recording's start and their coming in. Someone
   * reconnecting is not counted (their clock starts again when they are back).
   */
  private consentDeadlines(): Map<string, number> {
    const due = new Map<string, number>()
    const recordings = Object.values(this.info?.recordings ?? {})
    if (recordings.length === 0) return due
    for (const member of this.members.values()) {
      // A desktop agent (N2) has nobody to ask: its screen is shared by the person at it, on purpose
      if (member.role === 'waiting' || member.reconnecting || member.agent) continue
      const cameIn = this.cameIn.get(member.id) ?? this.deps.now()
      for (const recording of recordings) {
        if (recording.memberId === member.id || recording.consented.includes(member.id)) continue
        const at = Math.max(recording.since, cameIn) + CONSENT_TIMEOUT_MS
        due.set(member.id, Math.min(due.get(member.id) ?? at, at))
      }
    }
    return due
  }

  /**
   * The `consent` job (I4): whoever has not agreed in time is treated as declining: closed with
   * CloseCode.recordingDeclined and removed at once (no ban; joining again asks again)
   */
  private expireConsent(): void {
    const now = this.deps.now()
    let changed = false
    for (const [id, at] of this.consentDeadlines()) {
      if (at > now) continue
      const conn = this.sessions.get(id)?.conn ?? null
      if (conn !== null) {
        this.conns.delete(conn)
        this.deps.sockets.close(conn, CloseCode.recordingDeclined, 'recording not agreed')
      }
      this.remove(id)
      changed = true
    }
    if (changed) this.publish()
  }

  /**
   * `record` (I4, e8-t02; CLAUDE.md rule 4): the member starts (`on`) or stops their own local
   * recording. Starting needs the host's `record` (worker/roles.ts) or the host's permission
   * (`Member.mayRecord`), and someone in the meeting (not waiting); refused with `forbidden`.
   * Everyone sees who records in `RoomInfo.recordings`; the recorder's browser starts when it
   * sees itself there. Stopping is always allowed (it only ends one's own).
   */
  private record(connId: string, memberId: string, on: boolean): void {
    const recordings = this.info!.recordings
    if (!on) {
      this.endRecording(memberId)
      return
    }
    if (!this.mayRecord(memberId)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    // A recorder would hear only their own breakout room, and consent would be asked of every room
    if (this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'breakout_active' })
      return
    }
    if (recordings[memberId]) return
    this.info = {
      ...this.info!,
      recordings: {
        ...recordings,
        [memberId]: { memberId, since: this.deps.now(), consented: [] },
      },
    }
    this.deps.storage.saveRoom(this.info)
    this.publish()
  }

  /** Whether the member may start recording: the host's role, or the host's permission (I4) */
  private mayRecord(memberId: string): boolean {
    const member = this.members.get(memberId)
    if (!member || member.role === 'waiting') return false
    // The owner turned recording off in this room (L5, e1-t18). Allowing it grants nothing
    if (this.info?.allowRecording === false) return false
    return this.allowed(memberId, 'record') || member.mayRecord
  }

  /** `memberId` no longer records (I4); everyone sees it. A no-op if it did not */
  private endRecording(memberId: string): boolean {
    const recordings = this.info?.recordings
    if (!recordings?.[memberId]) return false
    const { [memberId]: _ended, ...rest } = recordings
    this.info = { ...this.info!, recordings: rest }
    this.deps.storage.saveRoom(this.info)
    this.publish()
    return true
  }

  /**
   * `allowRecord` (I4): the host lets a member record (`on`) or takes it back; the member is
   * told first. Taking it back from someone who records stops that recording (they are told
   * `recordingStopped` too) unless they may record anyway (they are the host).
   */
  private allowRecord(by: string, memberId: string, on: boolean): void {
    const member = this.members.get(memberId)
    if (!member || member.role === 'waiting' || member.mayRecord === on) return
    this.notify(memberId, { t: 'notice', notice: on ? 'recordAllowed' : 'recordRevoked', by })
    this.setMember(memberId, { mayRecord: on })
    if (!on && this.info!.recordings[memberId] && !this.mayRecord(memberId)) {
      this.notify(memberId, { t: 'notice', notice: 'recordingStopped', by })
      if (this.endRecording(memberId)) return
    }
    this.publish()
  }

  /**
   * `react` (G3, e5-t03): to everyone in the room, the sender too (worker/roles.ts `react`), at
   * most REACTION_RATE per member. Nothing is kept. A refused or too-fast reaction is dropped
   * without an answer: nobody needs to be told a 👍 did not go out.
   */
  private react(memberId: string, emoji: Reaction): void {
    if (!this.allowed(memberId, 'react')) return
    if (!this.reactionRate.take(memberId, this.deps.now())) return
    const frame: ServerMessage = { t: 'reaction', from: memberId, emoji }
    // Only to the sender's own breakout room (L3): nobody elsewhere has their tile
    const group = this.groupOf(memberId)
    for (const [id, conn] of this.conns) {
      if (this.inRoom(conn) && this.groupOf(conn.member) === group) {
        this.deps.sockets.send(id, frame)
      }
    }
  }

  /**
   * `signal` (H2, e2-t13): the member's own connection level for everyone's nameplates. Not a
   * permission (it only says something about the sender), but someone waiting has no nameplate,
   * and over SIGNAL_RATE it is dropped without an answer, like a reaction.
   */
  private setSignal(memberId: string, level: SignalLevel): void {
    const member = this.members.get(memberId)
    if (!member || member.role === 'waiting' || member.signal === level) return
    if (!this.signalRate.take(memberId, this.deps.now())) return
    this.setMember(memberId, { signal: level })
    this.publish()
  }

  /**
   * `hand` (G3, e5-t04): the member raises or lowers their own hand (worker/roles.ts
   * `raiseHand`; refused with `forbidden` for someone waiting). A hand already up keeps its
   * place in the queue.
   */
  private raiseHand(connId: string, memberId: string, up: boolean): void {
    if (!this.allowed(memberId, 'raiseHand')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    const member = this.members.get(memberId)!
    if ((member.hand !== null) === up) return
    this.setMember(memberId, { hand: up ? this.deps.now() : null })
    this.publish()
  }

  /**
   * `spotlight` (G2, e4-t11): a host or co-host puts a member in everyone's main area, or ends it
   * (worker/roles.ts `spotlight`, CLAUDE.md rule 1). Refused with `forbidden` when the member may
   * not, or the target is not in the room (gone, or still waiting).
   */
  private spotlight(connId: string, memberId: string, targetId: string | null): void {
    if (
      !this.allowed(memberId, 'spotlight') ||
      (targetId !== null && !this.inRoomMember(targetId))
    ) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    // Everyone's main area is not one room's while the breakout rooms are open (L3)
    if (this.breakout.on) {
      this.deps.sockets.send(connId, { t: 'error', code: 'breakout_active' })
      return
    }
    if (this.info!.spotlight === targetId) return
    this.setRoom({ spotlight: targetId })
  }

  /** A member in the meeting (not one in the waiting room) */
  private inRoomMember(memberId: string): boolean {
    const member = this.members.get(memberId)
    return member !== undefined && member.role !== 'waiting'
  }

  /** Whether `memberId` may do `action` (to `targetId`), by worker/roles.ts */
  private allowed(memberId: string, action: Action, targetId: string | null = null): boolean {
    const actor = this.members.get(memberId)
    if (!actor) return false
    const target = targetId === null ? null : (this.members.get(targetId) ?? null)
    return authorize(memberId, actor.role, action, target)
  }

  /**
   * `host` (F1, e1-t07): a host control, allowed or not by worker/roles.ts (CLAUDE.md rule 1);
   * refused with `forbidden`. A target that already left is refused the same way (the panel
   * that showed it is out of date).
   */
  private control(connId: string, memberId: string, message: HostMessage): void | Promise<void> {
    const targetId = 'memberId' in message ? message.memberId : null
    if (!this.allowed(memberId, HOST_RULE[message.action], targetId)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    switch (message.action) {
      case 'setPassword':
        return this.setPassword(message.password)
      case 'setCohost':
        this.setCohost(memberId, message.memberId, message.on)
        return
      case 'allowRecord':
        this.allowRecord(memberId, message.memberId, message.on)
        return
      case 'stopRecording':
        // Only a recording that is on: the recorder's browser stops and saves it on the notice
        // (or on seeing itself gone from the list, whichever comes first)
        if (!this.info!.recordings[message.memberId]) return
        this.notify(message.memberId, { t: 'notice', notice: 'recordingStopped', by: memberId })
        this.endRecording(message.memberId)
        return
      case 'makeHost':
        if (!this.handOver(memberId, message.memberId)) {
          this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
          return
        }
        this.publish()
        return
      case 'annotationPolicy':
        // The owner turned annotation off in this room (L5, e1-t18): only /me turns it back on
        if (this.info!.allowAnnotation === false) {
          this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
          return
        }
        if (this.info!.annotationPolicy === message.policy) return
        this.setRoom({ annotationPolicy: message.policy })
        // Everyone is affected: who was drawing loses the tools, or gets them
        for (const id of this.members.keys()) {
          if (id === memberId || !this.inRoomMember(id)) continue
          this.notify(id, {
            t: 'notice',
            notice: 'annotationPolicy',
            by: memberId,
            policy: message.policy,
          })
        }
        return
      case 'lock':
        this.setRoom({ locked: message.on })
        return
      case 'waitingRoom':
        this.setRoom({ waitingRoom: message.on })
        // Nobody is left waiting behind a waiting room that is off (F2)
        if (!message.on) this.admitWaiting(this.waitingIds())
        return
      case 'admit':
        this.admitWaiting([message.memberId])
        return
      case 'admitAll':
        this.admitWaiting(this.waitingIds())
        return
      case 'deny':
        this.deny(message.memberId)
        return
      case 'muteMember':
        if (this.muteTrack(message.memberId, 'mic')) {
          this.notify(message.memberId, { t: 'notice', notice: 'muted', by: memberId })
        }
        this.publish()
        return
      case 'camOff':
        if (this.muteTrack(message.memberId, 'cam')) {
          this.notify(message.memberId, { t: 'notice', notice: 'camOff', by: memberId })
        }
        this.publish()
        return
      case 'stopShare':
        if (this.stopShare(memberId, message.memberId)) {
          this.notify(message.memberId, { t: 'notice', notice: 'shareStopped', by: memberId })
        }
        return
      case 'remove':
        this.removeMember(message.memberId)
        return
      case 'lowerHand':
        // Only a hand that is up: lowering one already down changes nothing and tells nobody
        if (this.members.get(message.memberId)?.hand == null) return
        this.setMember(message.memberId, { hand: null })
        this.notify(message.memberId, { t: 'notice', notice: 'handLowered', by: memberId })
        this.publish()
        return
      case 'muteAll':
        // Everyone the actor may mute: everyone ranked below (a host also mutes co-hosts)
        for (const id of [...this.members.keys()]) {
          if (!this.allowed(memberId, 'muteMember', id) || !this.muteTrack(id, 'mic')) continue
          this.notify(id, { t: 'notice', notice: 'muted', by: memberId, all: true })
        }
        this.publish()
        return
      case 'endMeeting':
        this.endMeeting()
        return
    }
  }

  /** Changes the room's switches (F2), password time (F3) or spotlight (G2), and tells everyone */
  private setRoom(
    changes: Partial<
      Pick<
        RoomInfo,
        | 'locked'
        | 'waitingRoom'
        | 'passwordSetAt'
        | 'spotlight'
        | 'annotationPolicy'
        | 'whiteboard'
        | 'startMuted'
        | 'allowAnnotation'
        | 'allowRecording'
      >
    >,
  ): void {
    this.info = { ...this.info!, ...changes }
    this.deps.storage.saveRoom(this.info)
    this.publish()
  }

  /**
   * `setPassword` (F3, e1-t15): a new password (already normalized), kept as a salted digest, or
   * none (null). Who is in the room or waiting stays; only someone new is asked for it. When two
   * arrive close together the later one wins even if its digest is ready first.
   */
  private async setPassword(password: string | null): Promise<void> {
    const seq = ++this.passwordSeq
    const record = password === null ? null : await hashPassword(password)
    if (seq !== this.passwordSeq || !this.info) return
    this.password = record
    this.deps.storage.savePassword(record)
    this.setRoom({ passwordSetAt: record === null ? null : this.deps.now() })
  }

  /** Whether `memberId` is in the meeting and connected: someone who can take a role (F3) */
  private present(memberId: string): boolean {
    const member = this.members.get(memberId)
    // A desktop agent (N2) never takes a role
    return !!member && member.role !== 'waiting' && !member.reconnecting && !member.agent
  }

  /**
   * `setCohost` (F3, e1-t16): a participant becomes a co-host (`on`) or a co-host a participant
   * again; nothing else changes. The member is told first (`notice`), then everyone sees it.
   */
  private setCohost(by: string, memberId: string, on: boolean): void {
    const member = this.members.get(memberId)
    // A desktop agent (N2) runs nothing: it stays a participant
    if (!member || member.agent || member.role !== (on ? 'participant' : 'cohost')) return
    this.notify(memberId, { t: 'notice', notice: on ? 'madeCohost' : 'cohostRevoked', by })
    this.setMember(memberId, { role: on ? 'cohost' : 'participant' })
    this.publish()
  }

  /**
   * `makeHost` (F3, e1-t16), or a host leaving with `leave.host` (e1-t17): `to` becomes the host
   * and `from` a co-host. Only from the host (worker/roles.ts `makeHost`) to a connected member
   * in the meeting; false otherwise. The new host is told first; the caller publishes.
   */
  private handOver(from: string, to: string): boolean {
    if (!this.allowed(from, 'makeHost', to) || !this.present(to)) return false
    this.notify(to, { t: 'notice', notice: 'madeHost', by: from })
    this.setMember(from, { role: 'cohost' })
    this.setMember(to, { role: 'host' })
    return true
  }

  private isWaiting(memberId: string): boolean {
    return this.members.get(memberId)?.role === 'waiting'
  }

  /** Who waits, in the queue's order */
  private waitingIds(): string[] {
    return waitingQueue(this.waitingView()).map((entry) => entry.id)
  }

  /**
   * `admit` / `admitAll` (F2, e1-t10): each one still waiting becomes a participant (joined now,
   * for the AC-1.3 handoff order) and, if connected, gets its `welcome` and the chat history
   * right after everyone else's patch. Someone no longer waiting (admitted by another co-host,
   * or gone) is skipped: the panel that showed them was out of date.
   */
  private admitWaiting(ids: readonly string[]): void {
    const now = this.deps.now()
    const admitted: string[] = []
    for (const id of ids) {
      if (!this.isWaiting(id)) continue
      this.setMember(id, { role: 'participant', joinedAt: now })
      this.lobbies.delete(id)
      admitted.push(id)
    }
    if (admitted.length === 0) return
    const conns = new Set<string>()
    for (const id of admitted) {
      const conn = this.sessions.get(id)?.conn
      if (conn) conns.add(conn)
    }
    this.publish(conns)
    for (const id of admitted) {
      const conn = this.sessions.get(id)?.conn
      if (!conn) continue
      this.welcome(conn, id)
      this.tellStartMuted(id)
    }
  }

  /**
   * `deny` (F2): the person waiting is closed with CloseCode.denied and forgotten (its token
   * too), and its browser cannot ask again for DENY_COOLDOWN_MS (a longer ban, from a removal,
   * stays as it is).
   */
  private deny(memberId: string): void {
    if (!this.isWaiting(memberId)) return
    const session = this.sessions.get(memberId)!
    if (session.client !== null && this.banned(session.client) === null) {
      this.ban(session.client, 'denied')
    }
    if (session.conn !== null) {
      this.conns.delete(session.conn)
      this.deps.sockets.close(session.conn, CloseCode.denied, 'denied')
    }
    this.remove(memberId)
    this.publish()
  }

  /**
   * The `waiting` job (F2): whoever has waited WAIT_TIMEOUT_MS is closed with
   * CloseCode.waitExpired and forgotten.
   */
  private expireWaiting(): void {
    const now = this.deps.now()
    let changed = false
    for (const [id, member] of [...this.members]) {
      if (member.role !== 'waiting' || now - member.joinedAt < WAIT_TIMEOUT_MS) continue
      const conn = this.sessions.get(id)?.conn ?? null
      if (conn !== null) {
        this.conns.delete(conn)
        this.deps.sockets.close(conn, CloseCode.waitExpired, 'waited too long')
      }
      this.remove(id)
      changed = true
    }
    if (changed) this.publish()
  }

  /** Whether a host or co-host is connected: someone who can admit (F2) */
  private staffPresent(): boolean {
    for (const member of this.members.values()) {
      if (!member.reconnecting && this.allowed(member.id, 'admit')) return true
    }
    return false
  }

  /**
   * Sends each connected waiting member its `lobby` when it changed since the last one (its
   * place, the queue's length, the room's name, whether someone can admit), or when it is on a
   * new connection
   */
  private updateLobbies(): void {
    const queue = this.waitingIds()
    const hostPresent = this.staffPresent()
    for (const [index, id] of queue.entries()) {
      const session = this.sessions.get(id)!
      if (session.conn === null) continue
      const lobby: LobbyMessage = {
        t: 'lobby',
        v: PROTOCOL_VERSION,
        you: id,
        token: session.token,
        position: index + 1,
        count: queue.length,
        room: { name: this.info!.name, createdBy: this.info!.createdBy },
        hostPresent,
        recording: Object.keys(this.info!.recordings).length > 0,
      }
      const key = `${session.conn} ${JSON.stringify(lobby)}`
      if (this.lobbies.get(id) === key) continue
      this.lobbies.set(id, key)
      this.deps.sockets.send(session.conn, lobby)
    }
  }

  /**
   * Marks the member's microphone or camera muted, as its browser will once the notice arrives
   * (the room does not wait: everyone sees it at once). False when there is no such track or it
   * is muted already: nothing to tell the member.
   */
  private muteTrack(memberId: string, kind: 'mic' | 'cam'): boolean {
    const member = this.members.get(memberId)
    const track = member?.tracks.find((t) => t.kind === kind)
    if (!member || !track || track.muted) return false
    this.setMember(memberId, {
      tracks: member.tracks.map((t) => (t === track ? { ...t, muted: true } : t)),
    })
    return true
  }

  /** Sends a notice to the member, if it is connected (a reconnecting member misses it) */
  private notify(memberId: string, notice: NoticeMessage): void {
    const conn = this.sessions.get(memberId)?.conn
    if (conn) this.deps.sockets.send(conn, notice)
  }

  /**
   * `remove` (AC-1.4): the member is gone at once (its share with it), its socket is closed with
   * CloseCode.removed, and its browser is banned for BAN_MS. A browser that sent no client id
   * cannot be banned: only its session ends (its token is forgotten, so it joins as someone new).
   */
  private removeMember(memberId: string): void {
    const session = this.sessions.get(memberId)
    if (!session) return
    if (session.client !== null) this.ban(session.client)
    if (session.conn !== null) {
      this.conns.delete(session.conn)
      this.deps.sockets.close(session.conn, CloseCode.removed, 'removed')
    }
    this.remove(memberId)
    this.publish()
  }

  private ban(client: string, kind: BanKind = 'removed'): void {
    this.bans.delete(client)
    const until = this.deps.now() + (kind === 'denied' ? DENY_COOLDOWN_MS : BAN_MS)
    this.bans.set(client, { until, kind })
    // The oldest ban goes first (a Map keeps insertion order)
    while (this.bans.size > MAX_BANS) this.bans.delete(this.bans.keys().next().value!)
    this.saveBans()
  }

  /** Why the browser may not join now, or null when it may */
  private banned(client: string | null): BanKind | null {
    if (client === null) return null
    const ban = this.bans.get(client)
    return ban !== undefined && ban.until > this.deps.now() ? ban.kind : null
  }

  /** Drops the bans that ran out (the `bans` job, e1-t04's scheduler) */
  private pruneBans(): void {
    const now = this.deps.now()
    let changed = false
    for (const [client, { until }] of this.bans) {
      if (until > now) continue
      this.bans.delete(client)
      changed = true
    }
    if (changed) this.saveBans()
  }

  private saveBans(): void {
    this.deps.storage.saveBans(this.banList)
  }

  /** The banned browsers now (for tests and the adapter) */
  get banList(): Ban[] {
    return [...this.bans].map(([client, { until, kind }]) =>
      kind === 'denied' ? { client, until, denied: true } : { client, until },
    )
  }

  /**
   * `endMeeting` (AC-1.4): every socket is closed with CloseCode.ended and the room closes at
   * once, like an empty room after EMPTY_ROOM_TTL_MS (everything stored is gone, the id is 404).
   */
  private endMeeting(): void {
    for (const id of [...this.conns.keys()]) {
      this.deps.sockets.close(id, CloseCode.ended, 'ended')
    }
    this.conns.clear()
    this.close()
    // The tombstone (F3, e1-t17): a member whose connection had dropped comes back to 「主持人已
    // 結束會議」, not to 「這間會議室已經關閉」. A persistent room (I2, e1-t13) kept its
    // settings in `close`: only a join with a token of this meeting is turned away (`join`).
    this.endedUntil = this.deps.now() + ENDED_TOMBSTONE_MS
    this.deps.storage.saveEnded(this.endedUntil)
    this.schedule.set('ended', this.endedUntil)
    this.storedSchedule = JSON.stringify(this.schedule)
    this.deps.storage.saveSchedule(this.schedule.toJSON())
  }

  /**
   * `chat` (D3, e5-t01): at most CHAT_RATE per member, decided here (CLAUDE.md rule 1). The
   * message gets the next id, the sender's current name and the server's time, is stored and
   * goes to everyone joined (the sender too: its acknowledgement). The room keeps the latest
   * CHAT_HISTORY; older ones leave storage.
   */
  private addChat(connId: string, memberId: string, text: string): void {
    if (!this.allowed(memberId, 'chat')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    const now = this.deps.now()
    if (!this.chatRate.take(memberId, now)) {
      this.deps.sockets.send(connId, { t: 'error', code: 'rate_limited' })
      return
    }
    const member = this.members.get(memberId)!
    this.postChat({ id: ++this.chatId, from: memberId, name: member.name, text, at: now })
  }

  /**
   * A message the room accepted: stored, older ones dropped, sent to everyone in the room. It
   * belongs to the sender's breakout room (L3), if any: only that room's members get it.
   */
  private postChat(unscoped: ChatMessage): void {
    const group = this.groupOf(unscoped.from)
    const message: ChatMessage = group === null ? unscoped : { ...unscoped, group }
    this.chat.push(message)
    this.deps.storage.saveChat(message)
    while (this.chat.length > CHAT_HISTORY) this.deps.storage.dropChat(this.chat.shift()!.id)
    const frame: ServerMessage = { t: 'chat', messages: [message] }
    for (const [id, conn] of this.conns) {
      if (this.inRoom(conn) && chatVisible(message, this.groupOf(conn.member))) {
        this.deps.sockets.send(id, frame)
      }
    }
  }

  /**
   * The chat history after a welcome, or a move between breakout rooms (L3): the messages of the
   * room the member is in, CHAT_CHUNK a frame, the first one with `reset`. After a move every frame
   * is marked `regroup`: the browser must not take any of it for new messages
   */
  private sendChatHistory(connId: string, regroup = false): void {
    if (this.conns.get(connId)?.agent) return
    const group = this.groupOf(this.conns.get(connId)?.member ?? null)
    const visible = this.chat.filter((message) => chatVisible(message, group))
    for (let start = 0; start === 0 || start < visible.length; start += CHAT_CHUNK) {
      const messages = visible.slice(start, start + CHAT_CHUNK)
      this.deps.sockets.send(connId, {
        t: 'chat',
        messages,
        ...(start === 0 ? { reset: true as const } : {}),
        ...(regroup ? { regroup: true as const } : {}),
      })
    }
  }

  /** The chat messages the room keeps, oldest first (for tests and the adapter) */
  get chatHistory(): readonly ChatMessage[] {
    return this.chat
  }

  /**
   * POST /api/files/<room> (I5, e5-t05): may the member holding `token` upload this file? The
   * member must be in the room (worker/roles.ts `uploadFile`; who waits may not) and within the
   * member's and the room's limits. The grant is opaque, single use and short-lived.
   */
  grantUpload(token: string, request: GrantRequest): GrantDecision {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return { ok: false, reason: 'unauthorized' }
    if (!this.allowed(memberId, 'uploadFile')) return { ok: false, reason: 'forbidden' }
    const decision = this.files.grant(memberId, request, this.deps.now())
    this.saveFiles()
    return decision
  }

  /** PUT /api/files/<room>/<id>[/thumb] is about to store `bytes`: uses the grant up */
  claimUpload(token: string, id: string, part: 'file' | 'thumb', bytes: number): UploadClaim {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return { ok: false, reason: 'unauthorized' }
    if (!this.allowed(memberId, 'uploadFile')) return { ok: false, reason: 'forbidden' }
    const claim = this.files.claim(memberId, id, part, bytes, this.deps.now())
    this.saveFiles()
    return claim
  }

  /** The thumbnail reached R2 */
  thumbStored(token: string, id: string): boolean {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return false
    const stored = this.files.thumbStored(memberId, id)
    if (stored) this.saveFiles()
    return stored
  }

  /**
   * The file reached R2 and the Worker read what it is: everyone sees it as a chat message from
   * the member (the message's own id, name and time, like `chat`). Null when the member lost the
   * right meanwhile (removed, the room closed): the Worker then deletes what it stored.
   */
  finishUpload(
    token: string,
    id: string,
    stored: { kind: ChatFile['kind']; mime: string },
  ): ChatFile | null {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined || !this.allowed(memberId, 'uploadFile')) return null
    const file = this.files.finish(memberId, id, stored)
    if (!file) return null
    this.saveFiles()
    const member = this.members.get(memberId)!
    this.postChat({
      id: ++this.chatId,
      from: memberId,
      name: member.name,
      text: file.name,
      at: this.deps.now(),
      file,
    })
    return file
  }

  /** The upload failed or was cancelled: its place in the limits is free again */
  abortUpload(token: string, id: string): boolean {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return false
    const aborted = this.files.abort(id, memberId)
    if (aborted) this.saveFiles()
    return aborted
  }

  /**
   * GET /api/files/<room>/<id> (I5): only someone in the room (worker/roles.ts `downloadFile`),
   * only a file of this room, only until it expires.
   */
  fileAccess(token: string, id: string): FileAccess {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return { ok: false, reason: 'unauthorized' }
    if (!this.allowed(memberId, 'downloadFile')) return { ok: false, reason: 'forbidden' }
    return this.files.access(id, this.deps.now())
  }

  private saveFiles(): void {
    this.deps.storage.saveFiles?.(this.files.state)
  }

  /**
   * `share` (D1, e3-t02; H5, e3-t07): decided here and nowhere else (CLAUDE.md rule 1). Granted
   * while fewer than MAX_SHARES members share (a member who already shares keeps its share);
   * refused with `share_full` when MAX_SHARES do (nobody's share is taken away), and with
   * `audio_only` once the month is audio-only (no new video, shared/usage.ts).
   */
  private startShare(connId: string, memberId: string): void {
    const shares = this.info!.shares
    if (shares[memberId]) return
    if (!this.allowed(memberId, 'shareScreen')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    if (this.usage === 'audioOnly') {
      this.deps.sockets.send(connId, { t: 'error', code: 'audio_only' })
      return
    }
    // MAX_SHARES is per breakout room (L3): each is a meeting of its own
    const group = this.groupOf(memberId)
    const sharing = Object.keys(shares).filter((id) => this.groupOf(id) === group)
    if (sharing.length >= MAX_SHARES) {
      this.deps.sockets.send(connId, { t: 'error', code: 'share_full' })
      return
    }
    this.info = {
      ...this.info!,
      shares: { ...shares, [memberId]: { memberId, since: this.deps.now() } },
    }
    this.deps.storage.saveRoom(this.info)
    this.publish()
  }

  /**
   * Stops `memberId`'s share on someone else's behalf (E1 AC-1.4): the `host` message's
   * `stopShare` (F1). False when `by` may not (worker/roles.ts `stopShare`, unless it is the
   * sharer itself) or `memberId` does not share. The other shares go on.
   */
  stopShare(by: string, memberId: string): boolean {
    if (!this.info?.shares[memberId]) return false
    if (by !== memberId && !this.allowed(by, 'stopShare', memberId)) return false
    this.endShare(memberId)
    return true
  }

  /** `memberId` no longer shares; its screen leaves its track list. A no-op if it did not */
  private endShare(memberId: string): void {
    const shares = this.info?.shares
    if (!shares?.[memberId]) return
    this.dropScreen(memberId)
    const { [memberId]: _ended, ...rest } = shares
    this.info = { ...this.info!, shares: rest }
    this.deps.storage.saveRoom(this.info)
    this.clearShareAnnotations(memberId)
    this.publish()
  }

  /** Takes a member's screen tracks out of its list (it no longer holds the share) */
  private dropScreen(memberId: string): void {
    const member = this.members.get(memberId)
    if (!member) return
    const tracks = member.tracks.filter((track) => !SCREEN_KINDS.has(track.kind))
    if (tracks.length !== member.tracks.length) this.setMember(memberId, { tracks })
  }

  /** `renameRoom`: who may is worker/roles.ts' `renameRoom` (the host, and co-hosts) */
  private renameRoom(connId: string, memberId: string, name: string): void {
    if (!this.allowed(memberId, 'renameRoom')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'forbidden' })
      return
    }
    this.info = { ...this.info!, name }
    this.deps.storage.saveRoom(this.info)
    this.publish()
  }

  /**
   * The SFU proxy asks before every call (worker/sfu.ts): is `token` a member's, is `sessionId`
   * (null when creating one) that member's SFU session, and is every track it wants to pull
   * published in this room. Nobody outside the room can spend the room's SFU, and a member can
   * only drive its own session. While breakout rooms are open (L3, AC-10.4) a track whose owner is
   * in another room is not in this member's room: `not_found`, as for one never published.
   */
  sfuAccess(token: string, sessionId: string | null, pulls: readonly SfuTrackRef[]): SfuAccess {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined) return { ok: false, reason: 'unauthorized' }
    // In the room, not in the waiting room (F2): worker/roles.ts `media`
    if (!this.allowed(memberId, 'media')) return { ok: false, reason: 'forbidden' }
    if (sessionId !== null && this.sessions.get(memberId)!.sfu !== sessionId) {
      return { ok: false, reason: 'forbidden' }
    }
    const kinds: TrackKind[] = []
    const group = this.groupOf(memberId)
    for (const pull of pulls) {
      const found = this.findTrack(pull)
      if (!found || this.groupOf(found.owner) !== group) return { ok: false, reason: 'not_found' }
      kinds.push(found.kind)
    }
    return { ok: true, memberId, pulls: kinds }
  }

  /**
   * The proxy created an SFU session for `token`: it becomes the member's only session. Tracks
   * reported for an earlier session (before a reload) are dropped. False for an unknown token.
   */
  bindSfu(token: string, sessionId: string): boolean {
    const memberId = this.info ? this.byToken.get(token) : undefined
    if (memberId === undefined || !this.allowed(memberId, 'media')) return false
    const session = this.sessions.get(memberId)!
    session.sfu = sessionId
    this.baselines.set(memberId, { sessionId, bytes: 0, at: this.deps.now() })
    this.setMember(memberId, { tracks: [] })
    this.publish()
    return true
  }

  /** The month's state from UsageDO; members see it as `RoomView.usage` */
  setUsage(state: UsageState): void {
    if (state === this.usage) return
    this.usage = state
    this.deps.storage.saveUsage({ at: this.usageAt, state })
    if (this.info) this.publish()
  }

  get usageState(): UsageState {
    return this.usage
  }

  /**
   * Egress since the last call, for UsageDO (shared/usage.ts): what the browsers reported, and
   * the server's estimate (elapsed time × every unmuted track each connected member could
   * receive × its assumed bitrate, the video capped at MAX_ASSUMED_VIDEO_BPS per receiver, ×
   * RELAY_OVERHEAD for a member receiving through TURN). Called by the
   * sweep alarm.
   */
  takeUsage(): UsageDelta {
    const now = this.deps.now()
    const elapsed = Math.min(Math.max(now - this.usageAt, 0), MAX_USAGE_GAP_MS)
    this.usageAt = now
    this.deps.storage.saveUsage({ at: now, state: this.usage })
    let bitsPerSecond = 0
    for (const [receiverId, receiver] of this.members) {
      if (receiver.reconnecting) continue
      let sound = 0
      let video = 0
      const group = this.groupOf(receiverId)
      for (const [publisherId, publisher] of this.members) {
        // Nobody receives from another breakout room (L3)
        if (publisherId === receiverId || this.groupOf(publisherId) !== group) continue
        for (const track of publisher.tracks) {
          // A muted track sends nothing (B2); a member lying about it still shows up in the
          // receivers' own reports
          if (track.muted) continue
          if (isVideoKind(track.kind)) video += ASSUMED_BITRATE[track.kind]
          else sound += ASSUMED_BITRATE[track.kind]
        }
      }
      const received = sound + Math.min(video, MAX_ASSUMED_VIDEO_BPS)
      bitsPerSecond += this.relayed.has(receiverId) ? received * RELAY_OVERHEAD : received
    }
    const clientBytes = this.reported
    this.reported = 0
    return { clientBytes, estimateBytes: Math.round(((bitsPerSecond / 8) * elapsed) / 1000) }
  }

  /** The connection was heard from at `at` (a message, or a ping answered without waking the object) */
  heartbeat(connId: string, at: number): void {
    const conn = this.conns.get(connId)
    if (conn && at > conn.lastSeen) conn.lastSeen = at
  }

  /**
   * Closes sockets that never joined (JOIN_TIMEOUT_MS) or went silent (STALE_AFTER_MS; their
   * members start reconnecting), and removes members reconnecting for longer than
   * RECONNECT_GRACE_MS. Returns how many sockets were closed plus members removed.
   */
  sweep(): number {
    const now = this.deps.now()
    let count = 0
    let changed = false
    for (const [id, conn] of [...this.conns]) {
      const expired =
        conn.member === null
          ? now - conn.openedAt > JOIN_TIMEOUT_MS
          : now - conn.lastSeen > STALE_AFTER_MS
      if (!expired) continue
      this.conns.delete(id)
      this.deps.sockets.close(id, CloseCode.stale, conn.member ? 'heartbeat timeout' : 'no join')
      count++
      if (conn.member !== null) {
        this.markAway(conn.member)
        changed = true
      }
    }
    for (const [id, session] of [...this.sessions]) {
      if (session.awaySince !== null && now - session.awaySince > RECONNECT_GRACE_MS) {
        this.remove(id)
        count++
        changed = true
      }
    }
    if (changed) this.publish()
    else this.reschedule()
    return count
  }

  view(): RoomView {
    if (!this.info) throw new Error('The room was not created')
    const members: Record<string, Member> = {}
    for (const [id, member] of this.members) {
      if (member.role === 'waiting') continue
      // Where each member is (L3); absent for the main room, as rooms stored before v23 have it
      const group = this.breakout.groupOf(id)
      members[id] = group === null ? member : { ...member, group }
    }
    return {
      room: this.info,
      members,
      waiting: this.waitingView(),
      usage: this.usage,
      poll: this.interact.pollView,
      timer: this.interact.timer,
      agenda: this.interact.agenda,
      breakout: this.breakout.view,
    }
  }

  /** Who waits (F2), as the room sees them */
  private waitingView(): Record<string, WaitingEntry> {
    const waiting: Record<string, WaitingEntry> = {}
    for (const [id, { name, role, joinedAt, reconnecting }] of this.members) {
      if (role === 'waiting') waiting[id] = { id, name, since: joinedAt, reconnecting }
    }
    return waiting
  }

  /** A published track and whose it is; null when nobody in the room publishes it */
  private findTrack(ref: SfuTrackRef): { kind: TrackKind; owner: string } | null {
    for (const member of this.members.values()) {
      const track = member.tracks.find(
        (t) => t.sessionId === ref.sessionId && t.trackName === ref.trackName,
      )
      if (track) return { kind: track.kind, owner: member.id }
    }
    return null
  }

  /**
   * `tracks`: only for the member's current SFU session; a stale one (before a reload) is
   * ignored. Also how a member mutes and unmutes (`muted` on each track, B2).
   */
  private setTracks(memberId: string, message: TracksMessage): void {
    if (this.sessions.get(memberId)!.sfu !== message.sessionId) return
    // Only a member who shares lists a screen (D1): a list from before its share ended (the host
    // stopped it) must not bring it back
    const sharing = this.info!.shares[memberId] !== undefined
    const tracks: MemberTrack[] = message.tracks
      .filter(({ kind }) => sharing || !SCREEN_KINDS.has(kind))
      .map(({ trackName, kind, muted }) => ({
        sessionId: message.sessionId,
        trackName,
        kind,
        muted,
      }))
    this.setMember(memberId, { tracks })
    this.publish()
  }

  /**
   * `stats`: counts the growth of the member's cumulative bytesReceived on its current session.
   * Without a baseline (the object was evicted since) the report only becomes the baseline; the
   * server estimate covers the gap. A report faster than MAX_REPORTED_BITRATE is clamped; a
   * relayed member's growth counts × RELAY_OVERHEAD (shared/usage.ts).
   */
  private countStats(memberId: string, message: StatsMessage): void {
    if (this.sessions.get(memberId)!.sfu !== message.sessionId) return
    if (message.relay) this.relayed.add(memberId)
    else this.relayed.delete(memberId)
    const now = this.deps.now()
    const last = this.baselines.get(memberId)
    this.baselines.set(memberId, {
      sessionId: message.sessionId,
      bytes: message.bytesReceived,
      at: now,
    })
    if (!last || last.sessionId !== message.sessionId) return
    const grown = message.bytesReceived - last.bytes
    if (grown <= 0) return
    const seconds = Math.min(Math.max(now - last.at, 1000), MAX_REPORT_GAP_MS) / 1000
    const counted = Math.min(grown, Math.round((MAX_REPORTED_BITRATE / 8) * seconds))
    this.reported += message.relay ? Math.round(counted * RELAY_OVERHEAD) : counted
  }

  /**
   * `join` on a connection: a token the room knows brings back its member (taking it over from
   * another connection still holding it), anything else makes a new member if there is room. A
   * banned browser (F1) is closed with CloseCode.removed.
   *
   * The order (F3): a ban; a token the room knows (no lock, no password asked again); the lock
   * (a locked room tells nobody whether a password is right); the password; the waiting room.
   * Checking the password waits for its digest: the join finishes then, if the socket is still
   * there, checking the ban and the lock again.
   */
  private join(connId: string, message: JoinMessage): void | Promise<void> {
    const { token, client } = message
    // A desktop agent's token is not a browser's (N2, T-02): it joins as nobody the room knows
    const found = token === null ? undefined : this.byToken.get(token)
    const known = found !== undefined && this.isAgent(found) ? undefined : found
    // A persistent room's owner (I2) is never kept out: no ban, lock, password or waiting room
    const owner = this.ownerConn(connId)
    // A persistent room outlives its meetings (I2): someone coming back with a token of the one
    // the host just ended learns it ended, like in a random room's tombstone (F3)
    if (!owner && this.persistent && this.ended && token !== null && known === undefined) {
      this.refuse(connId, CloseCode.ended, 'ended')
      return
    }
    if (!owner && !this.mayJoin(connId, client, known)) return
    const record = this.password
    if (owner || known !== undefined || record === null) {
      this.enter(connId, message, known)
      return
    }
    const keys = this.guessKeys(connId, client)
    const now = this.deps.now()
    const waitUntil = this.guard.waitUntil(keys, now)
    if (waitUntil !== null) {
      this.refuse(connId, CloseCode.passwordWait, String(waitUntil - now))
      return
    }
    const password = message.password ?? null
    if (password === null) {
      this.refuse(connId, CloseCode.passwordRequired, 'password required')
      return
    }
    const conn = this.conns.get(connId)!
    conn.joining = true
    return verifyPassword(password, record).then((right) => {
      conn.joining = false
      if (this.conns.get(connId) !== conn || !this.info) return
      // The host changed the password meanwhile: this guess was against the old one
      if (this.password !== record) {
        this.refuse(connId, CloseCode.passwordWrong, 'password changed')
        return
      }
      const at = this.deps.now()
      if (!right) {
        const until = this.guard.fail(keys, at)
        this.saveGuesses()
        if (until !== null) this.refuse(connId, CloseCode.passwordWait, String(until - at))
        else this.refuse(connId, CloseCode.passwordWrong, 'wrong password')
        return
      }
      if (this.guard.waitUntil(keys, at) === null && keys.length > 0) {
        this.guard.succeed(keys)
        this.saveGuesses()
      }
      if (this.mayJoin(connId, client, undefined)) this.enter(connId, message, undefined)
    })
  }

  /** What the guess limit counts a join against: its browser and its network address (F3) */
  private guessKeys(connId: string, client: string | null): string[] {
    const ip = this.conns.get(connId)?.ip ?? null
    return [...(client === null ? [] : [`c:${client}`]), ...(ip === null ? [] : [`a:${ip}`])]
  }

  private saveGuesses(): void {
    this.deps.storage.saveGuesses(this.guard.toJSON())
  }

  /**
   * Whether a `join` may go on: not banned (F1), and the room is not locked to someone it does
   * not know (F2); refuses the socket otherwise
   */
  private mayJoin(connId: string, client: string | null, known: string | undefined): boolean {
    const banned = this.banned(client)
    if (banned) {
      this.refuse(connId, banned === 'denied' ? CloseCode.denied : CloseCode.removed, banned)
      return false
    }
    // A locked room (F2) lets back in only who it knows: a member within its grace period, or
    // someone already waiting
    if (known === undefined && this.info!.locked) {
      this.refuse(connId, CloseCode.locked, 'locked')
      return false
    }
    return true
  }

  /** Whether the account on this connection owns this persistent room (I2) */
  private ownerConn(connId: string): boolean {
    return this.ownedBy(this.conns.get(connId)?.account ?? null)
  }

  /**
   * A persistent room's owner joined (I2, e1-t13): they are the host. Whoever was host becomes a
   * co-host (as when a host hands over, F3) and is told; the owner may hand the role on again.
   */
  private ownerTakesHost(memberId: string): string[] {
    const member = this.members.get(memberId)
    if (!member || member.role === 'host') return []
    const demoted: string[] = []
    for (const other of [...this.members.values()]) {
      if (other.role !== 'host') continue
      this.setMember(other.id, { role: 'cohost' })
      demoted.push(other.id)
    }
    this.setMember(memberId, { role: 'host' })
    return demoted
  }

  /** The `join` passed every check: the member it brings back (`known`), or a new one */
  private enter(connId: string, message: JoinMessage, known: string | undefined): void {
    const { name, client } = message
    const owner = this.ownerConn(connId)
    let memberId: string
    if (known !== undefined) {
      memberId = known
      const session = this.sessions.get(memberId)!
      if (session.conn !== null && session.conn !== connId) {
        this.conns.delete(session.conn)
        this.deps.sockets.close(session.conn, CloseCode.replaced, 'session taken over')
      }
      session.conn = connId
      session.awaySince = null
      session.client = client ?? session.client
      this.setMember(memberId, { name, reconnecting: false })
    } else {
      if (this.members.size >= MAX_MEMBERS) {
        this.refuse(connId, CloseCode.roomFull, 'room full')
        return
      }
      memberId = this.deps.newMemberId()
      const newToken = this.deps.newToken()
      const now = this.deps.now()
      // The first member names the room's default and starts its clock
      if (this.info!.startedAt === null) {
        this.info = { ...this.info!, createdBy: name, startedAt: now }
        this.deps.storage.saveRoom(this.info)
      }
      // publish makes the member host if nobody is (assignHost); with the waiting room on, the
      // member waits to be admitted (F2)
      const member: Member = {
        id: memberId,
        name,
        role: this.info!.waitingRoom && !owner ? 'waiting' : 'participant',
        joinedAt: now,
        reconnecting: false,
        tracks: [],
        hand: null,
        signal: null,
        mayRecord: false,
      }
      this.members.set(memberId, member)
      this.sessions.set(memberId, {
        token: newToken,
        conn: connId,
        awaySince: null,
        sfu: null,
        client,
        pairedBy: null,
      })
      this.byToken.set(newToken, memberId)
    }
    this.conns.get(connId)!.member = memberId
    const demoted = owner ? this.ownerTakesHost(memberId) : []
    // Someone waiting gets its lobby from publish (updateLobbies), nothing else (F2)
    this.lobbies.delete(memberId)
    this.publish(new Set([connId]))
    // After the patch, so the notice can name the owner
    for (const id of demoted) this.notify(id, { t: 'notice', notice: 'madeCohost', by: memberId })
    if (this.isWaiting(memberId)) return
    this.welcome(connId, memberId)
    // Coming back keeps the microphone as the member left it
    if (known === undefined) this.tellStartMuted(memberId)
  }

  /**
   * A participant just came in to a room whose owner wants them muted at first (L5, e1-t18): their
   * browser turns the microphone off and says why. Not the host or a co-host, who run the meeting.
   */
  private tellStartMuted(memberId: string): void {
    if (this.info?.startMuted !== true || this.members.get(memberId)?.role !== 'participant') return
    this.notify(memberId, { t: 'notice', notice: 'startMuted', by: memberId })
  }

  /** Closes a socket that may not join, with the reason */
  private refuse(connId: string, code: number, reason: string): void {
    this.conns.delete(connId)
    this.deps.sockets.close(connId, code, reason)
    this.reschedule()
  }

  /** The member is in the room on this connection: its welcome, then the chat history */
  private welcome(connId: string, memberId: string): void {
    // A recording's time to agree counts from now for someone who just came in (I4)
    this.cameIn.set(memberId, this.deps.now())
    this.reschedule()
    this.deps.sockets.send(connId, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: memberId,
      token: this.sessions.get(memberId)!.token,
      rev: this.rev,
      state: this.sent ?? this.view(),
    })
    this.sendChatHistory(connId)
    // The strokes on the shares (J2): for someone late, and to catch up after a reconnect
    this.sendAnnotations(connId)
    // Their answer to the poll on now (L5): the view does not say on an anonymous one
    this.sendOwnVote(connId, memberId)
  }

  /** A connection whose member is in the room (not waiting, F2): it gets patches and chat */
  private inRoom(conn: Connection): boolean {
    // A desktop agent's socket (N2) gets none of it
    return conn.member !== null && !conn.agent && !this.isWaiting(conn.member)
  }

  private markAway(memberId: string): void {
    const session = this.sessions.get(memberId)
    if (!session) return
    session.conn = null
    session.awaySince = this.deps.now()
    this.setMember(memberId, { reconnecting: true })
  }

  private remove(memberId: string): void {
    const session = this.sessions.get(memberId)
    if (session) this.byToken.delete(session.token)
    this.sessions.delete(memberId)
    this.members.delete(memberId)
    // A sharer who left takes the share along (D1)
    if (this.info?.shares[memberId]) {
      const { [memberId]: _left, ...rest } = this.info.shares
      this.info = { ...this.info, shares: rest }
      this.deps.storage.saveRoom(this.info)
      this.clearShareAnnotations(memberId)
    }
    // So does someone spotlighted (G2)
    if (this.info?.spotlight === memberId) {
      this.info = { ...this.info, spotlight: null }
      this.deps.storage.saveRoom(this.info)
    }
    // And a recorder its recording (I4): the red light goes out with them
    if (this.info?.recordings[memberId]) {
      const { [memberId]: _left, ...rest } = this.info.recordings
      this.info = { ...this.info, recordings: rest }
      this.deps.storage.saveRoom(this.info)
    }
    this.baselines.delete(memberId)
    this.relayed.delete(memberId)
    this.chatRate.forget(memberId)
    this.reactionRate.forget(memberId)
    this.signalRate.forget(memberId)
    this.annotationFrames.forget(memberId)
    this.annotationStrokes.forget(memberId)
    this.pollRate.forget(memberId)
    this.interactRate.forget(memberId)
    // Someone who left is in no breakout room; coming back (a new member) lands in the main room
    if (this.breakout.forget(memberId)) this.saveBreakout()
    // Their pairing code goes; their computer stays, nobody's now (N2)
    if (this.pairing.cancel(memberId)) this.savePairing()
    for (const id of this.agentsOf(memberId)) {
      const agent = this.members.get(id)!.agent!
      this.setMember(id, { agent: { ...agent, owner: null } })
    }
    this.lobbies.delete(memberId)
    this.cameIn.delete(memberId)
  }

  /**
   * Desktop agents never keep a room alive on their own (N2): once no person is a member any more
   * (the last one left, or their RECONNECT_GRACE_MS ran out; someone waiting counts as a person),
   * every agent is closed with CloseCode.ended and forgotten, and the room takes its usual
   * empty-room path. Run by `publish`, which every removal goes through.
   */
  private dropOrphanAgents(): void {
    const agents: string[] = []
    for (const member of this.members.values()) {
      if (!member.agent) return
      agents.push(member.id)
    }
    for (const id of agents) {
      const conn = this.sessions.get(id)?.conn ?? null
      if (conn !== null) {
        this.conns.delete(conn)
        this.socketRate.forget(conn)
        this.deps.sockets.close(conn, CloseCode.ended, 'nobody left')
      }
      this.remove(id)
    }
  }

  /** Members are replaced, never mutated: `sent` shares their objects */
  private setMember(memberId: string, changes: Partial<Member>): void {
    const member = this.members.get(memberId)
    if (member) this.members.set(memberId, { ...member, ...changes })
  }

  private records(): SessionRecord[] {
    return [...this.sessions].map(([id, session]) => ({
      token: session.token,
      member: this.members.get(id)!,
      conn: session.conn,
      awaySince: session.awaySince,
      sfu: session.sfu,
      client: session.client,
      ...(session.pairedBy ? { pairedBy: session.pairedBy } : {}),
    }))
  }

  /**
   * The host role (AC-1.3): the first member to join is the host. A host that left, or has been
   * reconnecting for HOST_HANDOFF_MS, hands the role to the earliest-joined connected co-host
   * (F3), else the earliest-joined connected member; a host who comes back after that is a
   * participant. While nobody is connected the role waits
   * with the reconnecting host (or nobody), and goes to whoever connects first.
   */
  private assignHost(): void {
    let host: Member | null = null
    let candidate: Member | null = null
    for (const member of this.members.values()) {
      // Someone waiting is not in the meeting: never the host (F2); nor a desktop agent (N2)
      if (member.role === 'waiting' || member.agent) continue
      if (member.role === 'host') {
        // Never two hosts (a defensive repair: nothing makes a second one)
        if (host) this.setMember(member.id, { role: 'participant' })
        else host = member
      } else if (!member.reconnecting && (candidate === null || before(member, candidate))) {
        candidate = member
      }
    }
    if (candidate === null) return
    if (host) {
      if (!host.reconnecting) return
      const away = this.sessions.get(host.id)?.awaySince ?? null
      if (away === null || this.deps.now() - away < HOST_HANDOFF_MS) return
      this.setMember(host.id, { role: 'participant' })
    }
    this.setMember(candidate.id, { role: 'host' })
  }

  /**
   * Brings the alarm's jobs up to date with the room (e1-t04): the sweep every
   * SWEEP_INTERVAL_MS while anyone is connected or reconnecting (one more runs after the room
   * empties, flushing the last usage); `close` EMPTY_ROOM_TTL_MS after the room became empty;
   * `handoff` when a reconnecting host's HOST_HANDOFF_MS runs out and someone connected could
   * take over. Stores the schedule when it changed.
   */
  private reschedule(): void {
    if (!this.info) return
    const now = this.deps.now()
    if (this.active) {
      this.schedule.ensure('sweep', now + SWEEP_INTERVAL_MS)
      this.schedule.clear('close')
    } else if (this.persistent && this.idle) {
      // A persistent room between meetings (I2): nothing to clear, so nothing to close
      this.schedule.clear('close')
    } else {
      this.schedule.ensure('close', now + EMPTY_ROOM_TTL_MS)
    }
    const host = [...this.members.values()].find((member) => member.role === 'host')
    const away = host?.reconnecting ? (this.sessions.get(host.id)?.awaySince ?? null) : null
    const someoneConnected = [...this.members.values()].some(
      (member) => !member.reconnecting && member.role !== 'waiting' && !member.agent,
    )
    if (away !== null && someoneConnected) this.schedule.set('handoff', away + HOST_HANDOFF_MS)
    else this.schedule.clear('handoff')
    // A persistent room's changed whiteboard goes to R2 (J4)
    if (this.boardDirty) this.schedule.ensure('board', now + BOARD_SAVE_MS)
    else this.schedule.clear('board')
    // The next ban to run out (F1); none left, no job
    let banEnds: number | null = null
    for (const { until } of this.bans.values()) {
      if (banEnds === null || until < banEnds) banEnds = until
    }
    if (banEnds === null) this.schedule.clear('bans')
    else this.schedule.set('bans', banEnds)
    // The next one to wait too long (F2); nobody waiting, no job
    let waitEnds: number | null = null
    for (const member of this.members.values()) {
      if (member.role !== 'waiting') continue
      const at = member.joinedAt + WAIT_TIMEOUT_MS
      if (waitEnds === null || at < waitEnds) waitEnds = at
    }
    if (waitEnds === null) this.schedule.clear('waiting')
    else this.schedule.set('waiting', waitEnds)
    // The next wrong password guess to stop counting (F3); none, no job
    // The next member to run out of time to agree to a recording (I4); none, no job
    let consentEnds: number | null = null
    for (const at of this.consentDeadlines().values()) {
      if (consentEnds === null || at < consentEnds) consentEnds = at
    }
    if (consentEnds === null) this.schedule.clear('consent')
    else this.schedule.set('consent', consentEnds)
    const guessEnds = this.guard.nextExpiry()
    if (guessEnds === null) this.schedule.clear('guesses')
    else this.schedule.set('guesses', guessEnds)
    // The breakout rooms' time running out, or their recall's grace (L3); none open, no job
    const breakoutDue = this.breakout.due()
    if (breakoutDue === null) this.schedule.clear('breakout')
    else this.schedule.set('breakout', breakoutDue)
    // The next pairing code to run out, or wrong code to stop counting (N2); none, no job
    const pairingDue = this.pairing.due()
    if (pairingDue === null) this.schedule.clear('pairing')
    else this.schedule.set('pairing', pairingDue)
    const stored = JSON.stringify(this.schedule)
    if (stored !== this.storedSchedule) {
      this.storedSchedule = stored
      this.deps.storage.saveSchedule(this.schedule.toJSON())
    }
  }

  /**
   * A persistent room with nothing of a meeting left (I2): nobody has joined since its last
   * meeting closed, and no chat or ban is left over
   */
  private get idle(): boolean {
    return (
      this.info?.startedAt === null &&
      this.chat.length === 0 &&
      this.bans.size === 0 &&
      this.members.size === 0
    )
  }

  /**
   * The room is gone with everything stored: nobody came back for EMPTY_ROOM_TTL_MS, or the host
   * ended the meeting. A persistent room (I2, e1-t13) only loses the meeting: members, chat,
   * bans, guesses, shares, the spotlight; it keeps its name, password, waiting room and lock.
   */
  private close(): void {
    const kept =
      this.persistent && this.info
        ? { persistent: this.persistent, info: this.info, password: this.password }
        : null
    // What the meeting leaves on the whiteboard stays for the next one (J4, e7-t08): the last save
    const { boards } = this.deps
    if (kept && boards) {
      const strokes = this.annotations.strokes(WHITEBOARD_LAYER)
      if (this.boardLoaded && this.boardDirty) void boards.save(kept.persistent, strokes)
      else if (!this.boardLoaded && strokes.length > 0) void boards.merge(kept.persistent, strokes)
    }
    this.boardLoaded = false
    this.boardDirty = false
    this.info = null
    this.rev = 0
    this.sent = null
    this.members.clear()
    this.sessions.clear()
    this.byToken.clear()
    this.baselines.clear()
    this.relayed.clear()
    this.chat = []
    this.chatId = 0
    this.chatRate.clear()
    this.reactionRate.clear()
    this.signalRate.clear()
    // Whatever is stored goes with `storage.clear` below
    this.annotations.reset()
    this.annotationFrames.clear()
    this.annotationStrokes.clear()
    // The poll, the countdown and the agenda are the meeting's; what is stored goes below
    this.interact = new RoomInteract()
    // So are the breakout rooms (L3), and the pairing codes (N2)
    this.breakout.reset()
    this.pairing.reset()
    this.pollRate.clear()
    this.interactRate.clear()
    this.bans.clear()
    this.cameIn.clear()
    this.lobbies.clear()
    this.password = null
    // The files go with the meeting (I5), even if their 24 hours are not over
    const gone = this.files.takeAll()
    if (gone.keys.length > 0 || gone.grants.length > 0) this.deps.filesGone?.(gone)
    // A digest still being made for this room is dropped when it is ready
    this.passwordSeq++
    this.guard.clear()
    this.schedule.clearAll()
    this.storedSchedule = '{}'
    this.deps.storage.clear()
    if (kept) {
      this.persistent = kept.persistent
      this.info = {
        ...kept.info,
        createdBy: null,
        startedAt: null,
        shares: {},
        spotlight: null,
        // Recordings (I4) are the meeting's, not the room's settings
        recordings: {},
        // So are who may annotate and whether the board is open (J3); its strokes were saved above
        annotationPolicy: startingPolicy(kept.info.allowAnnotation),
        whiteboard: null,
      }
      this.password = kept.password
      this.deps.storage.savePersistent?.(this.persistent)
      this.deps.storage.saveRoom(this.info)
      if (this.password) this.deps.storage.savePassword(this.password)
      this.sent = this.view()
    } else {
      this.persistent = null
    }
  }

  /**
   * Sends what changed since the last patch to every connection in the room but `except` (who
   * is about to get its welcome), then their lobby to who waits (F2)
   */
  private publish(except: ReadonlySet<string> = NO_CONNS): void {
    this.dropOrphanAgents()
    this.assignHost()
    this.reschedule()
    const next = this.view()
    const ops = this.sent
      ? diff(viewAsJson(this.sent), viewAsJson(next))
      : [{ op: 'set' as const, path: [], value: viewAsJson(next) }]
    this.sent = next
    this.deps.storage.saveSessions(this.records())
    if (ops.length > 0) {
      this.rev += 1
      this.deps.storage.saveRev(this.rev)
      const message: ServerMessage = { t: 'patch', rev: this.rev, ops }
      for (const [id, conn] of this.conns) {
        if (!except.has(id) && this.inRoom(conn)) this.deps.sockets.send(id, message)
      }
    }
    this.updateLobbies()
  }
}
