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
  parseClientMessage,
  viewAsJson,
  type Member,
  type RoomInfo,
  type RoomSummary,
  type RoomView,
  type ServerMessage,
} from '../shared/protocol.ts'

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
}

/** A live socket the adapter found when it woke up */
export type OpenSocket = { conn: string; openedAt: number }

/** What survives the object being evicted */
export interface RoomStorage {
  saveRoom(info: RoomInfo): void
  saveRev(rev: number): void
  saveSessions(sessions: SessionRecord[]): void
}

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

type Session = { token: string; conn: string | null; awaySince: number | null }

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
  ): void {
    this.info = info
    this.rev = rev
    this.members.clear()
    this.sessions.clear()
    this.byToken.clear()
    this.conns.clear()
    for (const { conn, openedAt } of sockets) {
      this.conns.set(conn, { member: null, openedAt, lastSeen: openedAt })
    }
    for (const record of sessions) {
      this.members.set(record.member.id, record.member)
      this.sessions.set(record.member.id, {
        token: record.token,
        conn: record.conn,
        awaySince: record.awaySince,
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
    }
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
    return { room: this.info, members }
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
      const member: Member = { id: memberId, name, joinedAt: this.deps.now(), reconnecting: false }
      this.members.set(memberId, member)
      this.sessions.set(memberId, { token: newToken, conn: connId, awaySince: null })
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
