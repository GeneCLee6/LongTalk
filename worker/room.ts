import { DurableObject } from 'cloudflare:workers'
import {
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_CLIENT_MESSAGE_CHARS,
  SWEEP_INTERVAL_MS,
  type Member,
  type RoomInfo,
  type ServerMessage,
} from '../shared/protocol.ts'
import type { Env } from './app.ts'
import { RoomHost } from './room-host.ts'

/** What each hibernatable socket carries, so the members survive the object waking up */
type Attachment = Member

const ROOM_KEY = 'room'
const REV_KEY = 'rev'

/**
 * One room in its own Durable Object (`idFromName(<room id>)`, ARCHITECTURE.md §2). Only the glue
 * to Cloudflare: storage, the sweep alarm and the WebSockets (hibernation API, one per member,
 * tagged with the member id). What the room does is `RoomHost` (room-host.ts).
 *
 * The heartbeat `ping` is answered with `pong` by the runtime without waking the object; the
 * sweep alarm reads when each socket last pinged.
 */
export class RoomDO extends DurableObject<Env> {
  private readonly host: RoomHost
  /** The socket being closed in `webSocketClose`: `getWebSockets()` still lists it */
  private closing: WebSocket | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    this.host = new RoomHost({
      sockets: {
        send: (memberId, message) => this.send(memberId, message),
        close: (memberId, code, reason) => {
          for (const ws of ctx.getWebSockets(memberId)) {
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
      },
      now: Date.now,
      newMemberId: () => crypto.randomUUID(),
    })
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG))
    void ctx.blockConcurrencyWhile(async () => {
      const [info, rev] = await Promise.all([
        storage.get<RoomInfo>(ROOM_KEY),
        storage.get<number>(REV_KEY),
      ])
      const members = ctx
        .getWebSockets()
        .filter((ws) => ws.readyState === WebSocket.OPEN)
        .map((ws) => ws.deserializeAttachment() as Attachment)
      this.host.restore(info ?? null, rev ?? 0, members)
    })
  }

  /** RPC from POST /api/rooms: false when a room with this id already exists */
  async create(id: string): Promise<boolean> {
    return this.host.create({ id, createdAt: Date.now() })
  }

  /** Only the WebSocket upgrade, forwarded by the Worker from /api/rooms/<id>/ws */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    const admission = this.host.admit(new URL(request.url).searchParams.get('v'))
    if (!admission.ok) {
      // A hibernatable socket closed before the 101 goes out stays open in workerd, so a refused
      // one is a plain socket, closed once the upgrade is done
      server.accept()
      server.close(admission.code, admission.reason)
      return new Response(null, { status: 101, webSocket: client })
    }
    const member = this.host.newMember()
    this.ctx.acceptWebSocket(server, [member.id])
    server.serializeAttachment(member satisfies Attachment)
    this.host.connected(member)
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const { id } = ws.deserializeAttachment() as Attachment
    // Binary frames and oversized text are not part of the protocol: answered with an error
    if (typeof data !== 'string' || data.length > MAX_CLIENT_MESSAGE_CHARS) {
      this.host.message(id, '')
      return
    }
    // Normally answered by the auto-response without waking the object
    if (data === HEARTBEAT_PING) ws.send(HEARTBEAT_PONG)
    this.host.message(id, data)
  }

  async webSocketClose(ws: WebSocket) {
    const { id } = ws.deserializeAttachment() as Attachment
    this.closing = ws
    try {
      try {
        ws.close()
      } catch {
        // Already closed
      }
      this.host.disconnected(id)
    } finally {
      this.closing = null
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  /** The sweep: drops members whose heartbeat stopped; runs while anyone is connected */
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      if (at) this.host.heartbeat((ws.deserializeAttachment() as Attachment).id, at.getTime())
    }
    this.host.sweep()
    if (this.host.memberCount > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
  }

  private send(memberId: string, message: ServerMessage) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets(memberId)) {
      if (ws === this.closing) continue
      try {
        ws.send(payload)
      } catch {
        // The socket is closing; webSocketClose cleans up
      }
    }
  }
}
