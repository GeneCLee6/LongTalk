// L3 (e10-t04; AC-10.4): breakout rooms in the RoomDO. The room decides who is where; it refuses an
// SFU pull across rooms (the audio and video isolation AC-10.4 asks a test for), scopes the chat to
// each room, runs the clock and the recall on its alarm, and all of it survives a reconnect and an
// eviction. A host or co-host runs them; a participant may not.
import { describe, expect, it } from 'vitest'
import { WHITEBOARD_LAYER } from '../../shared/annotation.ts'
import { BREAKOUT_RECALL_MS, type BreakoutView } from '../../shared/breakout.ts'
import { CHAT_CHUNK, type ChatMessage } from '../../shared/chat.ts'
import { INTERACT_RATE } from '../../shared/interact.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  CONSENT_TIMEOUT_MS,
  MAX_SHARES,
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

/** Publishes a microphone and a camera for the member on its own SFU session */
function publish(t: ReturnType<typeof setup>, who: Who) {
  expect(t.host.bindSfu(who.token, `sess-${who.id}`)).toBe(true)
  t.send(who, {
    t: 'tracks',
    sessionId: `sess-${who.id}`,
    tracks: [
      { trackName: `mic-${who.id}`, kind: 'mic', muted: false },
      { trackName: `cam-${who.id}`, kind: 'cam', muted: false },
    ],
  })
}

/** Whether `who` may pull `owner`'s camera through the SFU proxy */
const pull = (t: ReturnType<typeof setup>, who: Who, owner: Who) =>
  t.host.sfuAccess(who.token, `sess-${who.id}`, [
    { sessionId: `sess-${owner.id}`, trackName: `cam-${owner.id}` },
  ])

/** Alice (host), Bob (co-host), Carol, Dan and Erin (participants), each publishing */
function room() {
  const t = setup()
  const alice = t.join('Alice')
  const bob = t.join('Bob')
  const carol = t.join('Carol')
  const dan = t.join('Dan')
  const erin = t.join('Erin')
  t.send(alice, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
  for (const who of [alice, bob, carol, dan, erin]) publish(t, who)
  return { t, alice, bob, carol, dan, erin }
}

/** Carol and Dan in 第一組, Erin in 第二組; Alice and Bob stay in the main room */
function opened(minutes: number | null = 10) {
  const r = room()
  r.t.send(r.alice, {
    t: 'breakoutOpen',
    groups: ['第一組', '第二組'],
    assign: { [r.carol.id]: 0, [r.dan.id]: 0, [r.erin.id]: 1 },
    minutes,
  })
  return r
}

const groupIn = (viewer: Who, member: Who) => viewer.client.view!.members[member.id]?.group ?? null

describe('opening breakout rooms', () => {
  it('a host opens them: everyone sees the rooms and who is where; the rest stay in the main room', () => {
    const { t, alice, bob, carol, dan, erin } = opened()
    const expected: BreakoutView = {
      groups: [
        { id: 'g1', name: '第一組' },
        { id: 'g2', name: '第二組' },
      ],
      openedAt: t.clock,
      endsAt: t.clock + 10 * 60_000,
      closesAt: null,
      broadcast: null,
    }
    for (const viewer of [alice, bob, carol, dan, erin]) {
      expect(viewer.client.view!.breakout).toEqual(expected)
      expect(groupIn(viewer, carol)).toBe('g1')
      expect(groupIn(viewer, dan)).toBe('g1')
      expect(groupIn(viewer, erin)).toBe('g2')
      expect(groupIn(viewer, alice)).toBeNull()
    }
    expect(t.host.view()).toEqual(alice.client.view)
    expect(bob.client.errors).toEqual([])
  })

  it('a co-host may; a participant is refused, and nothing opens', () => {
    const { t, bob, carol, dan } = room()
    const message = { t: 'breakoutOpen', groups: ['A'], assign: { [dan.id]: 0 }, minutes: null }
    t.send(carol, message)
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(carol.client.view!.breakout).toBeNull()
    t.send(bob, message)
    expect(bob.client.errors).toEqual([])
    expect(groupIn(bob, dan)).toBe('g1')
  })

  it('a participant may not move, broadcast to or recall the rooms either', () => {
    const { t, carol, dan } = opened()
    t.send(carol, { t: 'breakoutMove', memberId: carol.id, group: 'g2' })
    t.send(carol, { t: 'breakoutBroadcast', text: '嗨' })
    t.send(carol, { t: 'breakoutClose', now: false })
    expect(carol.client.errors).toEqual(['forbidden', 'forbidden', 'forbidden'])
    expect(groupIn(dan, carol)).toBe('g1')
    expect(dan.client.view!.breakout!.broadcast).toBeNull()
    expect(dan.client.view!.breakout!.closesAt).toBeNull()
  })

  it('a second set while they are open is refused with breakout_active', () => {
    const { t, alice, bob } = opened()
    t.send(bob, { t: 'breakoutOpen', groups: ['X'], assign: {}, minutes: null })
    expect(bob.client.errors).toEqual(['breakout_active'])
    expect(alice.client.view!.breakout!.groups).toHaveLength(2)
  })

  it('only members in the meeting are placed: someone gone or waiting stays out', () => {
    const { t, alice, carol } = room()
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const frank = t.join('Frank')
    const frankId = frank.client.of('lobby')[0].you
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['A'],
      assign: { [carol.id]: 0, [frankId]: 0, ghost: 0 },
      minutes: null,
    })
    expect(t.disk.breakout!.assign).toEqual({ [carol.id]: 'g1' })
    t.send(alice, { t: 'host', action: 'admit', memberId: frankId })
    expect(alice.client.view!.members[frankId]).toBeDefined()
    expect(alice.client.view!.members[frankId].group ?? null).toBeNull()
  })

  it('opening ends the spotlight and takes the whiteboard off the stage', () => {
    const { t, alice, carol } = room()
    t.send(alice, { t: 'spotlight', memberId: carol.id })
    t.send(alice, { t: 'whiteboard', open: true })
    expect(alice.client.view!.room.spotlight).toBe(carol.id)
    expect(alice.client.view!.room.whiteboard).not.toBeNull()
    t.send(alice, { t: 'breakoutOpen', groups: ['A'], assign: {}, minutes: null })
    expect(alice.client.view!.room.spotlight).toBeNull()
    expect(alice.client.view!.room.whiteboard).toBeNull()
  })

  it('is rate limited like the other room actions', () => {
    const { t, alice, carol } = opened()
    for (let i = 0; i < INTERACT_RATE.count; i++) {
      t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: i % 2 ? 'g1' : 'g2' })
    }
    expect(alice.client.errors).toContain('rate_limited')
  })
})

describe('AC-10.4: audio and video stay in their room', () => {
  it('a pull of someone in another room is refused; in the same room it goes through', () => {
    const { t, alice, carol, dan, erin } = opened()
    expect(pull(t, carol, dan)).toEqual({ ok: true, memberId: carol.id, pulls: ['cam'] })
    expect(pull(t, carol, erin)).toEqual({ ok: false, reason: 'not_found' })
    expect(pull(t, erin, carol)).toEqual({ ok: false, reason: 'not_found' })
    // The main room is a room too: no pulling into or out of it
    expect(pull(t, carol, alice)).toEqual({ ok: false, reason: 'not_found' })
    expect(pull(t, alice, carol)).toEqual({ ok: false, reason: 'not_found' })
    // One refused track refuses the whole call
    expect(
      t.host.sfuAccess(carol.token, `sess-${carol.id}`, [
        { sessionId: `sess-${dan.id}`, trackName: `mic-${dan.id}` },
        { sessionId: `sess-${erin.id}`, trackName: `mic-${erin.id}` },
      ]),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  it('pushing one’s own tracks is not affected', () => {
    const { t, carol } = opened()
    expect(t.host.sfuAccess(carol.token, `sess-${carol.id}`, [])).toEqual({
      ok: true,
      memberId: carol.id,
      pulls: [],
    })
  })

  it('a host who moves into a room can pull there, and no longer from the main room', () => {
    const { t, alice, bob, erin } = opened()
    expect(pull(t, alice, erin)).toEqual({ ok: false, reason: 'not_found' })
    t.send(alice, { t: 'breakoutMove', memberId: alice.id, group: 'g2' })
    expect(groupIn(bob, alice)).toBe('g2')
    expect(pull(t, alice, erin)).toMatchObject({ ok: true })
    expect(pull(t, erin, alice)).toMatchObject({ ok: true })
    expect(pull(t, alice, bob)).toEqual({ ok: false, reason: 'not_found' })
    // And back
    t.send(alice, { t: 'breakoutMove', memberId: alice.id, group: null })
    expect(pull(t, alice, bob)).toMatchObject({ ok: true })
    expect(pull(t, alice, erin)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('after the recall everyone can pull everyone again', () => {
    const { t, alice, carol, erin } = opened()
    t.send(alice, { t: 'breakoutClose', now: false })
    // Still apart during the grace
    expect(pull(t, carol, erin)).toEqual({ ok: false, reason: 'not_found' })
    t.send(alice, { t: 'breakoutClose', now: true })
    expect(alice.client.view!.breakout).toBeNull()
    expect(pull(t, carol, erin)).toMatchObject({ ok: true })
    expect(pull(t, alice, carol)).toMatchObject({ ok: true })
  })

  it('moving someone between rooms moves what they may pull', () => {
    const { t, alice, carol, dan, erin } = opened()
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: 'g2' })
    expect(pull(t, carol, erin)).toMatchObject({ ok: true })
    expect(pull(t, carol, dan)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('MAX_SHARES counts per room', () => {
    const { t, alice, bob, carol, dan, erin } = room()
    const frank = t.join('Frank')
    const grouped = [carol, dan, erin, frank]
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['A'],
      assign: Object.fromEntries(grouped.map((who) => [who.id, 0])),
      minutes: null,
    })
    // Two shares in the main room do not keep anyone in the breakout room from sharing
    for (const who of [alice, bob, carol, dan, erin]) t.send(who, { t: 'share' })
    expect(Object.keys(alice.client.view!.room.shares)).toHaveLength(MAX_SHARES + 2)
    t.send(frank, { t: 'share' })
    expect(frank.client.errors).toEqual(['share_full'])
  })
})

describe('chat in breakout rooms', () => {
  it('a message goes only to the sender’s room, and carries it', () => {
    const { t, alice, bob, carol, dan, erin } = opened()
    t.send(carol, { t: 'chat', text: '第一組好' })
    t.send(erin, { t: 'chat', text: '第二組好' })
    t.send(alice, { t: 'chat', text: '主會議室' })
    expect(carol.client.chatTexts).toEqual(['第一組好'])
    expect(dan.client.chatTexts).toEqual(['第一組好'])
    expect(erin.client.chatTexts).toEqual(['第二組好'])
    expect(bob.client.chatTexts).toEqual(['主會議室'])
    expect(carol.client.chat[0].group).toBe('g1')
    expect(bob.client.chat[0].group).toBeUndefined()
    expect(t.disk.chat.map((message) => message.group)).toEqual(['g1', 'g2', undefined])
  })

  it('a move sends the new room’s history, replacing the old one', () => {
    const { t, alice, carol, erin } = opened()
    t.send(alice, { t: 'chat', text: '開始前' })
    t.send(carol, { t: 'chat', text: '第一組' })
    t.send(erin, { t: 'chat', text: '第二組' })
    t.send(alice, { t: 'breakoutMove', memberId: alice.id, group: 'g2' })
    expect(alice.client.chatTexts).toEqual(['第二組'])
    expect(alice.client.of('chat').at(-1)!.reset).toBe(true)
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: 'g2' })
    expect(carol.client.chatTexts).toEqual(['第二組'])
    t.send(alice, { t: 'breakoutMove', memberId: alice.id, group: null })
    expect(alice.client.chatTexts).toEqual(['開始前'])
  })

  it('opening sends each member placed in a room that room’s (empty) chat', () => {
    const { t, alice, carol } = room()
    t.send(alice, { t: 'chat', text: '大家好' })
    expect(carol.client.chatTexts).toEqual(['大家好'])
    t.send(alice, { t: 'breakoutOpen', groups: ['A'], assign: { [carol.id]: 0 }, minutes: null })
    expect(carol.client.chatTexts).toEqual([])
    expect(alice.client.chatTexts).toEqual(['大家好'])
  })

  it('back in the main room after the recall, everyone has its chat again', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'chat', text: '主會議室' })
    t.send(carol, { t: 'chat', text: '第一組' })
    t.send(alice, { t: 'breakoutClose', now: true })
    expect(carol.client.chatTexts).toEqual(['主會議室'])
    expect(alice.client.chatTexts).toEqual(['主會議室'])
  })

  it('opening ends the poll first: its results go to the main room’s chat', () => {
    const { t, alice, bob, dan } = room()
    t.send(alice, {
      t: 'pollStart',
      question: '午餐',
      options: ['麵', '飯'],
      multi: false,
      anonymous: true,
    })
    const poll = alice.client.view!.poll!.id
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['A'],
      assign: { [bob.id]: 0, [dan.id]: 0 },
      minutes: null,
    })
    expect(alice.client.view!.poll).toBeNull()
    expect(alice.client.chat.map((message) => [message.text, message.group, message.from])).toEqual(
      [['午餐', undefined, alice.id]],
    )
    expect(alice.client.chat[0].poll!.question).toBe('午餐')
    // Dan saw it come in, then moved: his room's chat has none of it
    expect(dan.client.chat).toEqual([])
    t.send(bob, { t: 'pollEnd', poll })
    expect(bob.client.errors).toEqual([])
    t.send(alice, { t: 'breakoutClose', now: true })
    expect(dan.client.chatTexts).toEqual(['午餐'])
  })

  it('reactions stay in the sender’s room', () => {
    const { t, alice, carol, dan, erin } = opened()
    t.send(carol, { t: 'react', emoji: '👍' })
    expect(dan.client.of('reaction')).toHaveLength(1)
    expect(erin.client.of('reaction')).toHaveLength(0)
    expect(alice.client.of('reaction')).toHaveLength(0)
  })
})

describe('moving, broadcasting, recalling', () => {
  it('a move to a room that is not there, of someone not here, or with no rooms open is refused', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: 'g3' })
    t.send(alice, { t: 'breakoutMove', memberId: 'ghost', group: 'g1' })
    expect(alice.client.errors).toEqual(['forbidden', 'forbidden'])
    expect(groupIn(alice, carol)).toBe('g1')
    const r = room()
    r.t.send(r.alice, { t: 'breakoutMove', memberId: r.carol.id, group: 'g1' })
    expect(r.alice.client.errors).toEqual(['forbidden'])
  })

  it('a broadcast reaches every room, by name and at the server’s time', () => {
    const { t, bob, carol, erin } = opened()
    t.tick(5_000)
    t.send(bob, { t: 'breakoutBroadcast', text: '  還有五分鐘  ' })
    for (const viewer of [carol, erin]) {
      expect(viewer.client.view!.breakout!.broadcast).toEqual({
        text: '還有五分鐘',
        by: 'Bob',
        at: t.clock,
      })
    }
  })

  it('a broadcast with no rooms open is refused', () => {
    const { t, alice } = room()
    t.send(alice, { t: 'breakoutBroadcast', text: '嗨' })
    expect(alice.client.errors).toEqual(['forbidden'])
  })

  it('a recall gives everyone the grace, then brings them back on the alarm', () => {
    const { t, alice, carol } = opened(null)
    t.send(alice, { t: 'breakoutClose', now: false })
    expect(carol.client.view!.breakout!.closesAt).toBe(t.clock + BREAKOUT_RECALL_MS)
    expect(groupIn(carol, carol)).toBe('g1')
    const closesAt = t.clock + BREAKOUT_RECALL_MS
    // The sweeps before it change nothing
    while (t.host.nextAlarm()! < closesAt) t.alarm()
    expect(carol.client.view!.breakout).not.toBeNull()
    t.alarmsUntil(closesAt)
    expect(t.clock).toBe(closesAt)
    expect(carol.client.view!.breakout).toBeNull()
    expect(groupIn(carol, carol)).toBeNull()
    expect(t.disk.breakout).toBeNull()
  })

  it('a recall with no rooms open is no error', () => {
    const { t, alice } = room()
    t.send(alice, { t: 'breakoutClose', now: false })
    expect(alice.client.errors).toEqual([])
  })

  it('the time running out starts the recall on the alarm; its grace brings everyone back', () => {
    const { t, alice, carol, dan, erin } = opened(1)
    const endsAt = t.clock + 60_000
    t.alarmsUntil(endsAt)
    expect(t.clock).toBe(endsAt)
    expect(carol.client.view!.breakout!.closesAt).toBe(endsAt + BREAKOUT_RECALL_MS)
    expect(pull(t, carol, erin)).toEqual({ ok: false, reason: 'not_found' })
    t.alarmsUntil(endsAt + BREAKOUT_RECALL_MS)
    for (const viewer of [alice, carol, dan, erin]) {
      expect(viewer.client.view!.breakout).toBeNull()
      expect(groupIn(viewer, carol)).toBeNull()
    }
    expect(pull(t, carol, erin)).toMatchObject({ ok: true })
  })
})

describe('what is refused while the rooms are open', () => {
  it('spotlight, opening the whiteboard and starting a poll: breakout_active', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'spotlight', memberId: carol.id })
    t.send(alice, { t: 'whiteboard', open: true })
    t.send(alice, {
      t: 'pollStart',
      question: '?',
      options: ['a', 'b'],
      multi: false,
      anonymous: false,
    })
    expect(alice.client.errors).toEqual(['breakout_active', 'breakout_active', 'breakout_active'])
    expect(alice.client.view!.room.spotlight).toBeNull()
    expect(alice.client.view!.room.whiteboard).toBeNull()
    expect(alice.client.view!.poll).toBeNull()
  })

  it('a participant is still told forbidden first', () => {
    const { t, carol } = opened()
    t.send(carol, { t: 'spotlight', memberId: carol.id })
    t.send(carol, {
      t: 'pollStart',
      question: '?',
      options: ['a', 'b'],
      multi: false,
      anonymous: false,
    })
    expect(carol.client.errors).toEqual(['forbidden', 'forbidden'])
  })

  it('all of it works again after the recall', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'breakoutClose', now: true })
    t.send(alice, { t: 'spotlight', memberId: carol.id })
    t.send(alice, { t: 'whiteboard', open: true })
    expect(alice.client.errors).toEqual([])
    expect(alice.client.view!.room.spotlight).toBe(carol.id)
  })
})

describe('who comes and goes', () => {
  it('someone new lands in the main room', () => {
    const { t, alice } = opened()
    const frank = t.join('Frank')
    expect(groupIn(alice, frank)).toBeNull()
    expect(frank.client.view!.breakout).not.toBeNull()
  })

  it('a reconnect keeps the room, and its chat', () => {
    const { t, carol, dan } = opened()
    t.send(dan, { t: 'chat', text: '第一組' })
    t.drop(carol)
    expect(dan.client.view!.members[carol.id].reconnecting).toBe(true)
    const back = t.join('Carol', carol.token)
    expect(back.id).toBe(carol.id)
    expect(groupIn(back, back)).toBe('g1')
    expect(back.client.chatTexts).toEqual(['第一組'])
  })

  it('someone who leaves is forgotten, and comes back as someone new in the main room', () => {
    const { t, alice, erin } = opened()
    t.send(erin, { t: 'leave' })
    expect(t.disk.breakout!.assign[erin.id]).toBeUndefined()
    const again = t.join('Erin')
    expect(groupIn(alice, again)).toBeNull()
  })

  it('the meeting ending takes the rooms along', () => {
    const { t, alice } = opened()
    t.send(alice, { t: 'host', action: 'endMeeting' })
    expect(t.disk.breakout).toBeNull()
  })
})

describe('an eviction', () => {
  it('brings back the rooms, who is where, the isolation and the clock', () => {
    const { t, alice, carol, dan, erin } = opened(1)
    t.send(alice, { t: 'breakoutBroadcast', text: '加油' })
    const before = t.host.view()
    t.evict()
    expect(t.host.view()).toEqual(before)
    expect(pull(t, carol, dan)).toMatchObject({ ok: true })
    expect(pull(t, carol, erin)).toEqual({ ok: false, reason: 'not_found' })
    t.send(carol, { t: 'chat', text: '還在第一組' })
    expect(dan.client.chatTexts).toContain('還在第一組')
    expect(erin.client.chatTexts).not.toContain('還在第一組')
    // The clock goes on after the eviction
    while (t.host.view().breakout) t.alarm()
    expect(groupIn(alice, carol)).toBeNull()
  })

  it('forgets an assignment of someone no longer stored as a member', () => {
    const { t, carol } = opened()
    t.disk.sessions = t.disk.sessions.filter((record) => record.member.id !== carol.id)
    t.evict()
    expect(t.disk.breakout!.assign[carol.id]).toBeUndefined()
  })
})

describe('annotations in breakout rooms', () => {
  const stroke = (id: string) => ({
    op: 'add',
    stroke: { id, tool: 'pen', color: 'rose', width: 'medium', points: [[0.1, 0.1]] },
  })

  /** Carol (in 第一組) shares and draws on her share */
  function drawing() {
    const r = room()
    const { t, alice, carol } = r
    // The whiteboard's strokes, drawn before the rooms opened, stay for everyone
    t.send(alice, { t: 'whiteboard', open: true })
    t.send(alice, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [stroke('wb-1')] })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toHaveLength(1)
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['第一組', '第二組'],
      assign: { [r.carol.id]: 0, [r.dan.id]: 0, [r.erin.id]: 1 },
      minutes: 10,
    })
    expect(alice.client.view!.room.whiteboard).toBeNull()
    t.send(carol, { t: 'share' })
    for (const who of [r.alice, r.bob, r.carol, r.dan, r.erin]) who.client.forget()
    t.send(carol, { t: 'annotate', share: carol.id, ops: [stroke('c-1')] })
    return r
  }

  const layerFrames = (who: Who, share: string) =>
    who.client.of('annotation').filter((frame) => frame.share === share)
  const snapshotShares = (who: Who) =>
    who.client.of('annotations').flatMap((frame) => (frame.share === null ? [] : [frame.share]))

  it('strokes on a share go only to the sharer’s room', () => {
    const { alice, carol, dan, erin } = drawing()
    expect(layerFrames(dan, carol.id)).toHaveLength(1)
    expect(layerFrames(erin, carol.id)).toHaveLength(0)
    expect(layerFrames(alice, carol.id)).toHaveLength(0)
  })

  it('drawing on a share in another room is refused and taken back; once in that room it is not', () => {
    const { t, alice, carol, dan } = drawing()
    t.send(alice, { t: 'annotate', share: carol.id, ops: [stroke('a-1')] })
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(layerFrames(alice, carol.id).at(-1)!.ops).toEqual([{ op: 'remove', id: 'a-1' }])
    expect(layerFrames(dan, carol.id)).toHaveLength(1)
    expect(t.host.annotationsOf(carol.id).map((s) => s.id)).toEqual(['c-1'])
    t.send(alice, { t: 'breakoutMove', memberId: alice.id, group: 'g1' })
    t.send(alice, { t: 'annotate', share: carol.id, ops: [stroke('a-2')] })
    expect(t.host.annotationsOf(carol.id).map((s) => s.id)).toEqual(['c-1', 'a-2'])
    expect(layerFrames(dan, carol.id)).toHaveLength(2)
  })

  it('clearing a share in another room is refused; the whiteboard is the whole meeting’s', () => {
    const { t, alice, carol } = drawing()
    t.send(alice, { t: 'clearAnnotations', share: carol.id, by: null })
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(t.host.annotationsOf(carol.id)).toHaveLength(1)
    t.send(alice, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toHaveLength(0)
  })

  it('a share that ends is cleared only in its room', () => {
    const { t, carol, dan, erin } = drawing()
    t.send(carol, { t: 'unshare' })
    expect(layerFrames(dan, carol.id).at(-1)!.ops).toEqual([{ op: 'clear' }])
    expect(layerFrames(erin, carol.id)).toHaveLength(0)
  })

  it('a welcome or a reconnect sends the whiteboard and only the own room’s shares', () => {
    const { t, carol, erin } = drawing()
    const frank = t.join('Frank')
    expect(snapshotShares(frank)).toEqual([WHITEBOARD_LAYER])
    t.drop(erin)
    const back = t.join('Erin', erin.token)
    expect(snapshotShares(back)).toEqual([WHITEBOARD_LAYER])
    const frames = back.client.of('annotations')
    expect(frames[0].reset).toBe(true)
    expect(frames.at(-1)!.done).toBe(true)
    t.drop(carol)
    const carolBack = t.join('Carol', carol.token)
    expect(snapshotShares(carolBack).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
  })

  it('a move sends the new room’s strokes, replacing the old ones; so does the recall', () => {
    const { t, alice, carol, erin } = drawing()
    t.send(alice, { t: 'breakoutMove', memberId: erin.id, group: 'g1' })
    expect(snapshotShares(erin).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
    expect(erin.client.of('annotations')[0].reset).toBe(true)
    erin.client.forget()
    t.send(alice, { t: 'breakoutMove', memberId: erin.id, group: 'g2' })
    expect(snapshotShares(erin)).toEqual([WHITEBOARD_LAYER])
    alice.client.forget()
    erin.client.forget()
    t.send(alice, { t: 'breakoutClose', now: true })
    expect(snapshotShares(erin).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
    // The end of the rooms brings every share back to everyone: Alice gets them again too
    expect(snapshotShares(alice).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
  })

  it('a sharer who moves takes the strokes along: both rooms get them again', () => {
    const { t, alice, bob, carol, dan, erin } = drawing()
    for (const who of [alice, bob, carol, dan, erin]) who.client.forget()
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: 'g2' })
    expect(snapshotShares(erin).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
    expect(snapshotShares(carol).sort()).toEqual([carol.id, WHITEBOARD_LAYER].sort())
    expect(snapshotShares(dan)).toEqual([WHITEBOARD_LAYER])
    expect(dan.client.of('annotations')[0].reset).toBe(true)
    // The main room had nothing to do with it
    expect(alice.client.of('annotations')).toHaveLength(0)
    expect(bob.client.of('annotations')).toHaveLength(0)
  })

  it('someone without a share who moves changes nothing for the others', () => {
    const { t, alice, carol, dan, erin } = drawing()
    for (const who of [alice, carol, dan, erin]) who.client.forget()
    t.send(alice, { t: 'breakoutMove', memberId: dan.id, group: 'g2' })
    expect(snapshotShares(dan)).toEqual([WHITEBOARD_LAYER])
    expect(carol.client.of('annotations')).toHaveLength(0)
    expect(erin.client.of('annotations')).toHaveLength(0)
  })
})

describe('what belongs to the whole meeting ends when the rooms open', () => {
  it('every recording stops, each recorder told; recording is refused while they are open', () => {
    const { t, alice, bob, carol } = room()
    t.send(alice, { t: 'record', on: true })
    t.send(carol, { t: 'consent' })
    expect(Object.keys(bob.client.view!.room.recordings)).toEqual([alice.id])
    t.send(bob, { t: 'breakoutOpen', groups: ['A'], assign: { [carol.id]: 0 }, minutes: null })
    expect(alice.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'recordingStopped',
      by: bob.id,
    })
    expect(bob.client.view!.room.recordings).toEqual({})
    t.send(alice, { t: 'record', on: true })
    t.send(carol, { t: 'record', on: true })
    expect(alice.client.errors).toEqual(['breakout_active'])
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(bob.client.view!.room.recordings).toEqual({})
    // Nobody who did not agree to anything is sent away
    t.alarmsUntil(t.clock + CONSENT_TIMEOUT_MS * 2)
    expect(Object.keys(alice.client.view!.members)).toHaveLength(5)
    t.send(alice, { t: 'breakoutClose', now: true })
    t.send(alice, { t: 'record', on: true })
    expect(Object.keys(bob.client.view!.room.recordings)).toEqual([alice.id])
  })
})

describe('breakoutClose: a recall, or now', () => {
  it('a second recall without now leaves the grace alone', () => {
    const { t, alice, bob, carol } = opened()
    t.send(alice, { t: 'breakoutClose', now: false })
    const closesAt = carol.client.view!.breakout!.closesAt
    t.tick(10_000)
    t.send(bob, { t: 'breakoutClose', now: false })
    expect(carol.client.view!.breakout!.closesAt).toBe(closesAt)
    expect(bob.client.errors).toEqual([])
  })

  it('now ends the rooms at once, with or without a recall under way', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'breakoutClose', now: true })
    expect(carol.client.view!.breakout).toBeNull()
    expect(groupIn(carol, carol)).toBeNull()
  })

  it('a breakoutClose without now is not understood', () => {
    const { t, alice, carol } = opened()
    t.send(alice, { t: 'breakoutClose' })
    expect(alice.client.errors).toEqual(['bad_message'])
    expect(carol.client.view!.breakout!.closesAt).toBeNull()
  })
})

describe('the history a move sends', () => {
  it('every frame of it is marked regroup, the first one reset; a welcome’s is not', () => {
    const { t, alice, carol, erin } = opened()
    for (let i = 0; i < CHAT_CHUNK + 5; i++) {
      t.tick(1_000)
      t.send(erin, { t: 'chat', text: `第二組 ${i}` })
    }
    carol.client.forget()
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: 'g2' })
    const frames = carol.client.of('chat')
    expect(frames).toHaveLength(2)
    expect(frames.every((frame) => frame.regroup === true)).toBe(true)
    expect(frames[0].reset).toBe(true)
    expect(frames[1].reset).toBeUndefined()
    expect(carol.client.chat).toHaveLength(CHAT_CHUNK + 5)
    // A new message is news again
    t.tick(10_000)
    t.send(erin, { t: 'chat', text: '歡迎' })
    expect(carol.client.of('chat').at(-1)!.regroup).toBeUndefined()
    const frank = t.join('Frank')
    expect(frank.client.of('chat').every((frame) => frame.regroup === undefined)).toBe(true)
  })
})

describe('MAX_SHARES after people change rooms', () => {
  it('a move or the end of the rooms that brings too many together stops the newest', () => {
    const { t, alice, bob, carol, dan, erin } = room()
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['A'],
      assign: { [carol.id]: 0, [dan.id]: 0, [erin.id]: 0 },
      minutes: null,
    })
    for (const who of [alice, bob, carol, dan, erin]) {
      t.tick(1_000)
      t.send(who, { t: 'share' })
    }
    expect(Object.keys(alice.client.view!.room.shares)).toHaveLength(5)
    // Carol makes three in the main room: still fits
    t.send(alice, { t: 'breakoutMove', memberId: carol.id, group: null })
    expect(Object.keys(alice.client.view!.room.shares)).toHaveLength(5)
    // Dan makes four: his, the newest, stops
    t.send(alice, { t: 'breakoutMove', memberId: dan.id, group: null })
    expect(alice.client.view!.room.shares[dan.id]).toBeUndefined()
    expect(dan.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'shareStopped',
      by: alice.id,
    })
    // Everyone back: Erin's, the newest left, stops; the oldest three stay
    t.send(bob, { t: 'breakoutClose', now: true })
    expect(Object.keys(alice.client.view!.room.shares).sort()).toEqual(
      [alice.id, bob.id, carol.id].sort(),
    )
    expect(erin.client.of('notice').at(-1)).toMatchObject({ notice: 'shareStopped', by: bob.id })
    expect(alice.client.of('notice').filter((n) => n.notice === 'shareStopped')).toHaveLength(0)
  })

  it('when the clock ends the rooms, the sharer is named as who stopped it', () => {
    const { t, alice, bob, carol, dan, erin } = room()
    t.send(alice, {
      t: 'breakoutOpen',
      groups: ['A'],
      assign: { [carol.id]: 0, [dan.id]: 0 },
      minutes: 1,
    })
    for (const who of [alice, bob, erin, carol, dan]) {
      t.tick(1_000)
      t.send(who, { t: 'share' })
    }
    while (alice.client.view!.breakout) t.alarm()
    expect(Object.keys(alice.client.view!.room.shares).sort()).toEqual(
      [alice.id, bob.id, erin.id].sort(),
    )
    expect(dan.client.of('notice').at(-1)).toMatchObject({ notice: 'shareStopped', by: dan.id })
  })
})
