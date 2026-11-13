import {
  CHAT_CHUNK,
  CHAT_HISTORY,
  ChatRateLimit,
  MAX_CHAT_CHARS,
  normalizeChatText,
  type ChatMessage,
} from '../../shared/chat.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  RECONNECT_GRACE_MS,
  parseServerMessage,
  roomSocketPath,
  viewAsJson,
  type AnnotationMessage,
  type AnnotationsMessage,
  type ClientMessage,
  type ErrorCode,
  type LobbyMessage,
  type NoticeMessage,
  type PairCodeMessage,
  type ReactionMessage,
  type RoomView,
} from '../../shared/protocol.ts'
import { PAIRING_CODE_TTL_MS, type ControllerServerMessage } from '../../shared/control.ts'
import { REACTION_RATE, type Reaction } from '../../shared/reactions.ts'
import { PASSWORD_WAIT_MS } from '../../shared/password.ts'
import { Backoff } from './backoff.ts'

/**
 * - `connecting`: the first socket is opening
 * - `open`: welcomed; the view is live
 * - `reconnecting`: the socket dropped; trying again with the same token (the view is the last
 *   one known)
 * - `lost`: gave up after RECONNECT_GRACE_MS; `retry()` tries again
 * - `notFound`, `full`, `outdated`, `replaced`: the server closed with that reason; final
 * - `removed`: the host removed this member, or this browser is still banned (F1); final
 * - `ended`: the host ended the meeting (F1); final
 * - `waiting`: in the waiting room (F2): `lobby` says where in the queue; the view is null
 * - `locked`: the room is locked, nobody new gets in (F2); final
 * - `denied`: the host turned us away from the waiting room, or we asked again too soon (F2);
 *   final
 * - `waitExpired`: waited WAIT_TIMEOUT_MS without being admitted (F2); final
 * - `passwordRequired`, `passwordWrong`: the room has a password, and the join carried none or a
 *   wrong one (F3); final (the pre-join screen asks again)
 * - `passwordWait`: too many wrong passwords; `passwordWaitUntil` says until when (F3); final
 * - `rateLimited`: the room closed us for too many connections or messages (I1); final
 * - `recordingDeclined`: we did not agree to a recording within CONSENT_TIMEOUT_MS (I4); final
 */
export type RoomStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'lost'
  | 'notFound'
  | 'full'
  | 'outdated'
  | 'replaced'
  | 'removed'
  | 'ended'
  | 'waiting'
  | 'locked'
  | 'denied'
  | 'waitExpired'
  | 'passwordRequired'
  | 'passwordWrong'
  | 'passwordWait'
  | 'rateLimited'
  | 'recordingDeclined'

/**
 * The pairing code this member asked for (N2, e9-t02; `pairCode`, to us alone). `code` null: it
 * was used, voided or ran out. `deadline` is this browser's own clock: PAIRING_CODE_TTL_MS from
 * when it arrived, never later than the room's `expiresAt` would say (a clock ahead of the room's
 * would otherwise end it early, one behind would keep it too long). `seq` grows with every
 * `pairCode`, so whoever asked can tell the answer from what was there before.
 */
export interface PairCodeState {
  code: string | null
  deadline: number | null
  seq: number
}

/**
 * Our own remote control (N3, e9-t04): the request we made (`controlRequested`, its id for
 * `controlCancel`) or the grant we hold (`controlGranted`, its id on every batch). Bound to this
 * socket: a new welcome clears it, as the room has ended it (`controllerLeft`).
 */
export interface MyControl {
  agent: string
  request: string | null
  grant: string | null
  /** The grant's end on the room's clock; null: until stopped (or still asking) */
  until: number | null
}

/** Where we are in the waiting room (F2): the latest `lobby` */
export type LobbyState = Pick<LobbyMessage, 'position' | 'count' | 'room' | 'hostPresent'> & {
  /** The meeting is being recorded (I4): the waiting screen says so */
  recording?: boolean
}

export interface RoomConnectionState {
  status: RoomStatus
  /** This browser's member id, once welcomed */
  you: string | null
  /** The member's session token, once welcomed: the SFU proxy asks for it (worker/sfu.ts) */
  token: string | null
  view: RoomView | null
  /** How many times the room welcomed this connection: grows with every rejoin */
  welcomes: number
  /** The room's chat (D3), oldest first: the history after each welcome, then what arrives */
  chat: ChatMessage[]
  /** The room has sent its chat history at least once (the messages before it are not new) */
  chatLoaded: boolean
  /**
   * The newest chat id the room replayed as history rather than sent as new (0: none yet): the
   * first history after joining, and a breakout room's history after a move (L3, every frame
   * marked `regroup`). Not a reconnect's history: what it brings that we had not seen was said
   * while we were away, and is new to us (a member moved while disconnected gets the new room's
   * history counted so; accepted). useChatNotifications neither counts nor previews what is at or
   * below it.
   */
  chatHistoryUntil: number
  /**
   * In the waiting room (F2): the latest `lobby`, kept while the socket reconnects; null once
   * the room welcomed us (admitted), and before
   */
  lobby: LobbyState | null
  /** After `passwordWait` (F3): when this browser may try a password again (epoch ms) */
  passwordWaitUntil: number | null
  /** What we answered to the poll on now (L5, `pollVoted`): the view does not say on an anonymous one */
  pollVote: { poll: number; choices: number[] } | null
  /** The latest pairing code the room gave us (N2), on this socket; null before any */
  pairCode: PairCodeState | null
  /** Our remote control request or grant (N3), on this socket; null for none */
  control: MyControl | null
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

/**
 * Who joins: the name from the pre-join screen, the token from last time, if any, and this
 * browser's own id (session.ts loadClientId; what a removal bans, F1)
 */
export interface JoinAs {
  name: string
  token: string | null
  client: string | null
  /**
   * The room's password (F3), for someone new to a room that has one; sent only in `join`.
   * A member coming back with its token does not need it.
   */
  password?: string | null
}

export interface RoomConnectionOptions {
  createSocket?: (url: string) => SocketLike
  /** Defaults to the page's origin with ws: or wss: */
  origin?: string
  /** Called with the session token every welcome carries, to remember it across a reload */
  onToken?: (token: string) => void
  /** Reconnect pacing; defaults to 1–8 s with jitter, giving up after RECONNECT_GRACE_MS */
  backoff?: Backoff
}

const OPEN = 1

/**
 * What became of a chat message (D3): `sent` went to the room (it shows once the room echoes
 * it); the others were not sent and the text should stay in the box: `empty` (nothing but
 * spaces), `tooLong` (over MAX_CHAT_CHARS), `rateLimited` (over CHAT_RATE: the room would refuse
 * it), `offline` (the socket is not open)
 */
export type ChatSendResult = 'sent' | 'empty' | 'tooLong' | 'rateLimited' | 'offline'

/** Once the page is back in the foreground, a socket that does not answer a ping this soon is dead */
export const PROBE_TIMEOUT_MS = 5_000
/**
 * The first history after joining arrives in CHAT_CHUNK frames back to back (worker/room-host.ts
 * sends them in one go), and only its first frame says so (`reset`): a frame without it this soon
 * after a full one is the rest of it, not a new message. A breakout move's history needs no
 * guess: every frame of it is marked `regroup`
 */
const REPLAY_FRAME_MS = 2_000

/** The close code the browser uses when it drops a socket it takes for dead */
const CLIENT_DROP = 4000

/** Closes after which reconnecting is pointless: the server said why */
function finalStatus(code: number): RoomStatus | null {
  switch (code) {
    case CloseCode.roomNotFound:
      return 'notFound'
    case CloseCode.roomFull:
      return 'full'
    case CloseCode.versionMismatch:
      return 'outdated'
    case CloseCode.replaced:
      return 'replaced'
    case CloseCode.removed:
      return 'removed'
    case CloseCode.ended:
      return 'ended'
    case CloseCode.locked:
      return 'locked'
    case CloseCode.denied:
      return 'denied'
    case CloseCode.waitExpired:
      return 'waitExpired'
    case CloseCode.passwordRequired:
      return 'passwordRequired'
    case CloseCode.passwordWrong:
      return 'passwordWrong'
    case CloseCode.passwordWait:
      return 'passwordWait'
    case CloseCode.rateLimited:
      return 'rateLimited'
    case CloseCode.recordingDeclined:
      return 'recordingDeclined'
    default:
      return null
  }
}

/**
 * The browser's end of the room's WebSocket (shared/protocol.ts): joins with a name and the
 * session token, keeps the room view up to date from `welcome`, `patch` and `snapshot`, asks for
 * a `snapshot` when a patch is missing, and sends the heartbeat.
 *
 * Reconnecting (e2-t08): a socket that closes for any reason but a final close code is opened
 * again with exponential backoff and jitter (backoff.ts), joining with the latest token, so the
 * room gives back the same member while it is within RECONNECT_GRACE_MS. A socket is also taken
 * for dead when a heartbeat is still unanswered at the next one, when the browser goes offline,
 * and when the page comes back to the foreground and a ping is not answered within
 * PROBE_TIMEOUT_MS. Coming online or to the foreground tries again at once instead of waiting.
 * After RECONNECT_GRACE_MS of failures the status is `lost` until `retry()` (or `online`).
 */
export class RoomConnection {
  private readonly url: string
  private readonly createSocket: (url: string) => SocketLike
  private readonly onToken: (token: string) => void
  private readonly backoff: Backoff
  private name: string
  private token: string | null
  private readonly client: string | null
  private readonly password: string | null
  private socket: SocketLike | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  /** A ping went out and nothing came back since */
  private awaitingPong = false
  private running = false
  /** The rev of the current socket's view; -1 until its welcome */
  private rev = -1
  /**
   * While the first history after joining arrives in CHAT_CHUNK frames: until when a frame
   * without `reset` still belongs to it (REPLAY_FRAME_MS). Null: the last frame was not full, or
   * it was not that history, so whatever comes next is new
   */
  private firstReplayUntil: number | null = null
  /** How many `pairCode` arrived, on any socket: PairCodeState.seq */
  private pairSeq = 0
  private state: RoomConnectionState = {
    status: 'connecting',
    you: null,
    token: null,
    view: null,
    welcomes: 0,
    chat: [],
    chatLoaded: false,
    chatHistoryUntil: 0,
    lobby: null,
    passwordWaitUntil: null,
    pollVote: null,
    pairCode: null,
    control: null,
  }
  /** The room's CHAT_RATE, checked here too so a refused message stays in the box */
  private readonly chatRate = new ChatRateLimit()
  /** The room's REACTION_RATE, so a reaction the room would drop is not sent (G3) */
  private readonly reactionRate = new ChatRateLimit(REACTION_RATE)
  private readonly listeners = new Set<() => void>()
  private readonly errorListeners = new Set<(code: ErrorCode) => void>()
  private readonly noticeListeners = new Set<(notice: NoticeMessage) => void>()
  private readonly controlListeners = new Set<(message: ControllerServerMessage) => void>()
  private readonly reactionListeners = new Set<(reaction: ReactionMessage) => void>()
  private readonly annotationListeners = new Set<
    (message: AnnotationMessage | AnnotationsMessage) => void
  >()

  constructor(roomId: string, join: JoinAs, options: RoomConnectionOptions = {}) {
    const origin =
      options.origin ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
    this.url = origin + roomSocketPath(roomId)
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.onToken = options.onToken ?? (() => {})
    this.backoff = options.backoff ?? new Backoff({ giveUpAfterMs: RECONNECT_GRACE_MS })
    this.name = join.name
    this.token = join.token
    this.client = join.client
    this.password = join.password ?? null
  }

  getState = (): RoomConnectionState => this.state

  /** Welcomed, right now (not as of the last render): what is sent reaches the room */
  isOpen = (): boolean => this.state.status === 'open'

  /**
   * The room refused something this member sent (`error`: `share_full`, `forbidden`, …); returns
   * a function that removes the listener
   */
  onError = (listener: (code: ErrorCode) => void): (() => void) => {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /**
   * A host did something to this member (`notice`: muted, camera off, share stopped, F1); returns
   * a function that removes the listener
   */
  onNotice = (listener: (notice: NoticeMessage) => void): (() => void) => {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  /**
   * What the room says about our own remote control (N3): requested, refused (why), granted, ended
   * (why). The state (`control`) follows on its own; this is for saying what happened
   */
  onControl = (listener: (message: ControllerServerMessage) => void): (() => void) => {
    this.controlListeners.add(listener)
    return () => this.controlListeners.delete(listener)
  }

  /**
   * Someone in the room reacted (G3, `reaction`; our own come back too); returns a function that
   * removes the listener
   */
  onReaction = (listener: (reaction: ReactionMessage) => void): (() => void) => {
    this.reactionListeners.add(listener)
    return () => this.reactionListeners.delete(listener)
  }

  /**
   * What happens to the strokes on the shares (J2, `annotation`, `annotations`): not in the state,
   * or a stroke being drawn would render the whole room ten times a second. Returns a function
   * that removes the listener
   */
  onAnnotation = (listener: (message: AnnotationMessage | AnnotationsMessage) => void) => {
    this.annotationListeners.add(listener)
    return () => {
      this.annotationListeners.delete(listener)
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.backoff.reset()
    this.update({
      status: 'connecting',
      you: null,
      token: null,
      view: null,
      welcomes: 0,
      chat: [],
      chatLoaded: false,
      chatHistoryUntil: 0,
      lobby: null,
      passwordWaitUntil: null,
      pollVote: null,
      pairCode: null,
      control: null,
    })
    this.open()
  }

  /**
   * Closes the socket. With `leave`, tells the room first so the member is removed at once;
   * without, the room keeps the member as reconnecting for a while (a page reload does this).
   * `host` (F3): a host leaving names who takes over.
   */
  stop({ leave = false, host }: { leave?: boolean; host?: string } = {}): void {
    this.running = false
    this.clearTimers()
    const socket = this.socket
    if (!socket) return
    this.socket = null
    if (leave && socket.readyState === OPEN) {
      const message: ClientMessage = host === undefined ? { t: 'leave' } : { t: 'leave', host }
      socket.send(JSON.stringify(message))
    }
    socket.onopen = socket.onmessage = socket.onclose = null
    socket.close(1000, leave ? 'left' : 'closed')
  }

  /** After `lost`: try again from the first delay */
  retry = (): void => {
    if (!this.running || this.state.status !== 'lost') return
    this.backoff.reset()
    this.update({ ...this.state, status: 'reconnecting' })
    this.open()
  }

  /** The browser is online again: try now instead of waiting for the timer */
  online(): void {
    if (!this.running) return
    if (this.state.status === 'lost') this.retry()
    else if (this.retryTimer !== null) this.attemptNow()
    else if (this.state.status === 'open') this.probe()
  }

  /** The browser went offline: the socket cannot be trusted any more */
  offline(): void {
    if (this.running && this.socket) this.drop()
  }

  /** The page came back to the foreground: try again now, or check the socket still answers */
  visible(): void {
    if (!this.running) return
    if (this.retryTimer !== null) this.attemptNow()
    else if (this.state.status === 'open') this.probe()
  }

  private open(): void {
    this.clearTimers()
    this.rev = -1
    this.awaitingPong = false
    const socket = this.createSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.send({
        t: 'join',
        name: this.name,
        token: this.token,
        client: this.client,
        // Only someone new needs it; the room ignores it for a token it knows
        ...(this.password !== null && this.token === null ? { password: this.password } : {}),
      })
      this.heartbeat = setInterval(() => this.beat(socket), HEARTBEAT_INTERVAL_MS)
    }
    socket.onmessage = (event) => {
      this.awaitingPong = false
      if (typeof event.data === 'string') this.receive(event.data)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      const final = finalStatus(event.code)
      if (final === 'passwordWait') {
        // The reason is how long to wait; a malformed one waits the usual time
        const left = Number(event.reason)
        const ms = Number.isFinite(left) && left > 0 ? left : PASSWORD_WAIT_MS
        this.update({ ...this.state, status: final, passwordWaitUntil: Date.now() + ms })
      } else if (final) this.update({ ...this.state, status: final })
      else this.reconnectLater()
    }
  }

  /** One heartbeat: a ping, unless the last one is still unanswered (the socket is dead) */
  private beat(socket: SocketLike): void {
    if (socket !== this.socket || socket.readyState !== OPEN) return
    if (this.awaitingPong) {
      this.drop()
      return
    }
    this.awaitingPong = true
    socket.send(HEARTBEAT_PING)
  }

  /** A ping now; without an answer within PROBE_TIMEOUT_MS the socket is dropped */
  private probe(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN || this.probeTimer !== null) return
    this.awaitingPong = true
    socket.send(HEARTBEAT_PING)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.socket === socket && this.awaitingPong) this.drop()
    }, PROBE_TIMEOUT_MS)
  }

  /** Gives up on the current socket and reconnects */
  private drop(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.onopen = socket.onmessage = socket.onclose = null
    try {
      socket.close(CLIENT_DROP, 'reconnecting')
    } catch {
      // Already closing
    }
    this.clearTimers()
    this.reconnectLater()
  }

  private reconnectLater(): void {
    if (!this.running) return
    const delay = this.backoff.next()
    if (delay === null) {
      this.update({ ...this.state, status: 'lost' })
      return
    }
    if (this.state.status !== 'reconnecting') this.update({ ...this.state, status: 'reconnecting' })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  private attemptNow(): void {
    this.backoff.restart()
    this.open()
  }

  private receive(raw: string): void {
    if (raw === HEARTBEAT_PONG) return
    const message = parseServerMessage(raw)
    if (!message) return
    switch (message.t) {
      case 'welcome':
        this.rev = message.rev
        this.token = message.token
        this.backoff.reset()
        this.onToken(message.token)
        this.update({
          ...this.state,
          status: 'open',
          you: message.you,
          token: message.token,
          view: message.state,
          welcomes: this.state.welcomes + 1,
          lobby: null,
          pollVote: null,
          // A code from an earlier socket may be gone: ask again rather than show a stale one
          pairCode: null,
          // The room ended any control bound to the earlier socket (N3, D4)
          control: null,
        })
        this.firstReplayUntil = null
        return
      case 'lobby': {
        // In the waiting room (F2): the token brings us back to the same place after a reload
        this.token = message.token
        this.backoff.reset()
        this.onToken(message.token)
        const { position, count, room, hostPresent, recording = false } = message
        this.update({
          ...this.state,
          status: 'waiting',
          you: message.you,
          token: message.token,
          view: null,
          lobby: { position, count, room, hostPresent, recording },
        })
        return
      }
      case 'snapshot':
        if (this.rev < 0) return
        this.rev = message.rev
        this.update({ ...this.state, view: message.state })
        return
      case 'patch': {
        // Before this socket's welcome, or a patch already contained in a later snapshot
        if (this.rev < 0 || !this.state.view || message.rev <= this.rev) return
        if (message.rev !== this.rev + 1) {
          this.send({ t: 'resync' })
          return
        }
        this.rev = message.rev
        const view = applyPatch(viewAsJson(this.state.view), message.ops) as RoomView
        this.update({ ...this.state, view })
        return
      }
      case 'pollVoted':
        // Only after this socket's welcome, which clears what an earlier socket heard
        if (this.rev < 0) return
        this.update({
          ...this.state,
          pollVote: { poll: message.poll, choices: message.choices },
        })
        return
      case 'pairCode':
        // Only after this socket's welcome, which clears what an earlier socket heard (N2)
        if (this.rev < 0) return
        this.receivePairCode(message)
        return
      case 'error':
        for (const listener of this.errorListeners) listener(message.code)
        return
      case 'controlRequested':
      case 'controlRefused':
      case 'controlGranted':
      case 'controlEnd':
        // Only after this socket's welcome, which clears what an earlier socket held (N3)
        if (this.rev < 0) return
        this.receiveControl(message)
        return
      case 'notice':
        if (this.rev < 0) return
        for (const listener of this.noticeListeners) listener(message)
        return
      case 'reaction':
        if (this.rev < 0) return
        for (const listener of this.reactionListeners) listener(message)
        return
      case 'annotation':
      case 'annotations':
        if (this.rev < 0) return
        for (const listener of this.annotationListeners) listener(message)
        return
      case 'chat': {
        // Only after this socket's welcome (the history follows it)
        if (this.rev < 0) return
        const full = message.messages.length === CHAT_CHUNK
        if (message.reset) {
          // A breakout move's history (L3, `regroup`): none of it new. After a welcome: the
          // history, not new the first time; a reconnect's may bring what was said while we were
          // away
          const first = !message.regroup && !this.state.chatLoaded
          const history = first || message.regroup === true
          this.firstReplayUntil = first && full ? Date.now() + REPLAY_FRAME_MS : null
          this.update({
            ...this.state,
            chat: message.messages,
            chatLoaded: true,
            chatHistoryUntil: history
              ? Math.max(this.state.chatHistoryUntil, message.messages.at(-1)?.id ?? 0)
              : this.state.chatHistoryUntil,
          })
          return
        }
        // The rest of a history the room sends in several frames: marked when it is a move's,
        // guessed from the timing for the first one after joining
        const firstReplay = this.firstReplayUntil !== null && Date.now() <= this.firstReplayUntil
        this.firstReplayUntil = firstReplay && full ? Date.now() + REPLAY_FRAME_MS : null
        const history = message.regroup === true || firstReplay
        const last = this.state.chat.at(-1)?.id ?? 0
        const added = message.messages.filter((m) => m.id > last)
        if (added.length === 0) return
        this.update({
          ...this.state,
          chat: [...this.state.chat, ...added].slice(-CHAT_HISTORY),
          chatHistoryUntil: history
            ? Math.max(this.state.chatHistoryUntil, added.at(-1)!.id)
            : this.state.chatHistoryUntil,
        })
        return
      }
    }
  }

  /** Our own control (N3): what we asked, or hold, now */
  private receiveControl(message: ControllerServerMessage): void {
    const current = this.state.control
    let control = current
    switch (message.t) {
      case 'controlRequested':
        control = { agent: message.agent, request: message.request, grant: null, until: null }
        break
      case 'controlRefused':
        if (current?.request === message.request) control = null
        break
      case 'controlGranted':
        control = { agent: message.agent, request: null, grant: message.grant, until: message.until }
        break
      case 'controlEnd':
        if (current?.grant === message.grant) control = null
        break
    }
    if (control !== current) this.update({ ...this.state, control })
    for (const listener of this.controlListeners) listener(message)
  }

  /** `pairCode` (N2): kept in the state for the 連接我的電腦 dialog */
  private receivePairCode({ code, expiresAt }: PairCodeMessage): void {
    const now = Date.now()
    const deadline =
      code === null
        ? null
        : now + Math.min(PAIRING_CODE_TTL_MS, Math.max(0, (expiresAt ?? Infinity) - now))
    this.pairSeq += 1
    this.update({ ...this.state, pairCode: { code, deadline, seq: this.pairSeq } })
  }

  /** Sends a message if the socket is open; dropped otherwise (the room resends state on join) */
  send = (message: ClientMessage): void => {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message))
  }

  /**
   * Sends a chat message to everyone (D3, e5-t01), or (`to`, O4 e5-t09) privately to that member;
   * see ChatSendResult. The room decides whether the private one may go (it answers `forbidden`)
   */
  sendChat = (raw: string, to: string | null = null, now: number = Date.now()): ChatSendResult => {
    const text = normalizeChatText(raw)
    if (text === null) return [...raw.trim()].length > MAX_CHAT_CHARS ? 'tooLong' : 'empty'
    if (this.state.status !== 'open' || this.socket?.readyState !== OPEN) return 'offline'
    if (!this.chatRate.take('self', now)) return 'rateLimited'
    this.send(to === null ? { t: 'chat', text } : { t: 'chat', text, to })
    return 'sent'
  }

  /**
   * A reaction to everyone (G3, e5-t03): `sent`, or why not (`rateLimited`: over REACTION_RATE,
   * the room would drop it; `offline`). It shows when the room sends it back.
   */
  sendReaction = (
    emoji: Reaction,
    now: number = Date.now(),
  ): 'sent' | 'rateLimited' | 'offline' => {
    if (this.state.status !== 'open' || this.socket?.readyState !== OPEN) return 'offline'
    if (!this.reactionRate.take('self', now)) return 'rateLimited'
    this.send({ t: 'react', emoji })
    return 'sent'
  }

  /**
   * The member's own name from now on (e1-t05): told to the room now, and used by every later
   * `join`, so a reconnect does not bring the old name back. `name` is already normalized.
   */
  rename = (name: string): void => {
    this.name = name
    this.send({ t: 'rename', name })
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.probeTimer !== null) clearTimeout(this.probeTimer)
    this.heartbeat = this.retryTimer = this.probeTimer = null
  }

  private update(state: RoomConnectionState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
