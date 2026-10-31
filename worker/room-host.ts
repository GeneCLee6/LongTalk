import { diff } from '../shared/patch.ts'
import {
  CloseCode,
  HEARTBEAT_PING,
  JOIN_TIMEOUT_MS,
  MAX_MEMBERS,
  MAX_PENDING_SOCKETS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  STALE_AFTER_MS,
  SWEEP_INTERVAL_MS,
  parseClientMessage,
  viewAsJson,
  type Member,
  type MemberTrack,
  type RoomInfo,
  type RoomSummary,
  type RoomView,
  type ServerMessage,
  type StatsMessage,
  type TrackKind,
  type TracksMessage,
} from '../shared/protocol.ts'
import { ASSUMED_BITRATE, MAX_REPORTED_BITRATE, type UsageState } from '../shared/usage.ts'

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
}

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

/** A live socket the adapter found when it woke up */
export type OpenSocket = { conn: string; openedAt: number }

/** What survives the object being evicted */
export interface RoomStorage {
  saveRoom(info: RoomInfo): void
  saveRev(rev: number): void
  saveSessions(sessions: SessionRecord[]): void
  /** When egress was last counted and the month's state, so both survive the object being evicted */
  saveUsage(usage: UsageCursor): void
}

export type UsageCursor = { at: number; state: UsageState }

export interface RoomHostDeps {
  sockets: RoomSockets
  storage: RoomStorage
  now: () => number
  newMemberId: () => string
  newToken: () => string
}

export type Admission = { ok: true } | { ok: false; code: number; reason: string }

type Connection = {
  /** The member on this connection, null until it joins */
  member: string | null
  openedAt: number
  lastSeen: number
}

type Session = {
  token: string
  conn: string | null
  awaySince: number | null
  sfu: string | null
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
    info: RoomInfo | null,
    rev: number,
    sessions: readonly SessionRecord[],
    sockets: readonly OpenSocket[],
    usage: UsageCursor | null = null,
  ): void {
    this.info = info
    this.rev = rev
    this.members.clear()
    this.sessions.clear()
    this.byToken.clear()
    this.conns.clear()
    this.baselines.clear()
    this.reported = 0
    this.usage = usage?.state ?? 'normal'
    this.usageAt = usage?.at ?? this.deps.now()
    for (const { conn, openedAt } of sockets) {
      this.conns.set(conn, { member: null, openedAt, lastSeen: openedAt })
    }
    for (const record of sessions) {
      // Members stored by protocol v2 have no tracks
      this.members.set(record.member.id, { ...record.member, tracks: record.member.tracks ?? [] })
      this.sessions.set(record.member.id, {
        token: record.token,
        conn: record.conn,
        awaySince: record.awaySince,
        sfu: record.sfu ?? null,
      })
      this.byToken.set(record.token, record.member.id)
    }
    this.sent = info ? this.view() : null
    if (!info) return
    const now = this.deps.now()
    let changed = false
    for (const [id, session] of this.sessions) {
      const conn = session.conn === null ? undefined : this.conns.get(session.conn)
      if (conn) {
        conn.member = id
        continue
      }
      session.conn = null
      session.awaySince ??= now
      if (!this.members.get(id)!.reconnecting) {
        this.setMember(id, { reconnecting: true })
        changed = true
      }
    }
    if (changed) this.publish()
  }

  get exists(): boolean {
    return this.info !== null
  }

  /** Members in the room, connected or reconnecting */
  get memberCount(): number {
    return this.members.size
  }

  /** Whether the sweep alarm still has anything to watch */
  get active(): boolean {
    return this.conns.size > 0 || this.members.size > 0
  }

  /** Called once by POST /api/rooms; false when the id is already taken */
  create(info: RoomInfo): boolean {
    if (this.info) return false
    this.info = info
    this.deps.storage.saveRoom(info)
    this.usageAt = this.deps.now()
    this.sent = this.view()
    return true
  }

  /** For GET /api/rooms/<id>; null when the room does not exist */
  summary(): RoomSummary | null {
    return this.info ? { ...this.info, memberCount: this.members.size } : null
  }

  /** Whether a new WebSocket may open; `version` is the `v` query parameter */
  admit(version: string | null): Admission {
    if (version !== String(PROTOCOL_VERSION)) {
      return { ok: false, code: CloseCode.versionMismatch, reason: 'protocol version mismatch' }
    }
    if (!this.info) return { ok: false, code: CloseCode.roomNotFound, reason: 'room not found' }
    if (this.conns.size >= MAX_MEMBERS + MAX_PENDING_SOCKETS)
      return { ok: false, code: CloseCode.roomFull, reason: 'room full' }
    return { ok: true }
  }

  /** An admitted socket is live; it has JOIN_TIMEOUT_MS to send `join` */
  opened(connId: string): void {
    const now = this.deps.now()
    this.conns.set(connId, { member: null, openedAt: now, lastSeen: now })
  }

  /**
   * The socket closed (or errored) without `leave` and without the server closing it: its member
   * starts reconnecting. A no-op for a connection already gone.
   */
  closed(connId: string): void {
    const conn = this.conns.get(connId)
    if (!conn) return
    this.conns.delete(connId)
    if (conn.member === null) return
    this.markAway(conn.member)
    this.publish()
  }

  /** A text frame on a connection */
  message(connId: string, raw: string): void {
    const conn = this.conns.get(connId)
    if (!conn) return
    this.heartbeat(connId, this.deps.now())
    if (raw === HEARTBEAT_PING) return
    const message = parseClientMessage(raw)
    // Before `join` nothing else is accepted, and `join` only once
    if (!message || (conn.member === null) !== (message.t === 'join')) {
      this.deps.sockets.send(connId, { t: 'error', code: 'bad_message' })
      return
    }
    switch (message.t) {
      case 'join':
        this.join(connId, message.name, message.token)
        return
      case 'resync':
        this.deps.sockets.send(connId, {
          t: 'snapshot',
          rev: this.rev,
          state: this.sent ?? this.view(),
        })
        return
      case 'leave':
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
    }
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
    if (memberId === undefined) return false
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
   * the server's estimate (elapsed time × every track each connected member receives × its
   * assumed bitrate). Called by the sweep alarm.
   */
  takeUsage(): UsageDelta {
    const now = this.deps.now()
    const elapsed = Math.min(Math.max(now - this.usageAt, 0), MAX_USAGE_GAP_MS)
    this.usageAt = now
    this.deps.storage.saveUsage({ at: now, state: this.usage })
    let bitsPerSecond = 0
    for (const [receiverId, receiver] of this.members) {
      if (receiver.reconnecting) continue
      for (const [publisherId, publisher] of this.members) {
        if (publisherId === receiverId) continue
        for (const track of publisher.tracks) bitsPerSecond += ASSUMED_BITRATE[track.kind]
      }
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
    return count
  }

  view(): RoomView {
    if (!this.info) throw new Error('The room was not created')
    const members: Record<string, Member> = {}
    for (const [id, member] of this.members) members[id] = member
    return { room: this.info, members, usage: this.usage }
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

  /** `tracks`: only for the member's current SFU session; a stale one (before a reload) is ignored */
  private setTracks(memberId: string, message: TracksMessage): void {
    if (this.sessions.get(memberId)!.sfu !== message.sessionId) return
    const tracks: MemberTrack[] = message.tracks.map(({ trackName, kind }) => ({
      sessionId: message.sessionId,
      trackName,
      kind,
    }))
    this.setMember(memberId, { tracks })
    this.publish()
  }

  /**
   * `stats`: counts the growth of the member's cumulative bytesReceived on its current session.
   * Without a baseline (the object was evicted since) the report only becomes the baseline; the
   * server estimate covers the gap. A report faster than MAX_REPORTED_BITRATE is clamped.
   */
  private countStats(memberId: string, message: StatsMessage): void {
    if (this.sessions.get(memberId)!.sfu !== message.sessionId) return
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
    this.reported += Math.min(grown, Math.round((MAX_REPORTED_BITRATE / 8) * seconds))
  }

  /**
   * `join` on a connection: a token the room knows brings back its member (taking it over from
   * another connection still holding it), anything else makes a new member if there is room.
   */
  private join(connId: string, name: string, token: string | null): void {
    const known = token === null ? undefined : this.byToken.get(token)
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
      this.setMember(memberId, { name, reconnecting: false })
    } else {
      if (this.members.size >= MAX_MEMBERS) {
        this.conns.delete(connId)
        this.deps.sockets.close(connId, CloseCode.roomFull, 'room full')
        return
      }
      memberId = this.deps.newMemberId()
      const newToken = this.deps.newToken()
      const member: Member = {
        id: memberId,
        name,
        joinedAt: this.deps.now(),
        reconnecting: false,
        tracks: [],
      }
      this.members.set(memberId, member)
      this.sessions.set(memberId, { token: newToken, conn: connId, awaySince: null, sfu: null })
      this.byToken.set(newToken, memberId)
    }
    this.conns.get(connId)!.member = memberId
    this.publish(connId)
    this.deps.sockets.send(connId, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: memberId,
      token: this.sessions.get(memberId)!.token,
      rev: this.rev,
      state: this.sent ?? this.view(),
    })
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
    this.baselines.delete(memberId)
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
    }))
  }

  /** Sends what changed since the last patch to every joined connection but `except` */
  private publish(except?: string): void {
    const next = this.view()
    const ops = this.sent
      ? diff(viewAsJson(this.sent), viewAsJson(next))
      : [{ op: 'set' as const, path: [], value: viewAsJson(next) }]
    this.sent = next
    this.deps.storage.saveSessions(this.records())
    if (ops.length === 0) return
    this.rev += 1
    this.deps.storage.saveRev(this.rev)
    const message: ServerMessage = { t: 'patch', rev: this.rev, ops }
    for (const [id, conn] of this.conns) {
      if (id !== except && conn.member !== null) this.deps.sockets.send(id, message)
    }
  }
}
