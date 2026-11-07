// L5 (e5-t07, e5-t08, e1-t18; AC-5.5): polls, the countdown and the agenda as room state, and what a
// persistent room's owner sets on /me. The room decides who may, the limits hold, everything comes
// back after a reconnect and an eviction, and someone new gets it in their welcome. An anonymous
// poll never tells anyone who voted what.
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../shared/chat.ts'
import {
  INTERACT_RATE,
  MAX_AGENDA_ITEMS,
  MAX_AGENDA_MINUTES,
  MAX_AGENDA_TITLE_CHARS,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_CHARS,
  MAX_POLL_QUESTION_CHARS,
  MAX_POLL_VOTERS,
  MAX_TIMER_SECONDS,
  POLL_START_RATE,
} from '../../shared/interact.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  viewAsJson,
  type NoticeKind,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { CONSENT_TIMEOUT_MS } from '../../shared/protocol.ts'
import type { InteractState } from '../../worker/room-interact.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }
const SLUG = 'gene-weekly'
const OWNER = 'account-owner'

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

  get notices(): NoticeKind[] {
    return this.of('notice').map((message) => message.notice)
  }

  get chat(): ChatMessage[] {
    return this.of('chat').flatMap((message) => message.messages)
  }
}

function setup({ persistent = false }: { persistent?: boolean } = {}) {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    chat: [] as ChatMessage[],
    interact: null as InteractState | null,
    /** Everything the room stored, for looking for what must not be shown */
    persistent: null as { slug: string; owner: string; createdAt: number } | null,
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
        saveSchedule: () => {},
        saveChat: (message) => void disk.chat.push(structuredClone(message)),
        dropChat: () => {},
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        savePersistent: (record) => void (disk.persistent = record),
        saveInteract: (state) => void (disk.interact = structuredClone(state)),
        clear: () => {
          disk.info = null
          disk.chat = []
          disk.interact = null
          disk.persistent = null
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = makeHost()
  if (persistent) host.createPersistent({ slug: SLUG, owner: OWNER, createdAt: 1 }, '週會')
  else host.create(ROOM)
  function join(
    name: string,
    { token = null, account = null }: { token?: string | null; account?: string | null } = {},
  ) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn, null, account)
    void host.message(conn, JSON.stringify({ t: 'join', name, token, client: null }))
    const welcome = client.of('welcome')[0]
    return { conn, client, id: welcome?.you ?? '', token: welcome?.token ?? '' }
  }
  const send = (who: { conn: string }, message: object) =>
    void host.message(who.conn, JSON.stringify(message))
  const evict = () => {
    host = makeHost()
    const sockets = [...clients.keys()].map((conn) => ({ conn, openedAt: clock }))
    host.restore(disk.info, disk.rev, disk.sessions, sockets, null, null, disk.chat, [], {
      persistent: disk.persistent,
      interact: disk.interact,
    })
  }
  return {
    get host() {
      return host
    },
    disk,
    join,
    send,
    evict,
    /** The socket drops; the member is reconnecting */
    drop: (who: { conn: string }) => host.closed(who.conn),
    tick: (ms: number) => void (clock += ms),
    get clock() {
      return clock
    },
  }
}

const POLL = { t: 'pollStart', question: '午餐吃什麼', options: ['麵', '飯'], multi: false, anonymous: false }

/** Alice (host), Bob (co-host), Carol (participant) */
function room() {
  const t = setup()
  const alice = t.join('Alice')
  const bob = t.join('Bob')
  const carol = t.join('Carol')
  t.send(alice, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
  return { t, alice, bob, carol }
}

const pollId = (client: FakeClient) => client.view!.poll!.id

describe('polls: who may', () => {
  it('a host or co-host starts and ends; a participant is refused both', () => {
    const { t, alice, bob, carol } = room()
    t.send(carol, POLL)
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(carol.client.view!.poll).toBeNull()
    t.send(bob, POLL)
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollEnd', poll: id })
    expect(carol.client.errors).toEqual(['forbidden', 'forbidden'])
    expect(alice.client.view!.poll).not.toBeNull()
    t.send(alice, { t: 'pollEnd', poll: id })
    expect(alice.client.view!.poll).toBeNull()
  })

  it('one at a time: another is refused until it ends', () => {
    const { t, alice, bob } = room()
    t.send(alice, POLL)
    const question = alice.client.view!.poll!.question
    t.send(bob, { ...POLL, question: '另一題' })
    expect(bob.client.errors).toEqual(['poll_active'])
    expect(alice.client.view!.poll!.question).toBe(question)
  })

  it('someone in the waiting room may not vote, and sees nothing of the poll', () => {
    const { t, alice } = room()
    t.send(alice, POLL)
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const dan = t.join('Dan')
    expect(dan.client.of('lobby')).toHaveLength(1)
    expect(JSON.stringify(dan.client.received)).not.toContain('午餐')
    t.send(dan, { t: 'pollVote', poll: pollId(alice.client), choices: [0] })
    expect(dan.client.errors).toEqual(['forbidden'])
    expect(alice.client.view!.poll!.voters).toBe(0)
  })

  it('the pre-join summary says nothing of a poll, a timer or an agenda', () => {
    const { t, alice } = room()
    t.send(alice, POLL)
    t.send(alice, { t: 'timer', seconds: 60 })
    t.send(alice, { t: 'agenda', items: [{ title: '開場', minutes: 5 }] })
    const summary = JSON.stringify(t.host.summary())
    expect(summary).not.toContain('午餐')
    expect(summary).not.toContain('開場')
    expect(summary).not.toContain('endsAt')
  })
})

describe('polls: answering', () => {
  it('counts live for everyone; a new answer replaces the old', () => {
    const { t, alice, bob, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    for (const member of [alice, bob, carol]) {
      expect(member.client.view!.poll).toMatchObject({ counts: [1, 0], voters: 1 })
    }
    t.send(carol, { t: 'pollVote', poll: id, choices: [1] })
    expect(bob.client.view!.poll).toMatchObject({ counts: [0, 1], voters: 1 })
    t.send(bob, { t: 'pollVote', poll: id, choices: [1] })
    expect(alice.client.view!.poll).toMatchObject({ counts: [0, 2], voters: 2 })
    expect(carol.client.of('pollVoted').at(-1)).toEqual({ t: 'pollVoted', poll: id, choices: [1] })
  })

  it('one choice unless the poll allows several; only choices it has', () => {
    const { t, alice, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [0, 1] })
    t.send(carol, { t: 'pollVote', poll: id, choices: [2] })
    expect(carol.client.errors).toEqual(['bad_message', 'bad_message'])
    expect(alice.client.view!.poll!.voters).toBe(0)
    t.send(alice, { t: 'pollEnd', poll: id })
    t.tick(1)
    t.send(alice, { ...POLL, multi: true })
    const multi = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: multi, choices: [1, 0] })
    expect(alice.client.view!.poll).toMatchObject({ counts: [1, 1], voters: 1 })
  })

  it('an answer to a poll that just ended is dropped without an error', () => {
    const { t, alice, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    t.send(alice, { t: 'pollEnd', poll: id })
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    expect(carol.client.errors).toEqual([])
    expect(carol.client.of('pollVoted')).toEqual([])
  })

  it('shows who voted what, unless it is anonymous; an anonymous answer goes to its owner alone', () => {
    const named = room()
    named.t.send(named.alice, POLL)
    named.t.send(named.carol, { t: 'pollVote', poll: pollId(named.alice.client), choices: [1] })
    expect(named.alice.client.view!.poll!.votes).toEqual([{ name: 'Carol', choices: [1] }])

    const { t, alice, bob, carol } = room()
    t.send(alice, { ...POLL, anonymous: true })
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [1] })
    expect(alice.client.view!.poll).toMatchObject({ counts: [0, 1], voters: 1 })
    expect(alice.client.view!.poll!.votes).toBeUndefined()
    // Nothing anyone else receives names who voted, not the host or the co-host
    for (const other of [alice, bob]) {
      expect(other.client.of('pollVoted')).toEqual([])
      const seen = other.client.of('patch').filter((m) => JSON.stringify(m.ops).includes('poll'))
      expect(JSON.stringify(seen)).not.toMatch(/Carol|votes/)
    }
    expect(carol.client.of('pollVoted')).toHaveLength(1)
    // Nor do the results in the chat
    t.send(alice, { t: 'pollEnd', poll: id })
    const message = alice.client.chat.at(-1)!
    expect(message.poll).toMatchObject({ counts: [0, 1], voters: 1, anonymous: true })
    expect(message.poll!.votes).toBeUndefined()
  })

  it('counts at most MAX_POLL_VOTERS members; who already voted may still change', () => {
    const { t, alice, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    // More members than a room holds at once: the count is on the poll's storage, not on who is here
    for (let n = 1; n < MAX_POLL_VOTERS; n++) {
      const member = t.join(`V${n}`)
      t.send(member, { t: 'pollVote', poll: id, choices: [0] })
      t.send(member, { t: 'leave' })
    }
    expect(alice.client.view!.poll!.voters).toBe(MAX_POLL_VOTERS)
    const late = t.join('Late')
    t.send(late, { t: 'pollVote', poll: id, choices: [1] })
    expect(late.client.errors).toEqual(['rate_limited'])
    expect(alice.client.view!.poll!.voters).toBe(MAX_POLL_VOTERS)
    t.send(carol, { t: 'pollVote', poll: id, choices: [1] })
    expect(alice.client.view!.poll!.counts).toEqual([MAX_POLL_VOTERS - 1, 1])
  })
})

describe('polls: ending posts to the chat', () => {
  it('the results are a chat message from who ended it, for everyone and for who comes later', () => {
    const { t, alice, bob, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    t.send(bob, { t: 'pollEnd', poll: id })
    const message = carol.client.chat.at(-1)!
    expect(message).toMatchObject({ from: bob.id, name: 'Bob', text: '午餐吃什麼' })
    expect(message.poll).toEqual({
      question: '午餐吃什麼',
      options: ['麵', '飯'],
      multi: false,
      anonymous: false,
      counts: [1, 0],
      voters: 1,
      votes: [{ name: 'Carol', choices: [0] }],
    })
    const dan = t.join('Dan')
    expect(dan.client.chat.at(-1)!.poll).toEqual(message.poll)
    // Ended twice (two co-hosts at once): one message
    const count = carol.client.chat.length
    t.send(alice, { t: 'pollEnd', poll: id })
    expect(carol.client.chat).toHaveLength(count)
    expect(alice.client.errors).toEqual([])
  })
})

describe('the state survives', () => {
  it('reconnecting: the same poll and our own answer, also on an anonymous poll', () => {
    const { t, alice, carol } = room()
    t.send(alice, { ...POLL, anonymous: true })
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [1] })
    t.send(alice, { t: 'timer', seconds: 300 })
    t.send(alice, { t: 'agenda', items: [{ title: '開場', minutes: 5 }] })
    t.drop(carol)
    const back = t.join('Carol', { token: carol.token })
    expect(back.id).toBe(carol.id)
    expect(back.client.view!.poll).toMatchObject({ id, counts: [0, 1], voters: 1 })
    expect(back.client.of('pollVoted')).toEqual([{ t: 'pollVoted', poll: id, choices: [1] }])
    expect(back.client.view!.timer).toEqual(alice.client.view!.timer)
    expect(back.client.view!.agenda).toEqual(alice.client.view!.agenda)
    // Counted once, however often they came back
    expect(alice.client.view!.poll!.voters).toBe(1)
  })

  it('someone new gets all of it in their welcome, with no answer of their own', () => {
    const { t, alice } = room()
    t.send(alice, POLL)
    t.send(alice, { t: 'timer', seconds: 300 })
    t.send(alice, { t: 'agenda', items: [{ title: '開場', minutes: 5 }] })
    const dan = t.join('Dan')
    expect(dan.client.view!.poll!.question).toBe('午餐吃什麼')
    expect(dan.client.view!.timer).toEqual({ endsAt: t.clock + 300_000, seconds: 300 })
    expect(dan.client.view!.agenda).toEqual({ items: [{ title: '開場', minutes: 5 }], current: 0 })
    expect(dan.client.of('pollVoted')).toEqual([])
  })

  it('someone admitted from the waiting room gets it too', () => {
    const { t, alice } = room()
    t.send(alice, POLL)
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const dan = t.join('Dan')
    t.send(alice, { t: 'host', action: 'admit', memberId: dan.client.of('lobby')[0].you })
    expect(dan.client.of('welcome')[0].state.poll!.question).toBe('午餐吃什麼')
  })

  it('an eviction: votes, anonymity, the timer and the agenda come back from storage', () => {
    const { t, alice, carol } = room()
    t.send(alice, { ...POLL, anonymous: true })
    const id = pollId(alice.client)
    t.send(carol, { t: 'pollVote', poll: id, choices: [1] })
    t.send(alice, { t: 'timer', seconds: 300 })
    t.send(alice, { t: 'agenda', items: [{ title: 'A', minutes: 5 }, { title: 'B', minutes: 9 }] })
    t.send(alice, { t: 'agendaCurrent', index: 1 })
    t.evict()
    const view = t.host.view()
    expect(view.poll).toMatchObject({ id, counts: [0, 1], voters: 1, anonymous: true })
    expect(view.poll!.votes).toBeUndefined()
    expect(view.timer).toMatchObject({ seconds: 300 })
    expect(view.agenda!.current).toBe(1)
    // Changing the answer after waking up replaces it: it is not counted twice
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    expect(t.host.view().poll).toMatchObject({ counts: [1, 0], voters: 1 })
  })

  it('goes with the meeting: a persistent room starts its next one with none of it', () => {
    const t = setup({ persistent: true })
    const owner = t.join('Gene', { account: OWNER })
    t.send(owner, POLL)
    t.send(owner, { t: 'timer', seconds: 300 })
    t.send(owner, { t: 'agenda', items: [{ title: '開場', minutes: 5 }] })
    t.send(owner, { t: 'host', action: 'endMeeting' })
    expect(t.disk.interact).toBeNull()
    const next = t.join('Gene', { account: OWNER })
    expect(next.client.view).toMatchObject({ poll: null, timer: null, agenda: null })
  })
})

describe('the countdown', () => {
  it('a host or co-host sets it, on the room’s clock, and ends it; a participant is refused', () => {
    const { t, alice, bob, carol } = room()
    t.send(carol, { t: 'timer', seconds: 60 })
    expect(carol.client.errors).toEqual(['forbidden'])
    t.send(bob, { t: 'timer', seconds: 60 })
    expect(alice.client.view!.timer).toEqual({ endsAt: t.clock + 60_000, seconds: 60 })
    t.tick(5_000)
    t.send(alice, { t: 'timer', seconds: 120 })
    expect(carol.client.view!.timer).toEqual({ endsAt: t.clock + 120_000, seconds: 120 })
    t.send(alice, { t: 'timer', seconds: null })
    expect(carol.client.view!.timer).toBeNull()
  })
})

describe('the agenda', () => {
  const items = [
    { title: '開場', minutes: 5 },
    { title: '討論', minutes: 20 },
  ]

  it('a host or co-host sets it and moves it along; everyone sees which item is on', () => {
    const { t, alice, bob, carol } = room()
    t.send(carol, { t: 'agenda', items })
    t.send(carol, { t: 'agendaCurrent', index: 0 })
    expect(carol.client.errors).toEqual(['forbidden', 'forbidden'])
    t.send(bob, { t: 'agenda', items })
    expect(carol.client.view!.agenda).toEqual({ items, current: 0 })
    t.send(alice, { t: 'agendaCurrent', index: 1 })
    expect(carol.client.view!.agenda!.current).toBe(1)
    // Past the end: the list changed under the button
    t.send(alice, { t: 'agendaCurrent', index: 2 })
    expect(carol.client.view!.agenda!.current).toBe(1)
    t.send(alice, { t: 'agenda', items: [] })
    expect(carol.client.view!.agenda).toBeNull()
  })
})

describe('limits', () => {
  it('POLL_START_RATE polls per member', () => {
    const { t, alice } = room()
    for (let n = 0; n < POLL_START_RATE.count; n++) {
      t.send(alice, POLL)
      t.send(alice, { t: 'pollEnd', poll: pollId(alice.client) })
      t.tick(1)
    }
    t.send(alice, POLL)
    expect(alice.client.errors).toEqual(['rate_limited'])
    expect(alice.client.view!.poll).toBeNull()
    t.tick(POLL_START_RATE.windowMs)
    t.send(alice, POLL)
    expect(alice.client.view!.poll).not.toBeNull()
  })

  it('INTERACT_RATE votes, timers and agenda changes per member', () => {
    const { t, alice, carol } = room()
    t.send(alice, POLL)
    const id = pollId(alice.client)
    for (let n = 0; n < INTERACT_RATE.count; n++) {
      t.send(carol, { t: 'pollVote', poll: id, choices: [n % 2] })
    }
    expect(carol.client.errors).toEqual([])
    t.send(carol, { t: 'pollVote', poll: id, choices: [0] })
    expect(carol.client.errors).toEqual(['rate_limited'])
    for (let n = 0; n < INTERACT_RATE.count; n++) t.send(alice, { t: 'timer', seconds: 60 + n })
    const set = alice.client.view!.timer
    t.send(alice, { t: 'timer', seconds: 5 })
    expect(alice.client.errors).toEqual(['rate_limited'])
    expect(alice.client.view!.timer).toEqual(set)
  })

  const parses = (message: object) => parseClientMessage(JSON.stringify(message)) !== null
  const options = (count: number) => Array.from({ length: count }, (_, n) => `選項${n}`)

  it('refuses a malformed poll at the door', () => {
    expect(parses(POLL)).toBe(true)
    expect(parses({ ...POLL, question: '   ' })).toBe(false)
    expect(parses({ ...POLL, question: 'q'.repeat(MAX_POLL_QUESTION_CHARS + 1) })).toBe(false)
    expect(parses({ ...POLL, options: ['一'] })).toBe(false)
    expect(parses({ ...POLL, options: options(MAX_POLL_OPTIONS) })).toBe(true)
    expect(parses({ ...POLL, options: options(MAX_POLL_OPTIONS + 1) })).toBe(false)
    expect(parses({ ...POLL, options: ['同', ' 同 '] })).toBe(false)
    expect(parses({ ...POLL, options: ['o'.repeat(MAX_POLL_OPTION_CHARS + 1), 'b'] })).toBe(false)
    expect(parses({ ...POLL, options: 'ab' })).toBe(false)
    expect(parses({ ...POLL, options: [1, 2] })).toBe(false)
    expect(parses({ ...POLL, multi: 'yes' })).toBe(false)
    expect(parses({ ...POLL, anonymous: undefined })).toBe(false)
    // Control characters and bidi overrides go, as in a name
    expect(parseClientMessage(JSON.stringify({ ...POLL, question: 'a‮b' }))).toMatchObject({
      question: 'ab',
    })
  })

  it('refuses malformed answers, timers and agendas at the door', () => {
    expect(parses({ t: 'pollVote', poll: 1, choices: [0] })).toBe(true)
    for (const choices of [[], [0, 0], [-1], [0.5], ['0'], null, Array(MAX_POLL_OPTIONS + 1).fill(0)]) {
      expect(parses({ t: 'pollVote', poll: 1, choices })).toBe(false)
    }
    expect(parses({ t: 'pollVote', poll: 'x', choices: [0] })).toBe(false)
    expect(parses({ t: 'pollEnd' })).toBe(false)

    expect(parses({ t: 'timer', seconds: null })).toBe(true)
    expect(parses({ t: 'timer', seconds: MAX_TIMER_SECONDS })).toBe(true)
    for (const seconds of [0, -1, 1.5, '60', undefined, MAX_TIMER_SECONDS + 1]) {
      expect(parses({ t: 'timer', seconds })).toBe(false)
    }

    const item = { title: 't', minutes: 1 }
    expect(parses({ t: 'agenda', items: [] })).toBe(true)
    expect(parses({ t: 'agenda', items: Array(MAX_AGENDA_ITEMS).fill(item) })).toBe(true)
    expect(parses({ t: 'agenda', items: Array(MAX_AGENDA_ITEMS + 1).fill(item) })).toBe(false)
    expect(parses({ t: 'agenda', items: 'x' })).toBe(false)
    expect(parses({ t: 'agenda', items: [{ ...item, title: '' }] })).toBe(false)
    expect(
      parses({ t: 'agenda', items: [{ ...item, title: 't'.repeat(MAX_AGENDA_TITLE_CHARS + 1) }] }),
    ).toBe(false)
    for (const minutes of [0, 1.5, '5', MAX_AGENDA_MINUTES + 1]) {
      expect(parses({ t: 'agenda', items: [{ ...item, minutes }] })).toBe(false)
    }
    expect(parses({ t: 'agendaCurrent', index: -1 })).toBe(false)
    expect(parses({ t: 'agendaCurrent', index: 0 })).toBe(true)
  })

  it('a malformed message is answered bad_message, and changes nothing', () => {
    const { t, alice } = room()
    t.send(alice, { ...POLL, options: [] })
    expect(alice.client.errors).toEqual(['bad_message'])
    expect(alice.client.view!.poll).toBeNull()
  })
})

describe('a persistent room’s settings (e1-t18)', () => {
  it('are there with their defaults, and a random room has none to change', async () => {
    const t = setup({ persistent: true })
    expect(t.host.settings()).toMatchObject({
      waitingRoom: false,
      startMuted: false,
      allowAnnotation: true,
      allowRecording: true,
    })
    const random = setup()
    expect(await random.host.updateSettings({ startMuted: true })).toBeNull()
  })

  it('a room stored before L5 reads as the defaults', () => {
    const t = setup({ persistent: true })
    const { startMuted: _a, allowAnnotation: _b, allowRecording: _c, ...old } = t.disk.info!
    t.disk.info = old as RoomInfo
    t.evict()
    expect(t.host.settings()).toMatchObject({
      startMuted: false,
      allowAnnotation: true,
      allowRecording: true,
    })
  })

  it('stay across an eviction and between meetings', async () => {
    const t = setup({ persistent: true })
    await t.host.updateSettings({ startMuted: true, allowAnnotation: false, allowRecording: false })
    t.evict()
    const expected = { startMuted: true, allowAnnotation: false, allowRecording: false }
    expect(t.host.settings()).toMatchObject(expected)
    const owner = t.join('Gene', { account: OWNER })
    t.send(owner, { t: 'host', action: 'endMeeting' })
    expect(t.host.settings()).toMatchObject(expected)
    expect(t.host.summary()!.annotationPolicy).toBe('off')
  })

  describe('default waiting room', () => {
    it('someone new waits; the owner does not', async () => {
      const t = setup({ persistent: true })
      await t.host.updateSettings({ waitingRoom: true })
      const owner = t.join('Gene', { account: OWNER })
      expect(owner.client.of('welcome')).toHaveLength(1)
      const guest = t.join('Guest')
      expect(guest.client.of('lobby')).toHaveLength(1)
      expect(guest.client.of('welcome')).toHaveLength(0)
    })
  })

  describe('start muted', () => {
    it('a participant is told once, after the welcome; the owner is not', async () => {
      const t = setup({ persistent: true })
      await t.host.updateSettings({ startMuted: true })
      const owner = t.join('Gene', { account: OWNER })
      const guest = t.join('Guest')
      expect(owner.client.notices).toEqual([])
      expect(guest.client.notices).toEqual(['startMuted'])
      const welcomeAt = guest.client.received.findIndex((m) => m.t === 'welcome')
      const noticeAt = guest.client.received.findIndex((m) => m.t === 'notice')
      expect(noticeAt).toBeGreaterThan(welcomeAt)
      // Coming back keeps the microphone as they left it
      t.drop(guest)
      const back = t.join('Guest', { token: guest.token })
      expect(back.id).toBe(guest.id)
      expect(back.client.notices).toEqual([])
    })

    it('someone admitted from the waiting room is told when they come in, not while waiting', async () => {
      const t = setup({ persistent: true })
      await t.host.updateSettings({ startMuted: true, waitingRoom: true })
      const owner = t.join('Gene', { account: OWNER })
      const guest = t.join('Guest')
      expect(guest.client.notices).toEqual([])
      t.send(owner, { t: 'host', action: 'admit', memberId: guest.client.of('lobby')[0].you })
      expect(guest.client.notices).toEqual(['startMuted'])
    })

    it('off: nobody is told', () => {
      const t = setup({ persistent: true })
      t.join('Gene', { account: OWNER })
      expect(t.join('Guest').client.notices).toEqual([])
    })
  })

  describe('allow annotation', () => {
    it('off: the policy is off at once and stays off; the host cannot turn it on in the room', async () => {
      const t = setup({ persistent: true })
      const owner = t.join('Gene', { account: OWNER })
      await t.host.updateSettings({ allowAnnotation: false })
      expect(owner.client.view!.room.annotationPolicy).toBe('off')
      t.send(owner, { t: 'host', action: 'annotationPolicy', policy: 'everyone' })
      expect(owner.client.errors).toEqual(['forbidden'])
      expect(owner.client.view!.room.annotationPolicy).toBe('off')
      // On again: as a meeting starts
      await t.host.updateSettings({ allowAnnotation: true })
      expect(owner.client.view!.room.annotationPolicy).toBe('everyone')
      t.send(owner, { t: 'host', action: 'annotationPolicy', policy: 'sharer' })
      expect(owner.client.view!.room.annotationPolicy).toBe('sharer')
    })

    it('on: the policy the host chose lasts the meeting, and the next starts over', () => {
      const t = setup({ persistent: true })
      const owner = t.join('Gene', { account: OWNER })
      t.send(owner, { t: 'host', action: 'annotationPolicy', policy: 'sharer' })
      t.send(owner, { t: 'host', action: 'endMeeting' })
      expect(t.host.summary()!.annotationPolicy).toBe('everyone')
    })
  })

  describe('allow recording (CLAUDE.md rule 4)', () => {
    it('off: nobody may start, the host neither', async () => {
      const t = setup({ persistent: true })
      const owner = t.join('Gene', { account: OWNER })
      const guest = t.join('Guest')
      t.send(owner, { t: 'host', action: 'allowRecord', memberId: guest.id, on: true })
      await t.host.updateSettings({ allowRecording: false })
      t.send(owner, { t: 'record', on: true })
      t.send(guest, { t: 'record', on: true })
      expect(owner.client.errors).toEqual(['forbidden'])
      expect(guest.client.errors).toEqual(['forbidden'])
      expect(owner.client.view!.room.recordings).toEqual({})
    })

    it('a recording under way stays visible and can be stopped when it is turned off', async () => {
      const t = setup({ persistent: true })
      const owner = t.join('Gene', { account: OWNER })
      t.send(owner, { t: 'record', on: true })
      await t.host.updateSettings({ allowRecording: false })
      expect(owner.client.view!.room.recordings[owner.id]).toBeDefined()
      t.send(owner, { t: 'record', on: false })
      expect(owner.client.view!.room.recordings).toEqual({})
    })

    it('on grants nothing: a participant still may not, and everyone must still agree', async () => {
      const t = setup({ persistent: true })
      await t.host.updateSettings({ allowRecording: true })
      const owner = t.join('Gene', { account: OWNER })
      const guest = t.join('Guest')
      t.send(guest, { t: 'record', on: true })
      expect(guest.client.errors).toEqual(['forbidden'])
      expect(owner.client.view!.room.recordings).toEqual({})
      // The host records: Guest is not counted as agreeing, and is removed if they never do
      t.send(owner, { t: 'record', on: true })
      expect(owner.client.view!.room.recordings[owner.id].consented).toEqual([])
      // Their sockets stay alive meanwhile: only the time to agree runs out
      for (const ms of [CONSENT_TIMEOUT_MS / 2, CONSENT_TIMEOUT_MS / 2 + 1]) {
        t.tick(ms)
        void t.host.message(owner.conn, 'ping')
        void t.host.message(guest.conn, 'ping')
      }
      t.host.alarm()
      expect(owner.client.view!.members[guest.id]).toBeUndefined()
    })
  })
})
