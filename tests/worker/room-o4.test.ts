// O4 (e5-t09): private messages in the RoomDO. The room decides who may write to whom (the room's
// switch, the roles, the breakout rooms), and only the sender and the recipient ever get the message,
// live and in every history after a reconnect, a move or an eviction.
import { describe, expect, it } from 'vitest'
import { CHAT_RATE, type ChatMessage } from '../../shared/chat.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import type { BreakoutState } from '../../worker/room-breakout.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'
import type { Schedule } from '../../worker/scheduler.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null

  receive(message: ServerMessage) {
    this.received.push(message)
    if (message.t === 'welcome' || message.t === 'snapshot') this.view = message.state
    else if (message.t === 'patch') {
      this.view = applyPatch(viewAsJson(this.view!), message.ops) as RoomView
    }
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t)
  }

  get errors(): string[] {
    return this.of('error').map((message) => message.code)
  }

  /** The chat as the browser holds it: a `reset` frame replaces what came before */
  get chat(): ChatMessage[] {
    let held: ChatMessage[] = []
    for (const frame of this.of('chat')) {
      held = frame.reset ? [...frame.messages] : [...held, ...frame.messages]
    }
    return held
  }

  get chatTexts(): string[] {
    return this.chat.map((message) => message.text)
  }

  forget() {
    this.received = []
  }
}

type Who = { conn: string; client: FakeClient; id: string; token: string }

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    chat: [] as ChatMessage[],
    schedule: null as Schedule | null,
    breakout: null as BreakoutState | null,
    breakoutSaves: 0,
  }
  const makeHost = () =>
    new RoomHost({
      sockets: {
        send: (conn, message) => clients.get(conn)?.receive(message),
        close: () => {},
      },
      storage: {
        saveRoom: (info) => void (disk.info = structuredClone(info)),
        saveRev: (rev) => void (disk.rev = rev),
        saveSessions: (sessions) => void (disk.sessions = structuredClone(sessions)),
        saveUsage: () => {},
        saveSchedule: (schedule) => void (disk.schedule = structuredClone(schedule)),
        saveChat: (message) => void disk.chat.push(structuredClone(message)),
        dropChat: () => {},
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        saveBreakout: (state) => {
          disk.breakout = structuredClone(state)
          disk.breakoutSaves++
        },
        clear: () => {
          disk.info = null
          disk.chat = []
          disk.breakout = null
          disk.schedule = null
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = makeHost()
  host.create(ROOM)
  function join(name: string, token: string | null = null): Who {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    void host.message(conn, JSON.stringify({ t: 'join', name, token, client: null }))
    const welcome = client.of('welcome')[0]
    return { conn, client, id: welcome?.you ?? '', token: welcome?.token ?? '' }
  }
  const send = (who: { conn: string }, message: object) =>
    void host.message(who.conn, JSON.stringify(message))
  return {
    get host() {
      return host
    },
    disk,
    join,
    send,
    /** The object is evicted and comes back from what it stored, every socket still open */
    evict() {
      host = makeHost()
      const sockets = [...clients.keys()].map((conn) => ({ conn, openedAt: clock }))
      host.restore(
        disk.info,
        disk.rev,
        disk.sessions,
        sockets,
        null,
        disk.schedule,
        disk.chat,
        [],
        {
          breakout: disk.breakout,
        },
      )
    },
    drop: (who: { conn: string }) => {
      host.closed(who.conn)
      clients.delete(who.conn)
    },
    tick: (ms: number) => void (clock += ms),
    /** Moves the clock to the next alarm and fires it; every socket is heard from meanwhile */
    alarm() {
      const at = host.nextAlarm()
      expect(at).not.toBeNull()
      clock = Math.max(clock, at!)
      for (const conn of clients.keys()) host.heartbeat(conn, clock)
      host.alarm()
    },
    /** Fires alarms until the clock reaches `at` */
    alarmsUntil(at: number) {
      while (clock < at) this.alarm()
    },
    get clock() {
      return clock
    },
  }
}

/** Alice (host), Bob (co-host), Carol and Dan (participants) */
function room() {
  const t = setup()
  const alice = t.join('Alice')
  const bob = t.join('Bob')
  const carol = t.join('Carol')
  const dan = t.join('Dan')
  t.send(alice, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
  return { t, alice, bob, carol, dan }
}

const privateTexts = (who: Who) =>
  who.client.chat.filter((message) => message.to !== undefined).map((message) => message.text)

describe('sending a private message', () => {
  it('goes to the sender and the recipient alone, with who it is for', () => {
    const { t, alice, bob, carol, dan } = room()
    t.send(carol, { t: 'chat', text: '悄悄話', to: dan.id })
    const sent = carol.client.chat.at(-1)!
    expect(sent).toMatchObject({ from: carol.id, name: 'Carol', to: dan.id, toName: 'Dan' })
    expect(dan.client.chat.at(-1)).toEqual(sent)
    // Nobody else learns it exists, not the host or a co-host either
    expect(privateTexts(alice)).toEqual([])
    expect(privateTexts(bob)).toEqual([])
    expect(carol.client.errors).toEqual([])
    // It is kept like any message (the history, storage)
    expect(t.host.chatHistory.at(-1)).toEqual(sent)
    expect(t.disk.chat.at(-1)).toEqual(sent)
  })

  it('does not stop the public chat: everyone still gets messages to everyone', () => {
    const { t, alice, carol, dan } = room()
    t.send(carol, { t: 'chat', text: '私', to: dan.id })
    t.send(carol, { t: 'chat', text: '大家好' })
    expect(alice.client.chatTexts).toEqual(['大家好'])
    expect(dan.client.chatTexts).toEqual(['私', '大家好'])
  })

  it('is refused to oneself, to someone unknown, and to or from who waits', () => {
    const { t, alice, carol } = room()
    t.send(carol, { t: 'chat', text: 'a', to: carol.id })
    t.send(carol, { t: 'chat', text: 'b', to: 'ghost' })
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const frank = t.join('Frank')
    const frankId = frank.client.of('lobby')[0].you
    t.send(alice, { t: 'chat', text: 'd', to: frankId })
    expect(carol.client.errors).toEqual(['forbidden', 'forbidden'])
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(t.host.chatHistory).toEqual([])
    t.send(frank, { t: 'chat', text: 'e', to: alice.id })
    expect(t.host.chatHistory).toEqual([])
  })

  it('counts against the same rate limit as the public chat', () => {
    const { t, carol, dan } = room()
    for (let i = 0; i < CHAT_RATE.count; i++) {
      t.send(carol, { t: 'chat', text: `m${i}`, ...(i % 2 ? { to: dan.id } : {}) })
    }
    t.send(carol, { t: 'chat', text: 'one too many', to: dan.id })
    expect(carol.client.errors).toEqual(['rate_limited'])
  })

  it('keeps the recipient name as it was when sent', () => {
    const { t, carol, dan } = room()
    t.send(carol, { t: 'chat', text: 'hi', to: dan.id })
    t.send(dan, { t: 'rename', name: 'Daniel' })
    expect(carol.client.chat.at(-1)!.toName).toBe('Dan')
  })
})

describe('the room switch (host `privateChat`)', () => {
  it('a host or co-host turns it off: participants may then write only to them', () => {
    const { t, alice, bob, carol, dan } = room()
    t.send(bob, { t: 'host', action: 'privateChat', on: false })
    expect(bob.client.errors).toEqual([])
    expect(alice.client.view!.room.privateChat).toBe(false)
    t.send(carol, { t: 'chat', text: 'to dan', to: dan.id })
    expect(carol.client.errors).toEqual(['forbidden'])
    t.send(carol, { t: 'chat', text: 'to alice', to: alice.id })
    t.send(carol, { t: 'chat', text: 'to bob', to: bob.id })
    t.send(alice, { t: 'chat', text: 'to carol', to: carol.id })
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(alice.client.errors).toEqual([])
    expect(privateTexts(carol)).toEqual(['to alice', 'to bob', 'to carol'])
    t.send(alice, { t: 'host', action: 'privateChat', on: true })
    expect(carol.client.view!.room.privateChat).toBe(true)
    t.send(carol, { t: 'chat', text: 'to dan again', to: dan.id })
    expect(privateTexts(dan)).toEqual(['to dan again'])
  })

  it('a participant may not switch it', () => {
    const { t, alice, carol } = room()
    t.send(carol, { t: 'host', action: 'privateChat', on: false })
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(alice.client.view!.room.privateChat ?? true).toBe(true)
  })

  it('messages already sent stay where they were', () => {
    const { t, alice, carol, dan } = room()
    t.send(carol, { t: 'chat', text: 'before', to: dan.id })
    t.send(alice, { t: 'host', action: 'privateChat', on: false })
    expect(privateTexts(dan)).toEqual(['before'])
    t.drop(dan)
    const again = t.join('Dan', dan.token)
    expect(privateTexts(again)).toEqual(['before'])
  })
})

describe('private messages in the history', () => {
  it('a reconnect gets its own private messages again; someone new gets none', () => {
    const { t, carol, dan } = room()
    t.send(carol, { t: 'chat', text: 'secret', to: dan.id })
    t.send(dan, { t: 'chat', text: 'reply', to: carol.id })
    t.drop(dan)
    const back = t.join('Dan', dan.token)
    expect(back.id).toBe(dan.id)
    expect(privateTexts(back)).toEqual(['secret', 'reply'])
    const erin = t.join('Erin')
    expect(erin.client.chat).toEqual([])
  })

  it('survives an eviction, still for the two of them alone', () => {
    const { t, alice, carol, dan } = room()
    t.send(carol, { t: 'chat', text: 'secret', to: dan.id })
    t.evict()
    t.drop(carol)
    t.drop(alice)
    const again = t.join('Carol', carol.token)
    expect(privateTexts(again)).toEqual(['secret'])
    const host = t.join('Alice', alice.token)
    expect(privateTexts(host)).toEqual([])
    expect(dan.id).not.toBe('')
  })
})

describe('private messages and breakout rooms (L3)', () => {
  function opened() {
    const r = room()
    // Carol and Dan in 第一組, Alice and Bob stay in the main room
    r.t.send(r.alice, {
      t: 'breakoutOpen',
      groups: ['第一組'],
      assign: { [r.carol.id]: 0, [r.dan.id]: 0 },
      minutes: null,
    })
    return r
  }

  it('may be sent within one room, not across rooms (server-enforced isolation)', () => {
    const { t, alice, bob, carol, dan } = opened()
    t.send(carol, { t: 'chat', text: 'in the room', to: dan.id })
    t.send(carol, { t: 'chat', text: 'to the host', to: alice.id })
    t.send(alice, { t: 'chat', text: 'to carol', to: carol.id })
    t.send(alice, { t: 'chat', text: 'to bob', to: bob.id })
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(privateTexts(dan)).toEqual(['in the room'])
    expect(privateTexts(bob)).toEqual(['to bob'])
  })

  it('stays the conversation of the two after a move', () => {
    const { t, alice, carol, dan } = opened()
    t.send(carol, { t: 'chat', text: 'in the room', to: dan.id })
    t.send(alice, { t: 'breakoutMove', memberId: dan.id, group: null })
    expect(privateTexts(dan)).toEqual(['in the room'])
    expect(privateTexts(carol)).toEqual(['in the room'])
    expect(privateTexts(alice)).toEqual([])
  })
})
