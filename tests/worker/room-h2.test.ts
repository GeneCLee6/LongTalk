// H2 (e2-t13): every member's signal level is RoomDO state for everyone's nameplates: set by the
// member's own `signal`, dropped beyond SIGNAL_RATE, kept while the member reconnects
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  SIGNAL_RATE,
  parseClientMessage,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null
  rev = -1

  receive(message: ServerMessage) {
    this.received.push(message)
    if (message.t === 'welcome' || message.t === 'snapshot') {
      this.view = message.state
      this.rev = message.rev
    } else if (message.t === 'patch') {
      expect(message.rev).toBe(this.rev + 1)
      this.rev = message.rev
      this.view = applyPatch(viewAsJson(this.view!), message.ops) as RoomView
    }
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t)
  }
}

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const saved = { sessions: [] as SessionRecord[], log: [] as string[] }
  const store = (what: unknown) => saved.log.push(JSON.stringify(what))
  const host = new RoomHost({
    sockets: {
      send: (conn, message) => clients.get(conn)?.receive(message),
      close: () => {},
    },
    storage: {
      saveRoom: store,
      saveRev: store,
      saveSessions: (sessions) => {
        saved.sessions = structuredClone(sessions)
        store(sessions)
      },
      saveUsage: store,
      saveSchedule: store,
      saveChat: store,
      dropChat: store,
      saveBans: store,
      savePassword: store,
      saveGuesses: store,
      saveEnded: store,
      clear: () => store('clear'),
    },
    now: () => clock,
    newMemberId: () => `m${++nextId}`,
    newToken: () => `token-m${nextId}`.padEnd(43, '_'),
  })
  host.create(ROOM)
  function join(name: string) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    void host.message(conn, JSON.stringify({ t: 'join', name, token: null, client: null }))
    const welcome = client.of('welcome')[0]
    const lobby = client.of('lobby')[0]
    return { conn, client, id: welcome?.you ?? lobby?.you ?? '' }
  }
  const send = (who: { conn: string }, message: object) =>
    void host.message(who.conn, JSON.stringify(message))
  return { host, saved, join, send, tick: (ms: number) => (clock += ms), now: () => clock }
}

describe('signal levels (e2-t13)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('parses `signal` with a known level only', () => {
    expect(parseClientMessage('{"t":"signal","level":"fair"}')).toEqual({
      t: 'signal',
      level: 'fair',
    })
    expect(parseClientMessage('{"t":"signal","level":"great"}')).toBeNull()
    expect(parseClientMessage('{"t":"signal"}')).toBeNull()
  })

  it('starts unknown and shows everyone the level a member reports', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    expect(alice.client.view!.members[bob.id].signal).toBeNull()
    t.send(bob, { t: 'signal', level: 'poor' })
    expect(alice.client.view!.members[bob.id].signal).toBe('poor')
    expect(bob.client.view!.members[bob.id].signal).toBe('poor')
  })

  it('sends no patch for the level it already has', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    t.send(bob, { t: 'signal', level: 'good' })
    const patches = alice.client.of('patch').length
    t.send(bob, { t: 'signal', level: 'good' })
    expect(alice.client.of('patch')).toHaveLength(patches)
  })

  it('drops reports beyond SIGNAL_RATE without an answer, then lets them through again', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const levels = ['good', 'fair', 'poor', 'good', 'fair'] as const
    for (const level of levels) t.send(bob, { t: 'signal', level })
    expect(alice.client.view!.members[bob.id].signal).toBe(levels[SIGNAL_RATE.count - 1])
    expect(bob.client.of('error')).toEqual([])
    t.tick(SIGNAL_RATE.windowMs)
    t.send(bob, { t: 'signal', level: 'good' })
    expect(alice.client.view!.members[bob.id].signal).toBe('good')
  })

  it('ignores a report from the waiting room', () => {
    const alice = t.join('Alice')
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const wei = t.join('Wei')
    const patches = alice.client.of('patch').length
    t.send(wei, { t: 'signal', level: 'poor' })
    expect(alice.client.of('patch')).toHaveLength(patches)
  })

  it('keeps the level while its member reconnects', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    t.send(bob, { t: 'signal', level: 'fair' })
    t.host.closed(bob.conn)
    expect(alice.client.view!.members[bob.id]).toMatchObject({ reconnecting: true, signal: 'fair' })
  })

  it('reads members stored before v14 as unknown', () => {
    t.join('Alice')
    const sessions = t.saved.sessions.map((record) => {
      const member: Record<string, unknown> = { ...record.member }
      delete member.signal
      return { ...record, member } as unknown as SessionRecord
    })
    const fresh = setup()
    fresh.host.restore({ ...ROOM }, 3, sessions, [])
    expect(Object.values(fresh.host.view().members).map((m) => m.signal)).toEqual([null])
  })
})
