import { CHAT_CHUNK, CHAT_HISTORY, ChatRateLimit, type ChatMessage } from '../shared/chat.ts'
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
  viewAsJson,
  waitingQueue,
  type HostMessage,
  type JoinMessage,
  type LobbyMessage,
  type Member,
  type MemberTrack,
  type NoticeMessage,
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
import { authorize, type Action } from './roles.ts'
import { Scheduler, type Schedule } from './scheduler.ts'
import type { PersistentRoomInfo } from '../shared/account.ts'

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
}

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
    ...rest,
    shares: storedShares(info),
  }
}

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
}

type Session = {
  token: string
  conn: string | null
  awaySince: number | null
  sfu: string | null
  /** The browser's own id from its last `join`, null when it sent none */
  client: string | null
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
    this.reported = 0
    this.usage = usage?.state ?? 'normal'
    this.usageAt = usage?.at ?? this.deps.now()
    for (const { conn, openedAt, ip, account } of sockets) {
      this.conns.set(conn, {
        member: null,
        openedAt,
        lastSeen: openedAt,
        ip: ip ?? null,
        joining: false,
        account: account ?? null,
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
    this.persistent = null
    this.endedUntil = null
    this.close()
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
  admit(version: string | null, ip: string | null = null): Admission {
    if (version !== String(PROTOCOL_VERSION)) {
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
  opened(connId: string, ip: string | null = null, account: string | null = null): void {
    const now = this.deps.now()
    this.conns.set(connId, {
      member: null,
      openedAt: now,
      lastSeen: now,
      ip,
      joining: false,
      account,
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
    }
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
      if (member.role === 'waiting' || member.reconnecting) continue
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
    for (const [id, conn] of this.conns) {
      if (this.inRoom(conn)) this.deps.sockets.send(id, frame)
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
    changes: Partial<Pick<RoomInfo, 'locked' | 'waitingRoom' | 'passwordSetAt' | 'spotlight'>>,
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
    return !!member && member.role !== 'waiting' && !member.reconnecting
  }

  /**
   * `setCohost` (F3, e1-t16): a participant becomes a co-host (`on`) or a co-host a participant
   * again; nothing else changes. The member is told first (`notice`), then everyone sees it.
   */
  private setCohost(by: string, memberId: string, on: boolean): void {
    const member = this.members.get(memberId)
    if (!member || member.role !== (on ? 'participant' : 'cohost')) return
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
      if (conn) this.welcome(conn, id)
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
    const message: ChatMessage = {
      id: ++this.chatId,
      from: memberId,
      name: member.name,
      text,
      at: now,
    }
    this.chat.push(message)
    this.deps.storage.saveChat(message)
    while (this.chat.length > CHAT_HISTORY) this.deps.storage.dropChat(this.chat.shift()!.id)
    const frame: ServerMessage = { t: 'chat', messages: [message] }
    for (const [id, conn] of this.conns) {
      if (this.inRoom(conn)) this.deps.sockets.send(id, frame)
    }
  }

  /** The chat history after a welcome: CHAT_CHUNK messages a frame, the first one with `reset` */
  private sendChatHistory(connId: string): void {
    for (let start = 0; start === 0 || start < this.chat.length; start += CHAT_CHUNK) {
      const messages = this.chat.slice(start, start + CHAT_CHUNK)
      this.deps.sockets.send(
        connId,
        start === 0 ? { t: 'chat', messages, reset: true } : { t: 'chat', messages },
      )
    }
  }

  /** The chat messages the room keeps, oldest first (for tests and the adapter) */
  get chatHistory(): readonly ChatMessage[] {
    return this.chat
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
    if (Object.keys(shares).length >= MAX_SHARES) {
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
   * only drive its own session.
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
    for (const pull of pulls) {
      const kind = this.findTrack(pull)
      if (!kind) return { ok: false, reason: 'not_found' }
      kinds.push(kind)
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
   * the server's estimate (elapsed time × every unmuted track each connected member receives ×
   * its assumed bitrate, × RELAY_OVERHEAD for a member receiving through TURN). Called by the
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
      let received = 0
      for (const [publisherId, publisher] of this.members) {
        if (publisherId === receiverId) continue
        for (const track of publisher.tracks) {
          // A muted track sends nothing (B2); a member lying about it still shows up in the
          // receivers' own reports
          if (!track.muted) received += ASSUMED_BITRATE[track.kind]
        }
      }
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
    for (const [id, member] of this.members) if (member.role !== 'waiting') members[id] = member
    return { room: this.info, members, waiting: this.waitingView(), usage: this.usage }
  }

  /** Who waits (F2), as the room sees them */
  private waitingView(): Record<string, WaitingEntry> {
    const waiting: Record<string, WaitingEntry> = {}
    for (const [id, { name, role, joinedAt, reconnecting }] of this.members) {
      if (role === 'waiting') waiting[id] = { id, name, since: joinedAt, reconnecting }
    }
    return waiting
  }

  private findTrack(ref: SfuTrackRef): TrackKind | null {
    for (const member of this.members.values()) {
      const track = member.tracks.find(
        (t) => t.sessionId === ref.sessionId && t.trackName === ref.trackName,
      )
      if (track) return track.kind
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
    const known = token === null ? undefined : this.byToken.get(token)
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
    if (!this.isWaiting(memberId)) this.welcome(connId, memberId)
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
  }

  /** A connection whose member is in the room (not waiting, F2): it gets patches and chat */
  private inRoom(conn: Connection): boolean {
    return conn.member !== null && !this.isWaiting(conn.member)
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
    this.lobbies.delete(memberId)
    this.cameIn.delete(memberId)
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
      // Someone waiting is not in the meeting: never the host (F2)
      if (member.role === 'waiting') continue
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
      (member) => !member.reconnecting && member.role !== 'waiting',
    )
    if (away !== null && someoneConnected) this.schedule.set('handoff', away + HOST_HANDOFF_MS)
    else this.schedule.clear('handoff')
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
    this.bans.clear()
    this.cameIn.clear()
    this.lobbies.clear()
    this.password = null
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
