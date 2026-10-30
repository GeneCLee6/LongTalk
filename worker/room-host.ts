import { diff } from '../shared/patch.ts'
import {
  CloseCode,
  HEARTBEAT_PING,
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  STALE_AFTER_MS,
  parseClientMessage,
  viewAsJson,
  type Member,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../shared/protocol.ts'

/** The room's WebSockets, one per member (the DO's hibernatable sockets, or a fake in tests) */
export interface RoomSockets {
  send(memberId: string, message: ServerMessage): void
  close(memberId: string, code: number, reason: string): void
}

/** What survives the object being evicted; members do not (they live on their sockets) */
export interface RoomStorage {
  saveRoom(info: RoomInfo): void
  saveRev(rev: number): void
}

export interface RoomHostDeps {
  sockets: RoomSockets
  storage: RoomStorage
  now: () => number
  newMemberId: () => string
}

export type Admission = { ok: true } | { ok: false; code: number; reason: string }

/**
 * One room's signalling: members, heartbeat and diff push. Never touches a Cloudflare API, so
 * Vitest runs it directly; `RoomDO` (room.ts) is the glue to storage and WebSockets.
 *
 * Every change goes through `publish`: it diffs the view everyone last received against the
 * current one and sends the difference as one numbered patch.
 */
export class RoomHost {
  private readonly deps: RoomHostDeps
  private info: RoomInfo | null = null
  private readonly members = new Map<string, Member>()
  private readonly lastSeen = new Map<string, number>()
  private rev = 0
  /** The view every connected member has (after the last patch) */
  private sent: RoomView | null = null

  constructor(deps: RoomHostDeps) {
    this.deps = deps
  }

  /**
   * Rebuilds the room after the object was evicted or woke from hibernation: the room and rev
   * from storage, the members from their sockets. A member counts as last seen when it joined
   * until the adapter reports its heartbeats (`heartbeat`).
   */
  restore(info: RoomInfo | null, rev: number, members: readonly Member[]): void {
    this.info = info
    this.rev = rev
    this.members.clear()
    this.lastSeen.clear()
    for (const member of members) {
      this.members.set(member.id, member)
      this.lastSeen.set(member.id, member.joinedAt)
    }
    this.sent = info ? this.view() : null
  }

  get exists(): boolean {
    return this.info !== null
  }

  get memberCount(): number {
    return this.members.size
  }

  /** Called once by POST /api/rooms; false when the id is already taken */
  create(info: RoomInfo): boolean {
    if (this.info) return false
    this.info = info
    this.deps.storage.saveRoom(info)
    this.sent = this.view()
    return true
  }

  /** Whether a new WebSocket may join; `version` is the `v` query parameter */
  admit(version: string | null): Admission {
    if (version !== String(PROTOCOL_VERSION)) {
      return { ok: false, code: CloseCode.versionMismatch, reason: 'protocol version mismatch' }
    }
    if (!this.info) return { ok: false, code: CloseCode.roomNotFound, reason: 'room not found' }
    if (this.members.size >= MAX_MEMBERS)
      return { ok: false, code: CloseCode.roomFull, reason: 'room full' }
    return { ok: true }
  }

  /** A member for a socket about to be accepted; `connected` adds it once the socket is live */
  newMember(): Member {
    return { id: this.deps.newMemberId(), joinedAt: this.deps.now() }
  }

  /** The member's socket is live: everyone else gets a patch, the newcomer the whole room */
  connected(member: Member): void {
    this.members.set(member.id, member)
    this.lastSeen.set(member.id, this.deps.now())
    this.publish(member.id)
    const state = this.sent ?? this.view()
    this.deps.sockets.send(member.id, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you: member.id,
      rev: this.rev,
      state,
    })
  }

  /** The member's socket closed (or errored); a no-op for a member already dropped */
  disconnected(memberId: string): void {
    if (!this.members.delete(memberId)) return
    this.lastSeen.delete(memberId)
    this.publish()
  }

  /** A text frame from a member */
  message(memberId: string, raw: string): void {
    if (!this.members.has(memberId)) return
    this.heartbeat(memberId, this.deps.now())
    if (raw === HEARTBEAT_PING) return
    const message = parseClientMessage(raw)
    if (!message) {
      this.deps.sockets.send(memberId, { t: 'error', code: 'bad_message' })
      return
    }
    switch (message.t) {
      case 'resync':
        this.deps.sockets.send(memberId, {
          t: 'snapshot',
          rev: this.rev,
          state: this.sent ?? this.view(),
        })
        return
    }
  }

  /** The member was heard from at `at` (a message, or a ping answered without waking the object) */
  heartbeat(memberId: string, at: number): void {
    const seen = this.lastSeen.get(memberId)
    if (seen !== undefined && at > seen) this.lastSeen.set(memberId, at)
  }

  /** Drops members silent for STALE_AFTER_MS and closes their sockets; returns how many */
  sweep(): number {
    const now = this.deps.now()
    const stale = [...this.lastSeen]
      .filter(([, seen]) => now - seen > STALE_AFTER_MS)
      .map(([id]) => id)
    for (const id of stale) {
      this.members.delete(id)
      this.lastSeen.delete(id)
      this.deps.sockets.close(id, CloseCode.stale, 'heartbeat timeout')
    }
    if (stale.length > 0) this.publish()
    return stale.length
  }

  view(): RoomView {
    if (!this.info) throw new Error('The room was not created')
    const members: Record<string, Member> = {}
    for (const [id, member] of this.members) members[id] = member
    return { room: this.info, members }
  }

  /** Sends what changed since the last patch to every member but `except` */
  private publish(except?: string): void {
    const next = this.view()
    const ops = this.sent
      ? diff(viewAsJson(this.sent), viewAsJson(next))
      : [{ op: 'set' as const, path: [], value: viewAsJson(next) }]
    this.sent = next
    if (ops.length === 0) return
    this.rev += 1
    this.deps.storage.saveRev(this.rev)
    const message: ServerMessage = { t: 'patch', rev: this.rev, ops }
    for (const id of this.members.keys()) {
      if (id !== except) this.deps.sockets.send(id, message)
    }
  }
}
