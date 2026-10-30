import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  parseServerMessage,
  roomSocketPath,
  viewAsJson,
  type ClientMessage,
  type RoomView,
} from '../../shared/protocol.ts'

export type RoomStatus = 'connecting' | 'open' | 'closed' | 'notFound' | 'full' | 'outdated'

export interface RoomConnectionState {
  status: RoomStatus
  /** This browser's member id, once welcomed */
  you: string | null
  view: RoomView | null
}

/** The bits of WebSocket the connection uses, so tests can pass a fake */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
}

export interface RoomConnectionOptions {
  createSocket?: (url: string) => SocketLike
  /** Defaults to the page's origin with ws: or wss: */
  origin?: string
}

const OPEN = 1

function statusForClose(code: number): RoomStatus {
  switch (code) {
    case CloseCode.roomNotFound:
      return 'notFound'
    case CloseCode.roomFull:
      return 'full'
    case CloseCode.versionMismatch:
      return 'outdated'
    default:
      return 'closed'
  }
}

/**
 * The browser's end of the room's WebSocket (shared/protocol.ts): keeps the room view up to date
 * from `welcome`, `patch` and `snapshot`, asks for a `snapshot` when a patch is missing, and
 * sends the heartbeat. Reconnecting is e2-t08 (B3); a closed connection stays closed.
 */
export class RoomConnection {
  private readonly url: string
  private readonly createSocket: (url: string) => SocketLike
  private socket: SocketLike | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private rev = -1
  private state: RoomConnectionState = { status: 'connecting', you: null, view: null }
  private readonly listeners = new Set<() => void>()

  constructor(roomId: string, options: RoomConnectionOptions = {}) {
    const origin =
      options.origin ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    this.url = origin + roomSocketPath(roomId)
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
  }

  getState = (): RoomConnectionState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.socket) return
    this.rev = -1
    this.update({ status: 'connecting', you: null, view: null })
    const socket = this.createSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.heartbeat = setInterval(() => {
        if (socket.readyState === OPEN) socket.send(HEARTBEAT_PING)
      }, HEARTBEAT_INTERVAL_MS)
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.receive(event.data)
    }
    socket.onclose = (event) => {
      this.stopHeartbeat()
      this.update({ ...this.state, status: statusForClose(event.code) })
    }
  }

  stop(): void {
    this.stopHeartbeat()
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.onopen = socket.onmessage = socket.onclose = null
    socket.close(1000, 'left')
  }

  private receive(raw: string): void {
    if (raw === HEARTBEAT_PONG) return
    const message = parseServerMessage(raw)
    if (!message) return
    switch (message.t) {
      case 'welcome':
        this.rev = message.rev
        this.update({ status: 'open', you: message.you, view: message.state })
        return
      case 'snapshot':
        this.rev = message.rev
        this.update({ ...this.state, view: message.state })
        return
      case 'patch': {
        // Before the welcome, or a patch already contained in a later snapshot
        if (!this.state.view || message.rev <= this.rev) return
        if (message.rev !== this.rev + 1) {
          this.send({ t: 'resync' })
          return
        }
        this.rev = message.rev
        const view = applyPatch(viewAsJson(this.state.view), message.ops) as RoomView
        this.update({ ...this.state, view })
        return
      }
      case 'error':
        return
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message))
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private update(state: RoomConnectionState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
