// G3 (e5-t03, e5-t04): reactions go to everyone in the room and nowhere else, at most
// REACTION_RATE per member; raised hands are RoomDO state, queued by when they went up, lowered
// by their member or by a host or co-host ranked above them (worker/roles.ts)
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { REACTIONS, REACTION_RATE, handQueue, isReaction } from '../../shared/reactions.ts'
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

describe('reactions (e5-t03)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('knows the six reactions and nothing else', () => {
    expect(REACTIONS).toEqual(['👍', '❤️', '😂', '😮', '👏', '🎉'])
    expect(isReaction('👍')).toBe(true)
    expect(isReaction('❤')).toBe(false)
    expect(isReaction('💩')).toBe(false)
    expect(parseClientMessage('{"t":"react","emoji":"🎉"}')).toEqual({ t: 'react', emoji: '🎉' })
    expect(parseClientMessage('{"t":"react","emoji":"<b>"}')).toBeNull()
    expect(parseClientMessage('{"t":"react"}')).toBeNull()
    expect(parseServerMessage('{"t":"reaction","from":"m1","emoji":"👏"}')).toEqual({
      t: 'reaction',
      from: 'm1',
      emoji: '👏',
    })
    expect(parseServerMessage('{"t":"reaction","from":"m1","emoji":"x"}')).toBeNull()
  })

  it('goes to everyone in the room, the sender too, and is kept nowhere', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const logBefore = t.saved.log.length
    t.send(bob, { t: 'react', emoji: '👍' })
    for (const member of [alice, bob]) {
      expect(member.client.of('reaction')).toEqual([{ t: 'reaction', from: bob.id, emoji: '👍' }])
    }
    // Nothing stored, nothing in the view
    expect(t.saved.log.length).toBe(logBefore)
    expect(JSON.stringify(alice.client.view)).not.toContain('👍')
    // Someone joining later never sees it
    const carol = t.join('Carol')
    expect(carol.client.of('reaction')).toEqual([])
  })

  it('drops reactions over REACTION_RATE without an answer, then lets them through again', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    for (let i = 0; i < REACTION_RATE.count + 3; i++) t.send(bob, { t: 'react', emoji: '👏' })
    expect(alice.client.of('reaction')).toHaveLength(REACTION_RATE.count)
    expect(bob.client.of('error')).toEqual([])
    // Each member has their own allowance
    t.send(alice, { t: 'react', emoji: '🎉' })
    expect(bob.client.of('reaction').at(-1)).toEqual({ t: 'reaction', from: alice.id, emoji: '🎉' })
    t.tick(REACTION_RATE.windowMs)
    t.send(bob, { t: 'react', emoji: '😂' })
    expect(alice.client.of('reaction')).toHaveLength(REACTION_RATE.count + 2)
  })

  it('is not for someone in the waiting room, who sees no one else’s either', () => {
    const alice = t.join('Alice')
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const wei = t.join('Wei')
    expect(wei.client.of('lobby')).not.toHaveLength(0)
    t.send(wei, { t: 'react', emoji: '👍' })
    expect(alice.client.of('reaction')).toEqual([])
    t.send(alice, { t: 'react', emoji: '❤️' })
    expect(wei.client.of('reaction')).toEqual([])
  })
})

describe('raised hands (e5-t04)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('parses `hand` and `lowerHand`', () => {
    expect(parseClientMessage('{"t":"hand","up":true}')).toEqual({ t: 'hand', up: true })
    expect(parseClientMessage('{"t":"hand","up":"yes"}')).toBeNull()
    expect(parseClientMessage('{"t":"host","action":"lowerHand","memberId":"m2"}')).toEqual({
      t: 'host',
      action: 'lowerHand',
      memberId: 'm2',
    })
    expect(parseClientMessage('{"t":"host","action":"lowerHand"}')).toBeNull()
  })

  it('keeps the hand in the room, queued by when it went up', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    expect(alice.client.view!.members[bob.id].hand).toBeNull()
    t.send(carol, { t: 'hand', up: true })
    const carolAt = t.now()
    t.tick(1000)
    t.send(bob, { t: 'hand', up: true })
    t.tick(1000)
    // Raising again keeps the place
    t.send(carol, { t: 'hand', up: true })
    for (const member of [alice, bob, carol]) {
      const view = member.client.view!
      expect(view.members[carol.id].hand).toBe(carolAt)
      expect(handQueue(Object.values(view.members)).map((m) => m.name)).toEqual(['Carol', 'Bob'])
    }
    // Stored with the sessions: it survives an eviction
    const stored = t.saved.sessions.find((s) => s.member.id === bob.id)!
    expect(stored.member.hand).toBe(carolAt + 1000)
    // Lowering and raising again goes to the back of the queue
    t.send(carol, { t: 'hand', up: false })
    expect(alice.client.view!.members[carol.id].hand).toBeNull()
    t.send(carol, { t: 'hand', up: true })
    expect(handQueue(Object.values(alice.client.view!.members)).map((m) => m.name)).toEqual([
      'Bob',
      'Carol',
    ])
  })

  it('orders hands raised at the same moment by id, the same on every end', () => {
    const queue = handQueue([
      { id: 'b', hand: 5 },
      { id: 'a', hand: 5 },
      { id: 'c', hand: null },
      { id: 'd', hand: 2 },
    ])
    expect(queue.map((m) => m.id)).toEqual(['d', 'a', 'b'])
  })

  it('lets a host or co-host lower someone’s hand, who is told', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    t.send(bob, { t: 'hand', up: true })
    t.send(alice, { t: 'host', action: 'lowerHand', memberId: bob.id })
    expect(alice.client.view!.members[bob.id].hand).toBeNull()
    expect(bob.client.of('notice')).toEqual([{ t: 'notice', notice: 'handLowered', by: alice.id }])
    // A hand already down: nothing happens, nobody is told again
    t.send(alice, { t: 'host', action: 'lowerHand', memberId: bob.id })
    expect(bob.client.of('notice')).toHaveLength(1)
    expect(alice.client.of('error')).toEqual([])
  })

  it('refuses a participant lowering anyone else’s hand, and a co-host the host’s', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    t.send(alice, { t: 'hand', up: true })
    t.send(carol, { t: 'hand', up: true })
    t.send(bob, { t: 'host', action: 'lowerHand', memberId: carol.id })
    expect(bob.client.of('error')).toEqual([{ t: 'error', code: 'forbidden' }])
    expect(bob.client.view!.members[carol.id].hand).not.toBeNull()
    // Bob becomes a co-host: Carol's, yes; the host's, no
    t.send(alice, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    t.send(bob, { t: 'host', action: 'lowerHand', memberId: carol.id })
    expect(bob.client.view!.members[carol.id].hand).toBeNull()
    t.send(bob, { t: 'host', action: 'lowerHand', memberId: alice.id })
    expect(bob.client.of('error')).toHaveLength(2)
    expect(bob.client.view!.members[alice.id].hand).not.toBeNull()
    // Nobody lowers their own through `host`: they send `hand`
    t.send(alice, { t: 'host', action: 'lowerHand', memberId: alice.id })
    expect(alice.client.of('error')).toEqual([{ t: 'error', code: 'forbidden' }])
    t.send(alice, { t: 'hand', up: false })
    expect(alice.client.view!.members[alice.id].hand).toBeNull()
  })

  it('refuses a hand from the waiting room', () => {
    const alice = t.join('Alice')
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const wei = t.join('Wei')
    t.send(wei, { t: 'hand', up: true })
    expect(wei.client.of('error')).toEqual([{ t: 'error', code: 'forbidden' }])
    t.send(alice, { t: 'host', action: 'admit', memberId: wei.id })
    expect(alice.client.view!.members[wei.id].hand).toBeNull()
  })

  it('keeps the hand while its member reconnects, and it goes with them', () => {
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    t.send(bob, { t: 'hand', up: true })
    t.host.closed(bob.conn)
    expect(alice.client.view!.members[bob.id]).toMatchObject({ reconnecting: true })
    expect(alice.client.view!.members[bob.id].hand).not.toBeNull()
    t.send(alice, { t: 'host', action: 'remove', memberId: bob.id })
    expect(alice.client.view!.members[bob.id]).toBeUndefined()
  })

  it('reads members stored before v13 as hands down', () => {
    t.join('Alice')
    const sessions = t.saved.sessions.map((record) => {
      const member: Record<string, unknown> = { ...record.member }
      delete member.hand
      return { ...record, member } as unknown as SessionRecord
    })
    const fresh = setup()
    fresh.host.restore({ ...ROOM }, 3, sessions, [])
    const view = fresh.host.view()
    expect(Object.values(view.members).map((m) => m.hand)).toEqual([null])
  })
})
