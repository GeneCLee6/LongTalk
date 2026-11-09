import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_CHUNK } from '../../shared/chat.ts'
import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { Backoff } from '../../src/room/backoff.ts'
import { PROBE_TIMEOUT_MS, RoomConnection, type SocketLike } from '../../src/room/RoomConnection.ts'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  closedWith: number | undefined
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number) {
    this.closedWith = code
  }
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  receive(message: ServerMessage | string) {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  serverClose(code: number) {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code }))
  }
}

const room = {
  id: 'abcdefghij',
  createdAt: 1,
  name: null,
  createdBy: null,
  startedAt: null,
  shares: {},
  locked: false,
  waitingRoom: false,
  passwordSetAt: null,
  spotlight: null,
  recordings: {},
  annotationPolicy: 'everyone' as const,
  whiteboard: null,
}
const member = (id: string) => ({
  id,
  name: id.toUpperCase(),
  role: 'participant' as const,
  joinedAt: 1,
  reconnecting: false,
  tracks: [],
  hand: null,
  signal: null,
  mayRecord: false,
})
const TOKEN = 'T'.repeat(43)
const welcome = (rev: number, members: Record<string, ReturnType<typeof member>> = {}) =>
  ({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: TOKEN,
    rev,
    state: { room, members, waiting: {}, usage: 'normal' as const },
  }) as const

/** This browser's own id (F1) */
const CLIENT = 'browser-id-0123456789'

/** No jitter in tests: the delays are exactly 1, 2, 4, 8, 8… s */
const steadyBackoff = () => new Backoff({ random: () => 0.5, giveUpAfterMs: RECONNECT_GRACE_MS })

function connect(token: string | null = null) {
  const created: FakeSocket[] = []
  const onToken = vi.fn()
  const connection = new RoomConnection(
    'abcdefghij',
    { name: 'Gene', token, client: CLIENT },
    {
      origin: 'wss://longtalk.test',
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        created.push(socket)
        return socket
      },
      onToken,
      backoff: steadyBackoff(),
    },
  )
  connection.start()
  return {
    connection,
    socket: created[0],
    onToken,
    created,
    /** The socket opened last */
    latest: () => created.at(-1)!,
  }
}

describe('RoomConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens the room's versioned WebSocket", () => {
    const { connection, socket } = connect()
    expect(socket.url).toBe(`wss://longtalk.test/api/rooms/abcdefghij/ws?v=${PROTOCOL_VERSION}`)
    expect(connection.getState().status).toBe('connecting')
  })

  it('joins with its name and the token from last time as soon as the socket opens', () => {
    const { socket } = connect(TOKEN)
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.sent).toEqual([
      JSON.stringify({ t: 'join', name: 'Gene', token: TOKEN, client: CLIENT }),
    ])
    const fresh = connect()
    fresh.socket.open()
    expect(fresh.socket.sent).toEqual([
      `{"t":"join","name":"Gene","token":null,"client":"${CLIENT}"}`,
    ])
  })

  it("tells its error listeners about the room's refusals (D1: share_busy)", () => {
    const { connection, socket } = connect()
    socket.open()
    socket.receive(welcome(1))
    const heard = vi.fn()
    const off = connection.onError(heard)
    socket.receive({ t: 'error', code: 'share_full' })
    expect(heard).toHaveBeenCalledWith('share_full')
    off()
    socket.receive({ t: 'error', code: 'forbidden' })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('waits in the lobby (F2): keeps its token and place, then follows the room once welcomed', () => {
    const { connection, socket, onToken, latest } = connect()
    socket.open()
    const lobby = {
      t: 'lobby',
      v: PROTOCOL_VERSION,
      you: 'a',
      token: TOKEN,
      position: 2,
      count: 2,
      room: { name: null, createdBy: 'Wei' },
      hostPresent: true,
      recording: false,
    } as const
    socket.receive(lobby)
    expect(connection.getState()).toMatchObject({
      status: 'waiting',
      you: 'a',
      token: TOKEN,
      view: null,
      welcomes: 0,
      lobby: {
        position: 2,
        count: 2,
        room: { name: null, createdBy: 'Wei' },
        hostPresent: true,
        recording: false,
      },
    })
    expect(onToken).toHaveBeenCalledWith(TOKEN)
    // The socket drops: the lobby stays while it reconnects with the token
    socket.serverClose(1006)
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', lobby: { position: 2 } })
    vi.advanceTimersByTime(1000)
    latest().open()
    expect(JSON.parse(latest().sent[0])).toMatchObject({ t: 'join', token: TOKEN })
    latest().receive({ ...lobby, position: 1, count: 1 })
    expect(connection.getState().lobby).toMatchObject({ position: 1 })
    // Admitted
    latest().receive(welcome(4, { a: member('a') }))
    expect(connection.getState()).toMatchObject({ status: 'open', lobby: null, welcomes: 1 })
    expect(connection.getState().view?.members.a).toBeDefined()
  })

  it('hands over the session token of every welcome', () => {
    const { socket, onToken } = connect()
    socket.open()
    socket.receive(welcome(1))
    expect(onToken).toHaveBeenCalledExactlyOnceWith(TOKEN)
  })

  it('follows the room from the welcome and patches', () => {
    const { connection, socket } = connect()
    const listener = vi.fn()
    connection.subscribe(listener)
    socket.open()
    socket.receive(welcome(4, { a: member('a') }))
    expect(connection.getState()).toMatchObject({ status: 'open', you: 'a' })
    socket.receive({
      t: 'patch',
      rev: 5,
      ops: [{ op: 'set', path: ['members', 'b'], value: member('b') }],
    })
    expect(connection.getState().view?.members).toEqual({ a: member('a'), b: member('b') })
    socket.receive({ t: 'patch', rev: 6, ops: [{ op: 'del', path: ['members', 'a'] }] })
    expect(connection.getState().view?.members).toEqual({ b: member('b') })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('asks for a snapshot when a patch is missing', () => {
    const { connection, socket } = connect()
    socket.open()
    socket.receive(welcome(1))
    socket.sent = []
    socket.receive({
      t: 'patch',
      rev: 3,
      ops: [{ op: 'set', path: ['members', 'c'], value: member('c') }],
    })
    expect(socket.sent).toEqual(['{"t":"resync"}'])
    expect(connection.getState().view?.members).toEqual({})
    socket.receive({
      t: 'snapshot',
      rev: 3,
      state: { room, members: { c: member('c') }, waiting: {}, usage: 'normal' },
    })
    // An old patch already in the snapshot is ignored; the next one applies
    socket.receive({ t: 'patch', rev: 3, ops: [{ op: 'del', path: ['members', 'c'] }] })
    socket.receive({
      t: 'patch',
      rev: 4,
      ops: [{ op: 'set', path: ['members', 'd'], value: member('d') }],
    })
    expect(connection.getState().view?.members).toEqual({ c: member('c'), d: member('d') })
  })

  it('sends the heartbeat every 15 seconds and ignores pong and junk', () => {
    const { connection, socket } = connect()
    socket.open()
    socket.sent = []
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    socket.receive('pong')
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(socket.sent).toEqual(['ping', 'ping'])
    socket.receive('pong')
    socket.receive('{"t":"mystery"}')
    expect(connection.getState().status).toBe('connecting')
  })

  it.each([
    [CloseCode.roomNotFound, 'notFound'],
    [CloseCode.roomFull, 'full'],
    [CloseCode.versionMismatch, 'outdated'],
    [CloseCode.replaced, 'replaced'],
    [CloseCode.removed, 'removed'],
    [CloseCode.ended, 'ended'],
    [CloseCode.locked, 'locked'],
    [CloseCode.denied, 'denied'],
    [CloseCode.waitExpired, 'waitExpired'],
    [CloseCode.rateLimited, 'rateLimited'],
  ] as const)(
    'reports close code %i as %s, stops the heartbeat, does not reconnect',
    (code, status) => {
      const { connection, socket, created } = connect()
      socket.open()
      socket.sent = []
      socket.serverClose(code)
      expect(connection.getState().status).toBe(status)
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
      expect(socket.sent).toEqual([])
      expect(created).toHaveLength(1)
    },
  )

  it('closes the socket on stop and can start again (React StrictMode)', () => {
    const sockets: FakeSocket[] = []
    const connection = new RoomConnection(
      'abcdefghij',
      { name: 'Gene', token: null, client: CLIENT },
      {
        origin: 'ws://x',
        createSocket: (url) => {
          const socket = new FakeSocket(url)
          sockets.push(socket)
          return socket
        },
      },
    )
    connection.start()
    connection.stop()
    connection.start()
    expect(sockets).toHaveLength(2)
    expect(sockets[0].closedWith).toBe(1000)
    expect(sockets[0].onclose).toBeNull()
  })

  it('says it is leaving before closing when asked to', () => {
    const { connection, socket } = connect()
    socket.open()
    socket.receive(welcome(1))
    socket.sent = []
    connection.stop({ leave: true })
    expect(socket.sent).toEqual(['{"t":"leave"}'])
    expect(socket.closedWith).toBe(1000)
  })

  it('just closes on a plain stop, so the room keeps the member for a reload', () => {
    const { connection, socket } = connect()
    socket.open()
    socket.receive(welcome(1))
    socket.sent = []
    connection.stop()
    expect(socket.sent).toEqual([])
    expect(socket.closedWith).toBe(1000)
  })
})

describe('RoomConnection reconnect (e2-t08)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Open, welcomed as `a` with TOKEN */
  function joined() {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1, { a: member('a') }))
    return t
  }

  it('reconnects with backoff and the same token, keeping the last view meanwhile', () => {
    const t = joined()
    t.socket.serverClose(1006)
    expect(t.connection.getState()).toMatchObject({ status: 'reconnecting', you: 'a' })
    expect(t.connection.getState().view?.members).toEqual({ a: member('a') })
    vi.advanceTimersByTime(999)
    expect(t.created).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(t.created).toHaveLength(2)
    // That one fails too: the next waits 2 s, then 4 s
    t.latest().serverClose(1006)
    vi.advanceTimersByTime(1999)
    expect(t.created).toHaveLength(2)
    vi.advanceTimersByTime(1)
    t.latest().serverClose(1006)
    vi.advanceTimersByTime(4000)
    expect(t.created).toHaveLength(4)
    // This one gets through: joins with the token from the welcome
    t.latest().open()
    expect(t.latest().sent).toEqual([
      JSON.stringify({ t: 'join', name: 'Gene', token: TOKEN, client: CLIENT }),
    ])
    t.latest().receive(welcome(7, { a: member('a'), b: member('b') }))
    expect(t.connection.getState()).toMatchObject({ status: 'open', you: 'a', welcomes: 2 })
    // The backoff starts again from 1 s after a success
    t.latest().serverClose(1006)
    vi.advanceTimersByTime(1000)
    expect(t.created).toHaveLength(5)
  })

  it('tells the room a new name and rejoins with it after a reconnect (e1-t05)', () => {
    const t = joined()
    t.connection.rename('阿明')
    expect(t.socket.sent.at(-1)).toBe('{"t":"rename","name":"阿明"}')
    t.socket.serverClose(1006)
    vi.advanceTimersByTime(1000)
    t.latest().open()
    expect(t.latest().sent).toEqual([
      JSON.stringify({ t: 'join', name: '阿明', token: TOKEN, client: CLIENT }),
    ])
  })

  it('caps the delay at 8 s and gives up after the grace window, until retry', () => {
    const t = joined()
    t.socket.serverClose(1006)
    const delays: number[] = []
    let last = Date.now()
    while (t.connection.getState().status === 'reconnecting') {
      const before = t.created.length
      vi.advanceTimersByTime(100)
      if (t.created.length > before) {
        delays.push(Date.now() - last)
        t.latest().serverClose(1006)
        last = Date.now()
      }
    }
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000])
    expect(Math.max(...delays)).toBe(8000)
    expect(t.connection.getState().status).toBe('lost')
    // Nothing more happens on its own: no hot loop
    const count = t.created.length
    vi.advanceTimersByTime(10 * RECONNECT_GRACE_MS)
    expect(t.created).toHaveLength(count)
    t.connection.retry()
    expect(t.connection.getState().status).toBe('reconnecting')
    expect(t.created).toHaveLength(count + 1)
  })

  it('adds jitter to every delay', () => {
    const low = new Backoff({ random: () => 0 })
    expect(low.next()).toBe(750)
    const high = new Backoff({ random: () => 1 })
    expect(high.next()).toBe(1250)
    expect(high.next()).toBe(2500)
  })

  it('reconnects after a stale close', () => {
    const t = joined()
    t.socket.serverClose(CloseCode.stale)
    expect(t.connection.getState().status).toBe('reconnecting')
  })

  it('takes a socket whose heartbeat goes unanswered for dead', () => {
    const t = joined()
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(t.socket.sent.at(-1)).toBe('ping')
    // No pong by the next heartbeat
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(t.socket.closedWith).toBe(4000)
    expect(t.connection.getState().status).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(t.created).toHaveLength(2)
  })

  it('drops the socket when the browser goes offline and tries again at once when online', () => {
    const t = joined()
    t.connection.offline()
    expect(t.socket.closedWith).toBe(4000)
    expect(t.connection.getState().status).toBe('reconnecting')
    // Offline: the attempts fail, and wait longer each time
    vi.advanceTimersByTime(1000)
    t.latest().serverClose(1006)
    vi.advanceTimersByTime(2000)
    t.latest().serverClose(1006)
    expect(t.created).toHaveLength(3)
    // Online: no waiting for the 4 s timer
    t.connection.online()
    expect(t.created).toHaveLength(4)
    t.latest().open()
    t.latest().receive(welcome(9, { a: member('a') }))
    expect(t.connection.getState().status).toBe('open')
    // The cancelled timer does not open another socket
    vi.advanceTimersByTime(8000)
    expect(t.created).toHaveLength(4)
  })

  it('tries again when the network comes back after giving up', () => {
    const t = joined()
    t.socket.serverClose(1006)
    let seen = t.created.length
    while (t.connection.getState().status === 'reconnecting') {
      vi.advanceTimersByTime(100)
      if (t.created.length > seen) {
        seen = t.created.length
        t.latest().serverClose(1006)
      }
    }
    expect(t.connection.getState().status).toBe('lost')
    const count = t.created.length
    t.connection.online()
    expect(t.created).toHaveLength(count + 1)
  })

  it('checks the socket when the page comes back to the foreground', () => {
    const t = joined()
    t.socket.sent = []
    t.connection.visible()
    expect(t.socket.sent).toEqual(['ping'])
    t.socket.receive('pong')
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS)
    expect(t.connection.getState().status).toBe('open')
    // A dead socket: no answer in time
    t.connection.visible()
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS)
    expect(t.socket.closedWith).toBe(4000)
    expect(t.connection.getState().status).toBe('reconnecting')
    // Foreground again while waiting: try now
    t.connection.visible()
    expect(t.created).toHaveLength(2)
  })

  it('ignores a dropped socket closing late, and stops reconnecting on stop', () => {
    const t = joined()
    t.connection.offline()
    // The dropped socket's close event arrives after it was let go: nothing happens
    t.socket.serverClose(1006)
    t.connection.stop()
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
    expect(t.created).toHaveLength(1)
  })

  it('ignores patches on a new socket before its welcome', () => {
    const t = joined()
    t.socket.serverClose(1006)
    vi.advanceTimersByTime(1000)
    t.latest().open()
    t.latest().sent = []
    t.latest().receive({ t: 'patch', rev: 5, ops: [{ op: 'del', path: ['members', 'a'] }] })
    expect(t.latest().sent).toEqual([])
    expect(t.connection.getState().view?.members).toEqual({ a: member('a') })
  })
})

describe('RoomConnection polls (L5, e5-t07)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps our answer as the room says it; a new welcome starts over until the room repeats it', () => {
    const t = connect()
    t.socket.open()
    // Before this socket's welcome it is not ours to believe
    t.socket.receive({ t: 'pollVoted', poll: 7, choices: [1] })
    expect(t.connection.getState().pollVote).toBeNull()
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'pollVoted', poll: 7, choices: [1] })
    expect(t.connection.getState().pollVote).toEqual({ poll: 7, choices: [1] })
    t.socket.receive(welcome(2))
    expect(t.connection.getState().pollVote).toBeNull()
  })
})

describe('RoomConnection chat (D3, e5-t01)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const message = (id: number, from = 'b') => ({ id, from, name: 'B', text: `m${id}`, at: id })

  it('takes the history after the welcome, then appends new messages once each', () => {
    const t = connect()
    t.socket.open()
    // Before the welcome nothing counts
    t.socket.receive({ t: 'chat', messages: [message(9)], reset: true })
    expect(t.connection.getState().chatLoaded).toBe(false)
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'chat', messages: [message(1), message(2)], reset: true })
    t.socket.receive({ t: 'chat', messages: [message(3)] })
    // A duplicate (already in a later history) is ignored
    t.socket.receive({ t: 'chat', messages: [message(3)] })
    const state = t.connection.getState()
    expect(state.chatLoaded).toBe(true)
    expect(state.chat.map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('replaces the list with the history a rejoin brings, keeping it across the drop', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'chat', messages: [message(1)], reset: true })
    t.socket.serverClose(1006)
    expect(t.connection.getState().chat).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    t.latest().open()
    t.latest().receive(welcome(2))
    t.latest().receive({ t: 'chat', messages: [message(1), message(2)], reset: true })
    expect(t.connection.getState().chat.map((m) => m.id)).toEqual([1, 2])
  })

  it('takes a breakout room’s history mid-meeting (L3), every `regroup` frame not new', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'chat', messages: [message(1), message(2)], reset: true })
    expect(t.connection.getState().chatHistoryUntil).toBe(2)
    t.socket.receive({ t: 'chat', messages: [message(3)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(2)
    // Moved to a room: its history replaces the main room's, no welcome in between
    const first = Array.from({ length: CHAT_CHUNK }, (_, i) => message(10 + i))
    t.socket.receive({ t: 'chat', messages: first, reset: true, regroup: true })
    expect(t.connection.getState()).toMatchObject({ chatLoaded: true, chatHistoryUntil: 59 })
    // The rest of it, in the next frame
    t.socket.receive({ t: 'chat', messages: [message(70), message(71)], regroup: true })
    expect(t.connection.getState().chatHistoryUntil).toBe(71)
    expect(t.connection.getState().chat).toHaveLength(CHAT_CHUNK + 2)
    // Then a new message: new
    t.socket.receive({ t: 'chat', messages: [message(72)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(71)
    expect(t.connection.getState().chat.at(-1)?.id).toBe(72)
    // Back in the main room, where nothing was said: an empty history
    t.socket.receive({ t: 'chat', messages: [], reset: true, regroup: true })
    expect(t.connection.getState()).toMatchObject({ chat: [], chatHistoryUntil: 71 })
    t.socket.receive({ t: 'chat', messages: [message(80)] })
    expect(t.connection.getState().chat.map((m) => m.id)).toEqual([80])
  })

  it('a new message right after a full `regroup` frame is new, however soon (L3)', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'chat', messages: [message(1)], reset: true })
    const history = Array.from({ length: CHAT_CHUNK }, (_, i) => message(10 + i))
    t.socket.receive({ t: 'chat', messages: history, reset: true, regroup: true })
    t.socket.receive({ t: 'chat', messages: [message(99)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(59)
    expect(t.connection.getState().chat.at(-1)?.id).toBe(99)
  })

  it('takes the rest of a long first history as not new, by its timing', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    const history = Array.from({ length: CHAT_CHUNK }, (_, i) => message(i + 1))
    t.socket.receive({ t: 'chat', messages: history, reset: true })
    t.socket.receive({ t: 'chat', messages: [message(51), message(52)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(52)
    t.socket.receive({ t: 'chat', messages: [message(53)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(52)
  })

  it('does not mark a reconnect’s history: what was said meanwhile is new', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    t.socket.receive({ t: 'chat', messages: [message(1)], reset: true })
    t.socket.serverClose(1006)
    vi.advanceTimersByTime(1000)
    t.latest().open()
    t.latest().receive(welcome(2))
    t.latest().receive({ t: 'chat', messages: [message(1), message(2)], reset: true })
    expect(t.connection.getState().chatHistoryUntil).toBe(1)
  })

  it('a full first history long ago does not swallow the next new message', () => {
    const t = connect()
    t.socket.open()
    t.socket.receive(welcome(1))
    const history = Array.from({ length: CHAT_CHUNK }, (_, i) => message(i + 1))
    t.socket.receive({ t: 'chat', messages: history, reset: true })
    vi.advanceTimersByTime(60_000)
    t.socket.receive({ t: 'chat', messages: [message(99)] })
    expect(t.connection.getState().chatHistoryUntil).toBe(CHAT_CHUNK)
  })

  it('sends normalized text, and says why it did not send', () => {
    const t = connect()
    t.socket.open()
    expect(t.connection.sendChat('hi')).toBe('offline')
    t.socket.receive(welcome(1))
    expect(t.connection.sendChat('   ')).toBe('empty')
    expect(t.connection.sendChat('字'.repeat(2001))).toBe('tooLong')
    expect(t.connection.sendChat('  hi\r\n  ')).toBe('sent')
    expect(t.socket.sent.at(-1)).toBe(JSON.stringify({ t: 'chat', text: 'hi' }))
    for (let i = 0; i < 9; i++) t.connection.sendChat(`m${i}`, 1000)
    expect(t.connection.sendChat('one too many', 1000)).toBe('rateLimited')
  })
})
