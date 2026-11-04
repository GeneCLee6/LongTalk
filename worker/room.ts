import { DurableObject } from 'cloudflare:workers'
import type { ChatMessage } from '../shared/chat.ts'
import {
  CloseCode,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_CLIENT_MESSAGE_CHARS,
  newSessionToken,
  type RoomInfo,
  type RoomSummary,
  type ServerMessage,
} from '../shared/protocol.ts'
import type { Env } from './app.ts'
import {
  RoomHost,
  type Ban,
  type OpenSocket,
  type PersistentRecord,
  type RoomSettings,
  type SettingsChange,
  type SessionRecord,
  type SfuAccess,
  type SfuTrackRef,
  type UsageCursor,
} from './room-host.ts'
import { addressKey, type GuessRecord, type PasswordRecord } from './password.ts'
import type { Schedule } from './scheduler.ts'
import { USAGE_OBJECT } from './usage.ts'
import { requestClientKey } from './client-key.ts'
import { GUARD_OBJECT } from './guard.ts'
import type { OffenceKind } from '../shared/abuse.ts'
import { ACCOUNT_HEADER } from './session.ts'

/**
 * What each hibernatable socket carries, so the connections survive the object waking up;
 * `client` is its client key (worker/client-key.ts) for telling GuardDO about abuse (I1)
 */
type Attachment = OpenSocket & { client?: string | null }

const ROOM_KEY = 'room'
const REV_KEY = 'rev'
const SESSIONS_KEY = 'sessions'
const USAGE_KEY = 'usage'
const SCHEDULE_KEY = 'schedule'
/** Removed browsers and until when (F1) */
const BANS_KEY = 'bans'
/** The room's password as a salted digest, wrong guesses, an ended meeting's tombstone (F3) */
const PASSWORD_KEY = 'password'
const GUESSES_KEY = 'guesses'
const ENDED_KEY = 'ended'
/** A personal persistent room's slug and owner (I2, e1-t13) */
const PERSISTENT_KEY = 'persistent'
/** Each chat message under its own key (D3): `chat:` and its id, zero-padded so keys sort by id */
const CHAT_PREFIX = 'chat:'
const chatKey = (id: number) => CHAT_PREFIX + String(id).padStart(12, '0')

/** A socket opening asks UsageDO for the month's state when the room has not heard for this long */
const USAGE_REFRESH_MS = 60_000

/**
 * One room in its own Durable Object (`idFromName(<room id>)`, ARCHITECTURE.md §2). Only the glue
 * to Cloudflare: storage, the sweep alarm and the WebSockets (hibernation API, one per
 * connection, tagged with its connection id). What the room does is `RoomHost` (room-host.ts).
 *
 * The heartbeat `ping` is answered with `pong` by the runtime without waking the object; the
 * sweep reads when each socket last pinged.
 *
 * One alarm for every timed job (e1-t04): RoomHost keeps the jobs (sweep, empty-room close, host
 * handoff, ban expiry, waiting-room timeout; worker/scheduler.ts) and after anything that may
 * change them the object moves its alarm to `host.nextAlarm()` (`syncAlarm`).
 */
export class RoomDO extends DurableObject<Env> {
  private readonly host: RoomHost
  /** The socket being closed in `webSocketClose`: `getWebSockets()` still lists it */
  private closing: WebSocket | null = null
  /** When the room last heard the month's usage state from UsageDO */
  private usageCheckedAt = 0
  /** The alarm as last set (or found), so it is only written when it moves */
  private alarmAt: number | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    this.host = new RoomHost({
      sockets: {
        send: (connId, message) => this.send(connId, message),
        close: (connId, code, reason) => {
          for (const ws of ctx.getWebSockets(connId)) {
            try {
              ws.close(code, reason)
            } catch {
              // Already closed
            }
          }
        },
      },
      storage: {
        saveRoom: (info) => void storage.put(ROOM_KEY, info),
        saveRev: (rev) => void storage.put(REV_KEY, rev),
        saveSessions: (sessions) => void storage.put(SESSIONS_KEY, sessions),
        saveUsage: (usage) => void storage.put(USAGE_KEY, usage),
        saveSchedule: (schedule) => void storage.put(SCHEDULE_KEY, schedule),
        saveChat: (message) => void storage.put(chatKey(message.id), message),
        dropChat: (id) => void storage.delete(chatKey(id)),
        saveBans: (bans) => void storage.put(BANS_KEY, bans),
        savePassword: (record) =>
          void (record === null ? storage.delete(PASSWORD_KEY) : storage.put(PASSWORD_KEY, record)),
        saveGuesses: (guesses) => void storage.put(GUESSES_KEY, guesses),
        saveEnded: (until) =>
          void (until === null ? storage.delete(ENDED_KEY) : storage.put(ENDED_KEY, until)),
        savePersistent: (record) =>
          void (record === null
            ? storage.delete(PERSISTENT_KEY)
            : storage.put(PERSISTENT_KEY, record)),
        clear: () => void storage.deleteAll(),
      },
      now: Date.now,
      newMemberId: () => crypto.randomUUID(),
      newToken: newSessionToken,
      offence: (connId, _ip, kind) => {
        if (connId === null) return
        for (const ws of ctx.getWebSockets(connId)) {
          const client = (ws.deserializeAttachment() as Attachment).client
          if (client) this.noteOffence(client, kind)
        }
      },
    })
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG))
    void ctx.blockConcurrencyWhile(async () => {
      const [info, rev, sessions, usage, schedule, alarm, chat, bans, extras] = await Promise.all([
        storage.get<RoomInfo>(ROOM_KEY),
        storage.get<number>(REV_KEY),
        storage.get<SessionRecord[]>(SESSIONS_KEY),
        storage.get<UsageCursor>(USAGE_KEY),
        storage.get<Schedule>(SCHEDULE_KEY),
        storage.getAlarm(),
        storage.list<ChatMessage>({ prefix: CHAT_PREFIX }),
        storage.get<Ban[]>(BANS_KEY),
        storage.get<unknown>([PASSWORD_KEY, GUESSES_KEY, ENDED_KEY, PERSISTENT_KEY]),
      ])
      const sockets = ctx
        .getWebSockets()
        .filter((ws) => ws.readyState === WebSocket.OPEN)
        .map((ws) => ws.deserializeAttachment() as Attachment)
      this.alarmAt = alarm
      this.host.restore(
        info ?? null,
        rev ?? 0,
        sessions ?? [],
        sockets,
        usage ?? null,
        schedule ?? null,
        [...chat.values()],
        bans ?? [],
        {
          password: (extras.get(PASSWORD_KEY) as PasswordRecord | undefined) ?? null,
          guesses: (extras.get(GUESSES_KEY) as GuessRecord[] | undefined) ?? [],
          endedUntil: (extras.get(ENDED_KEY) as number | undefined) ?? null,
          persistent: (extras.get(PERSISTENT_KEY) as PersistentRecord | undefined) ?? null,
        },
      )
      // A room stored before C2 has no schedule: restore made one
      await this.syncAlarm()
    })
  }

  /** RPC from POST /api/rooms: false when a room with this id already exists */
  async create(id: string): Promise<boolean> {
    const created = this.host.create({ id, createdAt: Date.now() })
    await this.syncAlarm()
    return created
  }

  /**
   * RPC from GET /api/rooms/<id>: null when there is no such room. `account`: the signed-in
   * account asking (I2), to say whether it owns this persistent room
   */
  async summary(account: string | null = null): Promise<(RoomSummary & { owner: boolean }) | null> {
    return this.host.summary(account)
  }

  /** RPC from POST /api/account/rooms (I2, e1-t13): false when the slug's room exists */
  async createPersistent(record: PersistentRecord, name: string | null): Promise<boolean> {
    const created = this.host.createPersistent(record, name)
    await this.syncAlarm()
    return created
  }

  /** RPC from /me (I2): a persistent room's settings, null for any other room */
  async settings(): Promise<RoomSettings | null> {
    return this.host.settings()
  }

  /** RPC from PATCH /api/account/rooms/<slug> (I2): the owner changed the settings */
  async updateSettings(change: SettingsChange): Promise<RoomSettings | null> {
    const settings = await this.host.updateSettings(change)
    await this.syncAlarm()
    return settings
  }

  /** RPC from DELETE /api/account/rooms/<slug> and account deletion (I2): the room is gone */
  async destroy(): Promise<void> {
    this.host.destroy()
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
    this.alarmAt = null
  }

  /** RPC from the SFU proxy (worker/sfu.ts) before every call */
  async sfuAccess(
    token: string,
    sessionId: string | null,
    pulls: SfuTrackRef[],
  ): Promise<SfuAccess> {
    return this.host.sfuAccess(token, sessionId, pulls)
  }

  /** RPC from the SFU proxy: it created `sessionId` for the member holding `token` */
  async bindSfu(token: string, sessionId: string): Promise<boolean> {
    return this.host.bindSfu(token, sessionId)
  }

  /** Only the WebSocket upgrade, forwarded by the Worker from /api/rooms/<id>/ws */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    // Someone joining learns the month's state before publishing (the sweep keeps it fresh after)
    if (this.host.exists && Date.now() - this.usageCheckedAt > USAGE_REFRESH_MS) {
      await this.flushUsage()
    }
    const { 0: client, 1: server } = new WebSocketPair()
    // The guess limit (F3) and the upgrade rate (I1) count per network address too: kept as a
    // digest bound to this room
    const ip = await addressKey(request.headers.get('CF-Connecting-IP'), this.roomId(request))
    const clientKey = await requestClientKey(request, this.env)
    const admission = this.host.admit(new URL(request.url).searchParams.get('v'), ip)
    if (!admission.ok) {
      if (admission.code === CloseCode.rateLimited && clientKey) {
        this.noteOffence(clientKey, 'connectLimit')
      }
      // A hibernatable socket closed before the 101 goes out stays open in workerd, so a refused
      // one is a plain socket, closed once the upgrade is done
      server.accept()
      server.close(admission.code, admission.reason)
      return new Response(null, { status: 101, webSocket: client })
    }
    // The account the Worker found signed in on this upgrade (I2): only the Worker can reach this
    // object, and it always replaces the header with what it checked (worker/rooms.ts)
    const account = request.headers.get(ACCOUNT_HEADER) || null
    const attachment: Attachment = {
      conn: crypto.randomUUID(),
      openedAt: Date.now(),
      ip,
      client: clientKey,
      account,
    }
    this.ctx.acceptWebSocket(server, [attachment.conn])
    server.serializeAttachment(attachment)
    this.host.opened(attachment.conn, ip, account)
    await this.syncAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const { conn } = ws.deserializeAttachment() as Attachment
    // Binary frames are not part of the protocol: answered with an error. Oversized text closes
    // the socket (1009, Message Too Big; I1): no client of ours sends one
    if (typeof data === 'string' && data.length > MAX_CLIENT_MESSAGE_CHARS) {
      const { client } = ws.deserializeAttachment() as Attachment
      if (client) this.noteOffence(client, 'flood')
      try {
        ws.close(1009, 'message too big')
      } catch {
        // Already closed
      }
      return
    }
    if (typeof data !== 'string') {
      this.host.message(conn, '')
      return
    }
    // Normally answered by the auto-response without waking the object
    if (data === HEARTBEAT_PING) ws.send(HEARTBEAT_PONG)
    // A `join` checking a password, or a password being set, finishes later (F3)
    await this.host.message(conn, data)
    // `leave` may empty the room or hand the host on
    await this.syncAlarm()
  }

  /** Tells GuardDO (I1) that `client` hit a limit here; best effort, never waited for */
  private noteOffence(client: string, kind: OffenceKind): void {
    const guard = this.env.GUARD.get(this.env.GUARD.idFromName(GUARD_OBJECT))
    void guard.note(client, kind).catch((error: unknown) => console.error('guard note', error))
  }

  async webSocketClose(ws: WebSocket) {
    const { conn } = ws.deserializeAttachment() as Attachment
    this.closing = ws
    try {
      try {
        ws.close()
      } catch {
        // Already closed
      }
      this.host.closed(conn)
    } finally {
      this.closing = null
    }
    // A member who dropped is removed by the sweep once its grace runs out
    await this.syncAlarm()
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  /**
   * The one alarm: RoomHost runs every job that is due (room-host.ts `alarm`). After a sweep the
   * egress goes to UsageDO; a closed room's storage is already gone.
   */
  async alarm() {
    // The alarm that fired is spent
    this.alarmAt = null
    for (const ws of this.ctx.getWebSockets()) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      if (at) this.host.heartbeat((ws.deserializeAttachment() as Attachment).conn, at.getTime())
    }
    const { swept, closed } = this.host.alarm()
    if (swept && !closed) await this.flushUsage()
    await this.syncAlarm()
  }

  /**
   * Hands the egress counted since the last flush to UsageDO (e11-t13) and takes back the
   * month's state, which members see as `RoomView.usage`. A failed call loses that interval's
   * count rather than the room.
   */
  private async flushUsage() {
    const delta = this.host.takeUsage()
    try {
      const usage = this.env.USAGE.get(this.env.USAGE.idFromName(USAGE_OBJECT))
      const status = await usage.record(delta)
      this.usageCheckedAt = Date.now()
      this.host.setUsage(status.state)
    } catch (error) {
      console.error('usage flush failed', error)
    }
  }

  /** Moves the alarm to the room's next job (or drops it when there is none) */
  private async syncAlarm() {
    const next = this.host.nextAlarm()
    if (next === this.alarmAt) return
    this.alarmAt = next
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }

  /** The room's id, from the WebSocket path the Worker forwarded (/api/rooms/<id>/ws) */
  private roomId(request: Request): string {
    return new URL(request.url).pathname.split('/')[3] ?? ''
  }

  private send(connId: string, message: ServerMessage) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets(connId)) {
      if (ws === this.closing) continue
      try {
        ws.send(payload)
      } catch {
        // The socket is closing; webSocketClose cleans up
      }
    }
  }
}
