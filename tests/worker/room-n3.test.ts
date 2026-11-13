// N3 (e9-t04 consent, e9-t05 the event channel): remote control in the RoomDO. The threat model's
// tests (docs/PRD/f-remote-control-security.md §8) that live in the room:
// - T-02 the socket kinds for the control messages (a browser cannot answer, an agent cannot ask);
// - T-03 a grant only ever comes from the agent's `controlAnswer` (random browser traffic never
//   makes one, nor a forwarded batch);
// - T-05 the room's half of the time limits (allow10 ends at 10 minutes, an unanswered request is a
//   deny at 60 seconds);
// - T-06 seq handling in the room (stale, gap, too far: `desynced`; a dropped batch does not move
//   `last`; over the rate only up events go);
// - T-07 only the socket holding the grant gets through, and the per-socket limit exempts only it;
// - T-08 the grant is bound to the socket (a reconnect with the same token ends it);
// - T-09 the request limits (rate, cooldown, busy, per-agent deny limit across new members, mute,
//   the room switch);
// - T-15 every row of the revocation table (§5.7) and every request ending;
// - T-18 nothing typed or clicked reaches storage;
// - T-21 breakout rooms (a request across rooms is refused, a move apart ends it).
import { describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import { SOCKET_MESSAGE_RATE } from '../../shared/abuse.ts'
import {
  AGENT_PROTOCOL_VERSION,
  CONTROL_AGENT_MUTE_MS,
  CONTROL_DENY_COOLDOWN_MS,
  CONTROL_EVENT_RATE,
  CONTROL_FRAME_RATE,
  CONTROL_GRANT_MS,
  CONTROL_REQUEST_TTL_MS,
  MAX_CONTROL_SEQ_GAP,
  type AgentServerMessage,
  type ControlEvent,
} from '../../shared/control.ts'
import {
  CloseCode,
  PROTOCOL_VERSION,
  viewAsJson,
  type PairCodeMessage,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import type { BreakoutState } from '../../worker/room-breakout.ts'
import type { ControlState } from '../../worker/room-control.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'
import type { PairingState } from '../../worker/room-pairing.ts'
import type { Schedule } from '../../worker/scheduler.ts'

const V = String(PROTOCOL_VERSION)
const AV = String(AGENT_PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

type Received = ServerMessage | PairCodeMessage | AgentServerMessage

class FakeClient {
  received: Received[] = []
  view: RoomView | null = null
  closed: { code: number; reason: string } | null = null

  receive(message: Received) {
    this.received.push(message)
    if (message.t === 'welcome' || message.t === 'snapshot') this.view = message.state
    else if (message.t === 'patch') {
      this.view = applyPatch(viewAsJson(this.view!), message.ops) as RoomView
    }
  }

  of<T extends Received['t']>(t: T): Extract<Received, { t: T }>[] {
    return this.received.filter((m): m is Extract<Received, { t: T }> => m.t === t)
  }

  get errors(): string[] {
    return this.of('error').map((message) => message.code)
  }

  forget() {
    this.received = []
  }
}

type Who = { conn: string; client: FakeClient; id: string; token: string }

const HELLO = { device: '客廳的筆電', platform: 'windows', build: '0.1.0' } as const

function setup(options: { persistent?: boolean } = {}) {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  let nextIp = 0
  const clients = new Map<string, FakeClient>()
  const kinds = new Map<string, { agent: boolean; ip: string | null }>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    schedule: null as Schedule | null,
    breakout: null as BreakoutState | null,
    pairing: null as PairingState | null,
    control: null as ControlState | null,
    /** Every value ever written, as JSON: what storage saw (T-18) */
    writes: [] as string[],
  }
  const deliver = (conn: string, message: Received) => {
    const client = clients.get(conn)
    if (client && !client.closed) client.receive(structuredClone(message))
  }
  const write = <T>(value: T): T => {
    disk.writes.push(JSON.stringify(value))
    return structuredClone(value)
  }
  const makeHost = () =>
    new RoomHost({
      sockets: {
        send: deliver,
        post: deliver,
        close: (conn, code, reason) => {
          const client = clients.get(conn)
          if (client && !client.closed) client.closed = { code, reason }
        },
      },
      storage: {
        saveRoom: (info) => void (disk.info = write(info)),
        saveRev: (rev) => void (disk.rev = rev),
        saveSessions: (sessions) => void (disk.sessions = write(sessions)),
        saveUsage: () => {},
        saveSchedule: (schedule) => void (disk.schedule = write(schedule)),
        saveChat: (message) => void write(message),
        dropChat: () => {},
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        savePersistent: () => {},
        saveBreakout: (state) => void (disk.breakout = write(state)),
        savePairing: (state) => void (disk.pairing = write(state)),
        saveControl: (state) => void (disk.control = write(state)),
        clear: () => {
          disk.info = null
          disk.breakout = null
          disk.pairing = null
          disk.control = null
          disk.schedule = null
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = makeHost()
  if (options.persistent) {
    host.createPersistent({ slug: ROOM.id, owner: 'acc', createdAt: 1 }, '週會')
  } else {
    host.create(ROOM)
  }

  function open(agent: boolean, ip: string | null): { conn: string; client: FakeClient } {
    expect(host.admit(agent ? AV : V, ip, agent)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    kinds.set(conn, { agent, ip })
    host.opened(conn, ip, null, agent)
    return { conn, client }
  }

  const send = (who: { conn: string }, message: object | string) =>
    host.message(who.conn, typeof message === 'string' ? message : JSON.stringify(message))

  function join(name: string, token: string | null = null): Who {
    const { conn, client } = open(false, `10.0.0.${++nextIp}`)
    void send({ conn }, { t: 'join', name, token, client: null })
    const welcome = client.of('welcome')[0]
    return { conn, client, id: welcome?.you ?? '', token: welcome?.token ?? '' }
  }

  /** `owner` pairs a computer, which confirms and shares its screen */
  function pair(owner: Who, share = true): Who {
    void send(owner, { t: 'pairStart' })
    const code = owner.client.of('pairCode').at(-1)!.code!
    const { conn, client } = open(true, `20.0.0.${++nextIp}`)
    void send({ conn }, { t: 'agentHello', pairing: code, token: null, ...HELLO })
    const welcome = client.of('agentWelcome')[0]
    const agent = { conn, client, id: welcome.memberId, token: welcome.token }
    if (share) void send(agent, { t: 'share' })
    return agent
  }

  /** `who` asks to control `agent`; the request id the agent was asked with */
  function ask(who: Who, agent: Who): string {
    void send(who, { t: 'controlRequest', agent: agent.id })
    return agent.client.of('controlAsk').at(-1)!.request
  }

  /** `who` asks and `agent` allows; the grant id */
  function grant(who: Who, agent: Who, decision: 'allow10' | 'allowUntilStop' = 'allow10'): string {
    const request = ask(who, agent)
    void send(agent, { t: 'controlAnswer', request, decision })
    return who.client.of('controlGranted').at(-1)!.grant
  }

  return {
    get host() {
      return host
    },
    disk,
    join,
    pair,
    ask,
    grant,
    send,
    evict() {
      host = makeHost()
      const sockets = [...clients]
        .filter(([, client]) => !client.closed)
        .map(([conn]) => ({ conn, openedAt: clock, ...kinds.get(conn)! }))
      host.restore(disk.info, disk.rev, disk.sessions, sockets, null, disk.schedule, [], [], {
        breakout: disk.breakout,
        pairing: disk.pairing,
        control: disk.control,
      })
    },
    drop: (who: { conn: string }) => {
      host.closed(who.conn)
      clients.get(who.conn)!.closed = { code: 1006, reason: 'dropped' }
    },
    tick: (ms: number) => void (clock += ms),
    /** Moves the clock to `at` (or the next alarm) and fires the alarm */
    alarm(at: number | null = null) {
      const next = at ?? host.nextAlarm()
      expect(next).not.toBeNull()
      clock = Math.max(clock, next!)
      for (const [conn, client] of clients) if (!client.closed) host.heartbeat(conn, clock)
      host.alarm()
    },
    get clock() {
      return clock
    },
  }
}

const move = (x: number, y: number): ControlEvent => ({ type: 'move', x, y })
const key = (code: string, down: boolean): ControlEvent => ({ type: 'key', code, down, mods: 0 })
const batch = (grant: string, seq: number, events: ControlEvent[] = [move(0.5, 0.5)]) => ({
  t: 'controlEvent',
  grant,
  seq,
  events,
})

describe('asking (e9-t04, §5.2)', () => {
  it('shows the request to everyone, asks the agent and tells the requester its id', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    t.send(alice, { t: 'renameRoom', name: '週五讀書會' })
    const pc = t.pair(alice)
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    const ask = pc.client.of('controlAsk')
    expect(ask).toEqual([
      {
        t: 'controlAsk',
        request: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        from: { id: bob.id, name: 'Bob' },
        roomName: '週五讀書會',
        createdBy: 'Alice',
        ttlMs: CONTROL_REQUEST_TTL_MS,
      },
    ])
    expect(bob.client.of('controlRequested')).toEqual([
      { t: 'controlRequested', request: ask[0].request, agent: pc.id },
    ])
    expect(carol.client.view!.control).toEqual({
      [pc.id]: {
        agent: pc.id,
        controller: bob.id,
        phase: 'asking',
        since: t.clock,
        until: t.clock + CONTROL_REQUEST_TTL_MS,
      },
    })
    // The request id stays with the requester and the agent
    expect(JSON.stringify(carol.client.received)).not.toContain(ask[0].request)
    // A rename while asking does not change what the dialog shows
    t.send(bob, { t: 'rename', name: '媽媽' })
    expect(pc.client.of('controlAsk')).toHaveLength(1)
  })

  it('refuses an agent that does not share its screen, a person, oneself and a waiting member', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice, false)
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    void t.send(bob, { t: 'controlRequest', agent: alice.id })
    void t.send(bob, { t: 'controlRequest', agent: bob.id })
    void t.send(bob, { t: 'controlRequest', agent: 'nobody' })
    expect(bob.client.errors).toEqual([
      'control_not_agent',
      'control_not_agent',
      'control_not_agent',
      'control_not_agent',
    ])
    expect(pc.client.of('controlAsk')).toEqual([])
    expect(bob.client.view!.control).toBeNull()
  })

  it('refuses a request across breakout rooms (T-21)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    void t.send(alice, {
      t: 'breakoutOpen',
      groups: ['一', '二'],
      assign: { [alice.id]: 0, [bob.id]: 1 },
      minutes: null,
    })
    const pc = t.pair(alice)
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    expect(bob.client.errors).toEqual(['control_separated'])
  })

  it('takes one request or grant per agent and per requester (control_busy)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const pc2 = t.pair(carol)
    t.ask(bob, pc)
    void t.send(carol, { t: 'controlRequest', agent: pc.id })
    void t.send(bob, { t: 'controlRequest', agent: pc2.id })
    expect(carol.client.errors).toEqual(['control_busy'])
    expect(bob.client.errors).toEqual(['control_busy'])
    expect(pc2.client.of('controlAsk')).toEqual([])
  })

  it('limits each member to 3 requests a minute and 30 seconds after a deny (T-09)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    let request = t.ask(bob, pc)
    void t.send(pc, { t: 'controlAnswer', request, decision: 'deny' })
    expect(bob.client.of('controlRefused').at(-1)).toEqual({
      t: 'controlRefused',
      request,
      reason: 'denied',
    })
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    expect(bob.client.errors).toEqual(['control_cooldown'])
    t.tick(CONTROL_DENY_COOLDOWN_MS)
    request = t.ask(bob, pc)
    void t.send(bob, { t: 'controlCancel', request })
    request = t.ask(bob, pc)
    void t.send(bob, { t: 'controlCancel', request })
    // The fourth within the minute
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    expect(bob.client.errors).toEqual(['control_cooldown', 'control_cooldown'])
    t.tick(60_000)
    t.ask(bob, pc)
    expect(bob.client.errors).toHaveLength(2)
  })

  it('mutes an agent after 3 denies in 5 minutes, whoever asks, new members included (T-09)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    for (let i = 0; i < 3; i++) {
      // Rejoining makes a new member each time: the per-member limits alone would not stop it
      const asker = t.join(`Mallory${i}`)
      const request = t.ask(asker, pc)
      void t.send(pc, { t: 'controlAnswer', request, decision: 'deny' })
    }
    const another = t.join('Mallory3')
    void t.send(another, { t: 'controlRequest', agent: pc.id })
    expect(another.client.errors).toEqual(['control_muted'])
    t.tick(CONTROL_AGENT_MUTE_MS)
    t.ask(another, pc)
    expect(another.client.errors).toEqual(['control_muted'])
    expect(pc.client.of('controlAsk')).toHaveLength(4)
  })

  it('counts a request nobody answered as a deny, after CONTROL_REQUEST_TTL_MS (T-05)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const request = t.ask(bob, pc)
    t.alarm(t.clock + CONTROL_REQUEST_TTL_MS - 1)
    expect(bob.client.view!.control![pc.id].phase).toBe('asking')
    t.alarm(t.clock + 1)
    expect(bob.client.view!.control).toBeNull()
    expect(bob.client.of('controlRefused')).toEqual([
      { t: 'controlRefused', request, reason: 'expired' },
    ])
    expect(pc.client.of('controlAskEnd')).toEqual([
      { t: 'controlAskEnd', request, reason: 'expired' },
    ])
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    expect(bob.client.errors).toEqual(['control_cooldown'])
  })

  it('lets the person at the computer stop requests for a while, and take them again (T-09)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const request = t.ask(bob, pc)
    // 拒絕 with 「不再接受請求 30 分鐘」 ticked
    void t.send(pc, { t: 'controlAnswer', request, decision: 'deny' })
    void t.send(pc, { t: 'controlMute', ms: 30 * 60_000 })
    t.tick(CONTROL_DENY_COOLDOWN_MS)
    void t.send(bob, { t: 'controlRequest', agent: pc.id })
    expect(bob.client.errors).toEqual(['control_muted'])
    // A length not offered is refused by the parser
    void t.send(pc, { t: 'controlMute', ms: 5 })
    expect(pc.client.errors).toEqual(['bad_message'])
    // From the tray: take requests again
    void t.send(pc, { t: 'controlMute', ms: 0 })
    t.ask(bob, pc)
    expect(bob.client.errors).toEqual(['control_muted'])
    // A mute while a request waits ends it
    void t.send(pc, { t: 'controlMute', ms: 10 * 60_000 })
    expect(bob.client.of('controlRefused').at(-1)!.reason).toBe('muted')
    expect(bob.client.view!.control).toBeNull()
  })

  it('refuses everything when the room turns remote control off, and ends what is on (Q4)', async () => {
    const t = setup({ persistent: true })
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const pc2 = t.pair(carol)
    const grant = t.grant(bob, pc)
    const request = t.ask(alice, pc2)
    const settings = await t.host.updateSettings({ allowControl: false })
    expect(settings?.allowControl).toBe(false)
    expect(bob.client.view!.room.allowControl).toBe(false)
    expect(bob.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'controlOff' }])
    expect(alice.client.of('controlRefused')).toEqual([
      { t: 'controlRefused', request, reason: 'controlOff' },
    ])
    expect(pc2.client.of('controlAskEnd')).toEqual([
      { t: 'controlAskEnd', request, reason: 'controlOff' },
    ])
    expect(bob.client.view!.control).toBeNull()
    void t.send(carol, { t: 'controlRequest', agent: pc.id })
    expect(carol.client.errors).toEqual(['control_off'])
    await t.host.updateSettings({ allowControl: true })
    t.ask(carol, pc)
    expect(carol.client.errors).toEqual(['control_off'])
  })

  it('takes requests only from members in the meeting (requestControl)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const waiting = t.join('Wendy')
    // Someone waiting has no welcome, only a lobby, and is refused
    void t.send(waiting, { t: 'controlRequest', agent: pc.id })
    expect(waiting.client.errors).toEqual(['forbidden'])
    expect(pc.client.of('controlAsk')).toEqual([])
  })
})

describe('consent (e9-t04, §5.3: a grant only from the agent)', () => {
  it('grants on allow: the controller gets the id, the agent the echo, everyone a notice', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const request = t.ask(bob, pc)
    void t.send(pc, { t: 'controlAnswer', request, decision: 'allow10' })
    const granted = bob.client.of('controlGranted')
    expect(granted).toEqual([
      {
        t: 'controlGranted',
        grant: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        agent: pc.id,
        until: t.clock + CONTROL_GRANT_MS.allow10,
      },
    ])
    expect(granted[0].grant).not.toBe(request)
    expect(pc.client.of('controlStart')).toEqual([
      {
        t: 'controlStart',
        request,
        grant: granted[0].grant,
        controller: { id: bob.id, name: 'Bob' },
        durationMs: CONTROL_GRANT_MS.allow10,
      },
    ])
    for (const who of [alice, bob, carol]) {
      expect(who.client.of('notice').at(-1)).toEqual({
        t: 'notice',
        notice: 'controlStarted',
        by: bob.id,
        agent: pc.id,
      })
      expect(who.client.view!.control).toEqual({
        [pc.id]: {
          agent: pc.id,
          controller: bob.id,
          phase: 'granted',
          since: t.clock,
          until: t.clock + CONTROL_GRANT_MS.allow10,
        },
      })
    }
    // Nobody but the controller learns the grant id
    expect(JSON.stringify(carol.client.received)).not.toContain(granted[0].grant)
  })

  it('grants until stopped, echoing null', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    t.grant(bob, pc, 'allowUntilStop')
    expect(bob.client.of('controlGranted')[0].until).toBeNull()
    expect(pc.client.of('controlStart')[0].durationMs).toBeNull()
    expect(t.host.nextAlarm()).not.toBe(null)
  })

  it('takes a controlAnswer only from that agent, for its own request (T-02, TH-02)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const other = t.pair(carol)
    const request = t.ask(bob, pc)
    // From a browser: the parse does not know it
    void t.send(bob, { t: 'controlAnswer', request, decision: 'allow10' })
    expect(bob.client.errors).toEqual(['bad_message'])
    // From another agent
    void t.send(other, { t: 'controlAnswer', request, decision: 'allow10' })
    // Of another id, or no decision this version knows ("always")
    void t.send(pc, { t: 'controlAnswer', request: 'A'.repeat(22), decision: 'allow10' })
    void t.send(pc, { t: 'controlAnswer', request, decision: 'always' })
    expect(pc.client.errors).toEqual(['bad_message'])
    expect(bob.client.of('controlGranted')).toEqual([])
    expect(bob.client.view!.control![pc.id].phase).toBe('asking')
    // An agent cannot ask, or send events, on its own socket
    void t.send(pc, { t: 'controlRequest', agent: other.id })
    void t.send(pc, batch('A'.repeat(22), 1))
    expect(pc.client.errors).toEqual(['bad_message', 'bad_message', 'bad_message'])
  })

  it('never grants, nor forwards, from any browser traffic without the agent (T-03)', () => {
    // A seeded generator: the same sequences every run
    let seed = 0x9e3779b9
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 2 ** 32
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
    for (let run = 0; run < 20; run++) {
      const t = setup()
      const people = [t.join('Alice'), t.join('Bob'), t.join('Carol')]
      const pc = t.pair(people[0])
      const ids = () => [
        pc.id,
        ...people.map((who) => who.id),
        ...people.flatMap((who) => who.client.of('controlRequested').map((m) => m.request)),
        'A'.repeat(22),
      ]
      const messages = (): object[] => [
        { t: 'controlRequest', agent: pick(ids()) },
        { t: 'controlCancel', request: pick(ids()) },
        { t: 'controlStop', grant: pick(ids()) },
        batch(pick(ids()), Math.ceil(random() * 5)),
        { t: 'controlAnswer', request: pick(ids()), decision: 'allow10' },
        { t: 'controlAnswer', request: pick(ids()), decision: 'allowUntilStop' },
        { t: 'controlStart', request: pick(ids()), grant: pick(ids()), durationMs: null },
        { t: 'host', action: pick(['stopControl', 'muteMember', 'remove']), memberId: pick(ids()) },
        { t: 'host', action: pick(['lock', 'waitingRoom']), on: random() < 0.5 },
        { t: 'share' },
        { t: 'unshare' },
        { t: 'agentHello', pairing: null, token: pc.token, ...HELLO },
      ]
      for (let i = 0; i < 60; i++) {
        const who = pick(people)
        if (who.client.closed) continue
        void t.send(who, pick(messages()))
        if (random() < 0.1) t.tick(Math.floor(random() * 30_000))
      }
      for (const who of people) {
        expect(who.client.of('controlGranted')).toEqual([])
        const control = who.client.view?.control ?? {}
        expect(Object.values(control).every((entry) => entry.phase === 'asking')).toBe(true)
      }
      expect(pc.client.of('controlStart')).toEqual([])
      expect(pc.client.of('controlForward')).toEqual([])
    }
  })
})

describe('the event channel (e9-t05, §5.5–§5.6)', () => {
  it('forwards the batches of the socket holding the grant, in order (T-06)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    void t.send(bob, batch(grant, 1, [move(0.1, 0.2), key('KeyA', true), key('KeyA', false)]))
    void t.send(bob, batch(grant, 2))
    // A replay and an old one: dropped, never reordered
    void t.send(bob, batch(grant, 2))
    void t.send(bob, batch(grant, 1))
    // A gap (the room dropped some): forwarded, the agent releases what it holds first
    void t.send(bob, batch(grant, 5))
    expect(pc.client.of('controlForward').map((m) => m.seq)).toEqual([1, 2, 5])
    expect(pc.client.of('controlForward')[0]).toEqual({
      t: 'controlForward',
      grant,
      seq: 1,
      events: [move(0.1, 0.2), key('KeyA', true), key('KeyA', false)],
    })
    // Too far ahead: the grant ends rather than stays stuck
    void t.send(bob, batch(grant, 5 + MAX_CONTROL_SEQ_GAP + 1))
    expect(bob.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'desynced' }])
    expect(pc.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'desynced' }])
    expect(pc.client.of('controlForward')).toHaveLength(3)
  })

  it('drops batches from anyone else, another tab of the same member, or an ended grant (T-07)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    void t.send(carol, batch(grant, 1))
    void t.send(alice, batch(grant, 1))
    void t.send(bob, batch('A'.repeat(22), 1))
    expect(pc.client.of('controlForward')).toEqual([])
    void t.send(bob, { t: 'controlStop', grant })
    void t.send(bob, batch(grant, 1))
    expect(pc.client.of('controlForward')).toEqual([])
    expect(bob.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant, reason: 'controllerStopped' },
    ])
  })

  it('forwards at most CONTROL_EVENT_RATE events a second: over it only the up events (T-06)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    const moves = Array.from({ length: 30 }, (_, i) => move(i / 30, 0.5))
    for (let seq = 1; seq <= CONTROL_EVENT_RATE.count / 30; seq++) {
      void t.send(bob, batch(grant, seq, moves))
    }
    const full = CONTROL_EVENT_RATE.count / 30
    // Over the rate: a batch with a key up keeps only it (and its seq)
    void t.send(bob, batch(grant, full + 1, [key('ShiftLeft', true), move(0.1, 0.1), key('ShiftLeft', false)]))
    // One with no up event is dropped and does not move `last`
    void t.send(bob, batch(grant, full + 2, [move(0.2, 0.2)]))
    const forwarded = pc.client.of('controlForward')
    expect(forwarded.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(forwarded.at(-1)!.events).toEqual([key('ShiftLeft', false)])
    // A second later: the next one is a gap from 5 (6 was dropped), and goes through
    t.tick(CONTROL_EVENT_RATE.windowMs)
    void t.send(bob, batch(grant, full + 3))
    expect(pc.client.of('controlForward').map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 7])
  })

  it('keeps the grant’s own batches out of the per-socket limit, nobody else’s (T-07, TH-32)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    // Far more than SOCKET_MESSAGE_RATE over 10 seconds, within CONTROL_FRAME_RATE each second
    let seq = 0
    for (let second = 0; second < 10; second++) {
      for (let i = 0; i < 30; i++) void t.send(bob, batch(grant, ++seq, [move(0.5, 0.5)]))
      t.tick(1_000)
    }
    expect(seq).toBeGreaterThan(SOCKET_MESSAGE_RATE.count)
    expect(bob.client.closed).toBeNull()
    expect(pc.client.of('controlForward')).toHaveLength(seq)
    // Junk labelled controlEvent from a socket with no grant counts, and floods it out
    for (let i = 0; i <= SOCKET_MESSAGE_RATE.count; i++) void t.send(carol, batch(grant, i + 1))
    expect(carol.client.closed?.code).toBe(CloseCode.rateLimited)
  })

  it('closes the grant’s socket past CONTROL_FRAME_RATE, which ends the grant (T-07)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    for (let seq = 1; seq <= CONTROL_FRAME_RATE.count + 1; seq++) void t.send(bob, batch(grant, seq))
    expect(bob.client.closed?.code).toBe(CloseCode.rateLimited)
    expect(pc.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant, reason: 'controllerLeft' },
    ])
    expect(alice.client.view!.control).toBeNull()
  })

  it('binds the grant to the socket: a reconnect with the same token ends it (T-08, TH-03)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    // The token joins from another socket (a reload, or someone who stole it)
    const again = t.join('Bob', bob.token)
    expect(again.id).toBe(bob.id)
    expect(bob.client.closed?.code).toBe(CloseCode.replaced)
    expect(pc.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant, reason: 'controllerLeft' },
    ])
    expect(again.client.view!.control).toBeNull()
    // The same grant id from the new socket goes nowhere
    void t.send(again, batch(grant, 1))
    expect(pc.client.of('controlForward')).toEqual([])
    // A new request, a new consent
    const next = t.grant(again, pc)
    expect(next).not.toBe(grant)
  })

  it('stores nothing that was typed or clicked (T-18, D11)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    void t.send(bob, batch(grant, 1, [{ type: 'text', text: '我的密碼Hunter2' }, key('KeyQ', true)]))
    void t.send(bob, batch(grant, 2, [key('KeyQ', false), move(0.123456, 0.654321)]))
    void t.send(bob, { t: 'controlStop', grant })
    const stored = t.disk.writes.join('\n')
    for (const secret of ['Hunter2', '密碼', 'KeyQ', '0.123456', 'controlForward']) {
      expect(stored).not.toContain(secret)
    }
    expect(pc.client.of('controlForward')).toHaveLength(2)
  })

  it('survives an eviction: the grant, its sockets and its seq (within the save delay)', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    void t.send(bob, batch(grant, 1))
    t.evict()
    expect(t.host.view().control?.[pc.id].phase).toBe('granted')
    // The last seq was not stored yet (no timer in this harness): the next batch is a gap
    void t.send(bob, batch(grant, 2))
    void t.send(bob, batch(grant, 2))
    expect(pc.client.of('controlForward').map((m) => m.seq)).toEqual([1, 2])
  })
})

describe('every way control ends (T-15, §5.7)', () => {
  function controlled() {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    const grant = t.grant(bob, pc)
    const ended = (reason: string) => {
      expect(pc.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason }])
      expect(carol.client.of('notice').at(-1)).toEqual({
        t: 'notice',
        notice: 'controlEnded',
        by: bob.id,
        agent: pc.id,
        reason,
      })
      expect(carol.client.view!.control ?? null).toBeNull()
    }
    return { t, alice, bob, carol, pc, grant, ended }
  }

  it('expired: allow10 ends at 10 minutes (T-05)', () => {
    const { t, bob, grant, ended } = controlled()
    t.alarm(t.clock + CONTROL_GRANT_MS.allow10 - 1)
    expect(bob.client.of('controlEnd')).toEqual([])
    t.alarm(t.clock + 1)
    expect(bob.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'expired' }])
    ended('expired')
  })

  it('controllerStopped and agentStopped', () => {
    const a = controlled()
    void a.t.send(a.bob, { t: 'controlStop', grant: a.grant })
    a.ended('controllerStopped')
    const b = controlled()
    // Only the controlling agent's own socket, with the reason the person used
    void b.t.send(b.carol, { t: 'controlStop', grant: b.grant, reason: 'button' })
    void b.t.send(b.pc, { t: 'controlStop', grant: b.grant, reason: 'escape' })
    expect(b.bob.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant: b.grant, reason: 'agentStopped' },
    ])
    b.ended('agentStopped')
  })

  it('controllerLeft: leaving, dropping (no resume), being removed', () => {
    const a = controlled()
    void a.t.send(a.bob, { t: 'leave' })
    a.ended('controllerLeft')
    const b = controlled()
    b.t.drop(b.bob)
    b.ended('controllerLeft')
    const c = controlled()
    void c.t.send(c.alice, { t: 'host', action: 'remove', memberId: c.bob.id })
    c.ended('controllerLeft')
  })

  it('agentLeft: the agent leaving, dropping, or its owner pressing 「這不是我」', () => {
    const a = controlled()
    void a.t.send(a.pc, { t: 'leave' })
    expect(a.bob.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant: a.grant, reason: 'agentLeft' },
    ])
    const b = controlled()
    b.t.drop(b.pc)
    expect(b.bob.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant: b.grant, reason: 'agentLeft' },
    ])
    const c = controlled()
    void c.t.send(c.alice, { t: 'agentRemove', memberId: c.pc.id })
    expect(c.bob.client.of('controlEnd')).toEqual([
      { t: 'controlEnd', grant: c.grant, reason: 'agentLeft' },
    ])
    expect(c.carol.client.view!.control).toBeNull()
  })

  it('hostStopped: a host or co-host, never a participant (stopControl)', () => {
    const { t, alice, bob, carol, pc, ended } = controlled()
    void t.send(carol, { t: 'host', action: 'stopControl', memberId: pc.id })
    expect(carol.client.errors).toEqual(['forbidden'])
    expect(bob.client.view!.control![pc.id].phase).toBe('granted')
    void t.send(alice, { t: 'host', action: 'stopControl', memberId: pc.id })
    ended('hostStopped')
  })

  it('separated: a breakout move puts the two in different rooms (T-21)', () => {
    const { t, alice, bob, ended } = controlled()
    void t.send(alice, {
      t: 'breakoutOpen',
      groups: ['一'],
      assign: { [bob.id]: 0 },
      minutes: null,
    })
    ended('separated')
  })

  it('meetingEnded: both told before their sockets close', () => {
    const { t, alice, bob, pc, grant } = controlled()
    void t.send(alice, { t: 'host', action: 'endMeeting' })
    expect(bob.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'meetingEnded' }])
    expect(pc.client.of('controlEnd')).toEqual([{ t: 'controlEnd', grant, reason: 'meetingEnded' }])
    expect(pc.client.closed?.code).toBe(CloseCode.ended)
  })

  it('ends a request for every reason: cancelled, requesterLeft, agentLeft, separated', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(alice)
    let request = t.ask(bob, pc)
    // Only the requester cancels
    void t.send(carol, { t: 'controlCancel', request })
    expect(pc.client.of('controlAskEnd')).toEqual([])
    void t.send(bob, { t: 'controlCancel', request })
    expect(pc.client.of('controlAskEnd').at(-1)).toEqual({
      t: 'controlAskEnd',
      request,
      reason: 'cancelled',
    })
    request = t.ask(carol, pc)
    t.drop(carol)
    expect(pc.client.of('controlAskEnd').at(-1)).toEqual({
      t: 'controlAskEnd',
      request,
      reason: 'requesterLeft',
    })
    t.tick(CONTROL_DENY_COOLDOWN_MS)
    request = t.ask(bob, pc)
    void t.send(alice, {
      t: 'breakoutOpen',
      groups: ['一'],
      assign: { [bob.id]: 0 },
      minutes: null,
    })
    expect(bob.client.of('controlRefused').at(-1)).toEqual({
      t: 'controlRefused',
      request,
      reason: 'separated',
    })
    void t.send(alice, { t: 'breakoutClose', now: true })
    request = t.ask(bob, pc)
    void t.send(pc, { t: 'leave' })
    expect(bob.client.of('controlRefused').at(-1)).toEqual({
      t: 'controlRefused',
      request,
      reason: 'agentLeft',
    })
    expect(bob.client.view!.control).toBeNull()
  })
})
