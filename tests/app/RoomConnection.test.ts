import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { RoomConnection, type SocketLike } from '../../src/room/RoomConnection.ts'

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

const room = { id: 'abcdefghij', createdAt: 1 }
const member = (id: string) => ({
  id,
  name: id.toUpperCase(),
  joinedAt: 1,
  reconnecting: false,
  tracks: [],
})
const TOKEN = 'T'.repeat(43)
const welcome = (rev: number, members: Record<string, ReturnType<typeof member>> = {}) =>
  ({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    you: 'a',
    token: TOKEN,
    rev,
    state: { room, members, usage: 'normal' as const },
  }) as const

function connect(token: string | null = null) {
  let socket: FakeSocket | null = null
  const onToken = vi.fn()
  const connection = new RoomConnection(
    'abcdefghij',
    { name: 'Gene', token },
    {
      origin: 'wss://longtalk.test',
      createSocket: (url) => (socket = new FakeSocket(url)),
      onToken,
    },
  )
  connection.start()
  return { connection, socket: socket!, onToken }
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
    expect(socket.sent).toEqual([JSON.stringify({ t: 'join', name: 'Gene', token: TOKEN })])
    const fresh = connect()
    fresh.socket.open()
    expect(fresh.socket.sent).toEqual(['{"t":"join","name":"Gene","token":null}'])
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
      state: { room, members: { c: member('c') }, usage: 'normal' },
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
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
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
    [1006, 'closed'],
  ] as const)('reports close code %i as %s and stops the heartbeat', (code, status) => {
    const { connection, socket } = connect()
    socket.open()
    socket.sent = []
    socket.serverClose(code)
    expect(connection.getState().status).toBe(status)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
    expect(socket.sent).toEqual([])
  })

  it('closes the socket on stop and can start again (React StrictMode)', () => {
    const sockets: FakeSocket[] = []
    const connection = new RoomConnection(
      'abcdefghij',
      { name: 'Gene', token: null },
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
