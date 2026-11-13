// N2 (e9-t02, part of e9-t03): pairing a desktop agent in the RoomDO, and the agent's own socket.
// The threat model's T-01 (docs/PRD/f-remote-control-security.md §8: one-time codes, 5 minutes, a
// wrong code closes the socket, 5 wrong per network in 10 minutes, 50 room-wide void every code and
// tell the issuers, one computer per member, the owner told and able to remove it) and T-02 (an
// agent socket takes agent messages only, a browser socket never; an agent token does not open /ws,
// a session token does not open /agent). Also: the agent shares its screen through the same SFU
// proxy with its own token, comes back with its token within the grace, survives an eviction, counts
// toward MAX_MEMBERS, lands in its owner's breakout room and stays when its owner leaves.
import { describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  AGENT_PROTOCOL_VERSION,
  PAIRING_CODE_TTL_MS,
  PAIRING_NETWORK_FAIL_RATE,
  PAIRING_ROOM_MAX_FAILS,
  type AgentServerMessage,
} from '../../shared/control.ts'
import {
  CloseCode,
  EMPTY_ROOM_TTL_MS,
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  viewAsJson,
  type PairCodeMessage,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import type { BreakoutState } from '../../worker/room-breakout.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'
import type { PairingState } from '../../worker/room-pairing.ts'
import type { Schedule } from '../../worker/scheduler.ts'
import { handleRequest, type Env } from '../../worker/app.ts'

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

  get notices(): string[] {
    return this.of('notice').map((message) => message.notice)
  }

  /** The last `pairCode` this member got */
  get code(): PairCodeMessage | undefined {
    return this.of('pairCode').at(-1)
  }

  forget() {
    this.received = []
  }
}

type Who = { conn: string; client: FakeClient; id: string; token: string }

const HELLO = { device: '客廳的筆電', platform: 'windows', build: '0.1.0' } as const

/** A code of the right shape that is not `code` */
const wrongCode = (code: string) => (code[0] === 'A' ? 'B' : 'A') + code.slice(1)

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  /** Every socket ever opened, closed or not, with its kind (so an eviction keeps the tags) */
  const kinds = new Map<string, { agent: boolean; ip: string | null }>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    schedule: null as Schedule | null,
    breakout: null as BreakoutState | null,
    pairing: null as PairingState | null,
  }
  const deliver = (conn: string, message: Received) => {
    const client = clients.get(conn)
    if (client && !client.closed) client.receive(structuredClone(message))
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
        saveRoom: (info) => void (disk.info = structuredClone(info)),
        saveRev: (rev) => void (disk.rev = rev),
        saveSessions: (sessions) => void (disk.sessions = structuredClone(sessions)),
        saveUsage: () => {},
        saveSchedule: (schedule) => void (disk.schedule = structuredClone(schedule)),
        saveChat: () => {},
        dropChat: () => {},
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        saveBreakout: (state) => void (disk.breakout = structuredClone(state)),
        savePairing: (state) => void (disk.pairing = structuredClone(state)),
        clear: () => {
          disk.info = null
          disk.breakout = null
          disk.pairing = null
          disk.schedule = null
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = makeHost()
  host.create(ROOM)

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

  function join(name: string, token: string | null = null, ip: string | null = null): Who {
    const { conn, client } = open(false, ip)
    void send({ conn }, { t: 'join', name, token, client: null })
    const welcome = client.of('welcome')[0]
    return { conn, client, id: welcome?.you ?? '', token: welcome?.token ?? '' }
  }

  /** A desktop agent's socket saying hello with a pairing code or a token */
  function agent(
    hello: { pairing?: string | null; token?: string | null },
    ip: string | null = '1.1.1.1',
    device: string = HELLO.device,
  ): Who {
    const { conn, client } = open(true, ip)
    void send(
      { conn },
      {
        t: 'agentHello',
        pairing: hello.pairing ?? null,
        token: hello.token ?? null,
        ...HELLO,
        device,
      },
    )
    const welcome = client.of('agentWelcome')[0]
    return { conn, client, id: welcome?.memberId ?? '', token: welcome?.token ?? '' }
  }

  /** `owner` asks for a code and an agent brings it */
  function pair(owner: Who, ip: string | null = '1.1.1.1'): Who {
    void send(owner, { t: 'pairStart' })
    const code = owner.client.code?.code
    expect(code).toBeTruthy()
    return agent({ pairing: code! }, ip)
  }

  return {
    get host() {
      return host
    },
    disk,
    join,
    agent,
    pair,
    send,
    open,
    /** The object is evicted and comes back from what it stored, every open socket still open */
    evict() {
      host = makeHost()
      const sockets = [...clients]
        .filter(([, client]) => !client.closed)
        .map(([conn]) => ({ conn, openedAt: clock, ...kinds.get(conn)! }))
      host.restore(disk.info, disk.rev, disk.sessions, sockets, null, disk.schedule, [], [], {
        breakout: disk.breakout,
        pairing: disk.pairing,
      })
    },
    drop: (who: { conn: string }) => {
      host.closed(who.conn)
      clients.get(who.conn)!.closed = { code: 1006, reason: 'dropped' }
    },
    tick: (ms: number) => void (clock += ms),
    /** Moves the clock to the next alarm and fires it; every open socket is heard from meanwhile */
    alarm() {
      const at = host.nextAlarm()
      expect(at).not.toBeNull()
      clock = Math.max(clock, at!)
      for (const [conn, client] of clients) if (!client.closed) host.heartbeat(conn, clock)
      host.alarm()
    },
    get clock() {
      return clock
    },
  }
}

describe('pairing codes (T-01)', () => {
  it('gives the member who asked a one-time code, to them alone, for PAIRING_CODE_TTL_MS', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!
    expect(code.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(code.expiresAt).toBe(t.clock + PAIRING_CODE_TTL_MS)
    expect(bob.client.of('pairCode')).toEqual([])
    // Nobody sees it in the room's view either
    expect(JSON.stringify(bob.client.view)).not.toContain(code.code!)
  })

  it("makes the agent bringing it its owner's computer, and tells the owner", () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    t.send(alice, { t: 'renameRoom', name: '週五讀書會' })
    const pc = t.pair(alice)
    expect(pc.id).not.toBe('')
    expect(pc.client.closed).toBeNull()
    expect(pc.client.of('agentWelcome')).toEqual([
      {
        t: 'agentWelcome',
        memberId: pc.id,
        token: pc.token,
        owner: alice.id,
        ownerName: 'Alice',
        roomName: '週五讀書會',
        createdBy: 'Alice',
      },
    ])
    // A member of its own, a participant named after the computer
    expect(bob.client.view!.members[pc.id]).toMatchObject({
      name: HELLO.device,
      role: 'participant',
      reconnecting: false,
      agent: { owner: alice.id, device: HELLO.device, platform: 'windows' },
    })
    // The owner: the code is used up, and 「『客廳的筆電』已連成你的電腦」 with 「這不是我」
    expect(alice.client.code).toEqual({ t: 'pairCode', code: null, expiresAt: null })
    expect(alice.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'agentPaired',
      by: pc.id,
    })
    expect(bob.client.notices).not.toContain('agentPaired')
  })

  it('is used once', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    expect(t.agent({ pairing: code }).id).not.toBe('')
    const again = t.agent({ pairing: code }, '2.2.2.2')
    expect(again.id).toBe('')
    expect(again.client.closed?.code).toBe(CloseCode.passwordWrong)
  })

  it('takes the code as typed: any case, a hyphen, O for 0', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace(/0/g, 'o')
    expect(t.agent({ pairing: typed }).id).not.toBe('')
  })

  it("replaces the member's code with a new pairStart, and pairCancel voids it", () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const first = alice.client.code!.code!
    void t.send(alice, { t: 'pairStart' })
    const second = alice.client.code!.code!
    expect(second).not.toBe(first)
    expect(t.agent({ pairing: first }).client.closed?.code).toBe(CloseCode.passwordWrong)
    void t.send(alice, { t: 'pairCancel' })
    expect(alice.client.code).toEqual({ t: 'pairCode', code: null, expiresAt: null })
    expect(t.agent({ pairing: second }, '2.2.2.2').client.closed?.code).toBe(
      CloseCode.passwordWrong,
    )
    expect(t.disk.pairing?.codes ?? []).toEqual([])
  })

  it('runs out after PAIRING_CODE_TTL_MS: the owner is told, and the code no longer pairs', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!
    // The room's alarm is set for it
    expect(t.host.nextAlarm()).toBeLessThanOrEqual(code.expiresAt!)
    while (t.clock < code.expiresAt!) t.alarm()
    expect(alice.client.code).toEqual({ t: 'pairCode', code: null, expiresAt: null })
    expect(t.agent({ pairing: code.code! }).client.closed?.code).toBe(CloseCode.passwordWrong)
  })

  it('does not pair with a code past its time even before the alarm comes', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    t.tick(PAIRING_CODE_TTL_MS)
    expect(t.agent({ pairing: alice.client.code!.code! }).client.closed?.code).toBe(
      CloseCode.passwordWrong,
    )
  })

  it('closes the socket at once on a wrong code; the right one still works after', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    const guess = t.agent({ pairing: wrongCode(code) })
    expect(guess.client.closed).toEqual({
      code: CloseCode.passwordWrong,
      reason: 'wrong pairing code',
    })
    expect(guess.client.received).toEqual([])
    expect(t.agent({ pairing: code }).id).not.toBe('')
  })

  it('refuses pairing from a network after PAIRING_NETWORK_FAIL_RATE wrong codes, for the window', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    for (let i = 0; i < PAIRING_NETWORK_FAIL_RATE.count; i++) {
      expect(t.agent({ pairing: wrongCode(code) }, '6.6.6.6').client.closed?.code).toBe(
        CloseCode.passwordWrong,
      )
    }
    // Even the right code: that network is out of tries
    const blocked = t.agent({ pairing: code }, '6.6.6.6')
    expect(blocked.client.closed?.code).toBe(CloseCode.rateLimited)
    // The code was not looked at, so it still works from elsewhere
    expect(t.agent({ pairing: code }, '7.7.7.7').id).not.toBe('')
  })

  it('lets the network pair again once the window is over, and the limit survives an eviction', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    for (let i = 0; i < PAIRING_NETWORK_FAIL_RATE.count; i++) {
      t.agent({ pairing: wrongCode(alice.client.code!.code!) }, '6.6.6.6')
    }
    t.evict()
    void t.send(alice, { t: 'pairStart' })
    expect(t.agent({ pairing: alice.client.code!.code! }, '6.6.6.6').client.closed?.code).toBe(
      CloseCode.rateLimited,
    )
    t.tick(PAIRING_NETWORK_FAIL_RATE.windowMs)
    void t.send(alice, { t: 'pairStart' })
    expect(t.agent({ pairing: alice.client.code!.code! }, '6.6.6.6').id).not.toBe('')
  })

  it('voids every open code after PAIRING_ROOM_MAX_FAILS wrong codes room-wide, telling each issuer', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    void t.send(alice, { t: 'pairStart' })
    void t.send(bob, { t: 'pairStart' })
    const codes = [alice.client.code!.code!, bob.client.code!.code!]
    // Not a code anyone holds (and from many networks, so none is blocked)
    let wrong = 'ZZZZZZZZ'
    while (codes.includes(wrong)) wrong = wrong.replace('Z', 'Y')
    for (let i = 0; i < PAIRING_ROOM_MAX_FAILS - 1; i++) t.agent({ pairing: wrong }, `10.0.0.${i}`)
    expect(alice.client.notices).not.toContain('pairingVoided')
    t.agent({ pairing: wrong }, '10.0.1.0')
    for (const who of [alice, bob]) {
      expect(who.client.of('notice').at(-1)).toEqual({
        t: 'notice',
        notice: 'pairingVoided',
        by: who.id,
      })
      expect(who.client.code).toEqual({ t: 'pairCode', code: null, expiresAt: null })
    }
    expect(carol.client.notices).not.toContain('pairingVoided')
    expect(t.agent({ pairing: codes[0] }, '11.0.0.1').client.closed?.code).toBe(
      CloseCode.passwordWrong,
    )
    // A new code works, and the count starts again
    void t.send(alice, { t: 'pairStart' })
    expect(t.agent({ pairing: alice.client.code!.code! }, '11.0.0.2').id).not.toBe('')
  })

  it('counts the room-wide wrong codes only within PAIRING_CODE_TTL_MS', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    for (let i = 0; i < PAIRING_ROOM_MAX_FAILS - 1; i++) {
      t.agent({ pairing: wrongCode(code) }, `10.0.0.${i}`)
    }
    t.tick(PAIRING_CODE_TTL_MS - 1000)
    void t.send(alice, { t: 'pairStart' })
    const fresh = alice.client.code!.code!
    t.tick(2000)
    t.agent({ pairing: wrongCode(fresh) }, '10.0.1.0')
    expect(alice.client.notices).not.toContain('pairingVoided')
    expect(t.agent({ pairing: fresh }, '10.0.1.1').id).not.toBe('')
  })

  it('pairs one computer per member: pair_busy until it leaves', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    alice.client.forget()
    void t.send(alice, { t: 'pairStart' })
    expect(alice.client.errors).toEqual(['pair_busy'])
    expect(alice.client.of('pairCode')).toEqual([])
    void t.send(pc, { t: 'leave' })
    expect(pc.client.closed?.code).toBe(1000)
    expect(alice.client.view!.members[pc.id]).toBeUndefined()
    void t.send(alice, { t: 'pairStart' })
    expect(alice.client.code?.code).toBeTruthy()
  })

  it("makes the computer its issuer's: someone else's code pairs it as theirs, not as yours", () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    void t.send(bob, { t: 'pairStart' })
    const pc = t.agent({ pairing: bob.client.code!.code! })
    expect(alice.client.view!.members[pc.id].agent?.owner).toBe(bob.id)
    expect(alice.client.notices).not.toContain('agentPaired')
    // And only Bob may remove it with 「這不是我」
    alice.client.forget()
    void t.send(alice, { t: 'agentRemove', memberId: pc.id })
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(pc.client.closed).toBeNull()
  })

  it('lets only a member in the room ask: someone waiting may not', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const bob = t.join('Bob')
    expect(bob.client.of('lobby')).toHaveLength(1)
    void t.send(bob, { t: 'pairStart' })
    expect(bob.client.errors).toEqual(['forbidden'])
    expect(bob.client.of('pairCode')).toEqual([])
  })

  it('lets the owner remove their computer at once (「這不是我」), closed as removed', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    // Not someone who is not a computer
    void t.send(alice, { t: 'agentRemove', memberId: bob.id })
    expect(alice.client.errors).toEqual(['forbidden'])
    expect(bob.client.closed).toBeNull()
    // Not someone else's computer: Bob may not remove Alice's
    void t.send(bob, { t: 'agentRemove', memberId: pc.id })
    expect(bob.client.errors).toEqual(['forbidden'])
    expect(pc.client.closed).toBeNull()
    void t.send(alice, { t: 'agentRemove', memberId: pc.id })
    expect(pc.client.closed).toEqual({ code: CloseCode.removed, reason: 'removed' })
    expect(bob.client.view!.members[pc.id]).toBeUndefined()
    // Its token is gone with it
    expect(t.agent({ token: pc.token }).client.closed?.code).toBe(CloseCode.passwordRequired)
  })

  it('lets a host remove a computer like anyone', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(bob)
    void t.send(alice, { t: 'host', action: 'remove', memberId: pc.id })
    expect(pc.client.closed?.code).toBe(CloseCode.removed)
    expect(alice.client.view!.members[pc.id]).toBeUndefined()
  })

  it('keeps open codes through an eviction', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!
    expect(t.disk.pairing?.codes).toEqual([
      { owner: alice.id, code: code.code, expiresAt: code.expiresAt },
    ])
    t.evict()
    const pc = t.agent({ pairing: code.code! })
    expect(pc.id).not.toBe('')
    expect(alice.client.view!.members[pc.id].agent?.owner).toBe(alice.id)
    expect(t.disk.pairing).toBeNull()
  })

  it('lets the computer skip the password, the lock and the waiting room', async () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    await t.send(alice, { t: 'host', action: 'setPassword', password: 'secret12' })
    void t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    void t.send(alice, { t: 'host', action: 'lock', on: true })
    expect(alice.client.view!.room).toMatchObject({ locked: true, waitingRoom: true })
    const pc = t.agent({ pairing: alice.client.code!.code! })
    expect(alice.client.view!.members[pc.id]?.role).toBe('participant')
    expect(alice.client.view!.waiting).toEqual({})
  })

  it('counts the computer toward MAX_MEMBERS: a full room refuses it and keeps the code', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    const others = Array.from({ length: MAX_MEMBERS - 1 }, (_, i) => t.join(`P${i}`))
    expect(Object.keys(alice.client.view!.members)).toHaveLength(MAX_MEMBERS)
    expect(t.agent({ pairing: code }).client.closed?.code).toBe(CloseCode.roomFull)
    void t.send(others[0], { t: 'leave' })
    const pc = t.agent({ pairing: code })
    expect(pc.id).not.toBe('')
    // And a browser now finds the room full
    expect(t.join('Late').client.closed?.code).toBe(CloseCode.roomFull)
  })

  it("lands the computer in its owner's breakout room, or the main room", () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    void t.send(alice, {
      t: 'breakoutOpen',
      groups: ['一', '二'],
      assign: { [bob.id]: 0, [carol.id]: 1 },
      minutes: null,
    })
    const bobs = t.pair(bob)
    const alices = t.pair(alice, '2.2.2.2')
    const view = alice.client.view!
    expect(view.members[bobs.id].group).toBe('g1')
    expect(view.members[alices.id].group).toBeUndefined()
    // Carol, in the other room, cannot pull Bob's computer's screen
    void t.send(bobs, { t: 'share' })
    expect(t.host.bindSfu(bobs.token, 'sess-pc')).toBe(true)
    void t.send(bobs, {
      t: 'tracks',
      sessionId: 'sess-pc',
      tracks: [{ trackName: 'screen-pc', kind: 'screen', muted: false }],
    })
    const pull = { sessionId: 'sess-pc', trackName: 'screen-pc' }
    expect(t.host.sfuAccess(bob.token, null, [pull])).toMatchObject({ ok: true })
    expect(t.host.sfuAccess(carol.token, null, [pull])).toEqual({ ok: false, reason: 'not_found' })
  })

  it("keeps the computer when its owner leaves, nobody's now; the owner's open code goes", () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    const pc = t.pair(bob)
    void t.send(carol, { t: 'pairStart' })
    const code = carol.client.code!.code!
    void t.send(bob, { t: 'leave' })
    expect(alice.client.view!.members[pc.id]).toMatchObject({
      agent: { owner: null, device: HELLO.device, platform: 'windows' },
    })
    expect(pc.client.closed).toBeNull()
    void t.send(carol, { t: 'leave' })
    expect(t.disk.pairing).toBeNull()
    expect(t.agent({ pairing: code }, '3.3.3.3').client.closed?.code).toBe(CloseCode.passwordWrong)
  })

  it('never makes a computer the host or a co-host', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    const bob = t.join('Bob')
    void t.send(alice, { t: 'host', action: 'makeHost', memberId: pc.id })
    expect(alice.client.errors).toContain('forbidden')
    void t.send(alice, { t: 'host', action: 'setCohost', memberId: pc.id, on: true })
    expect(alice.client.view!.members[pc.id].role).toBe('participant')
    // The host leaves: Bob takes over, not the computer that came in before him
    void t.send(alice, { t: 'leave' })
    expect(bob.client.view!.members[bob.id].role).toBe('host')
    expect(bob.client.view!.members[pc.id].role).toBe('participant')
  })

  it('does not ask a computer to agree to a recording', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    const bob = t.join('Bob')
    void t.send(alice, { t: 'record', on: true })
    expect(Object.keys(alice.client.view!.room.recordings)).toEqual([alice.id])
    while (!bob.client.closed) t.alarm()
    // Bob, who never agreed, is gone; the computer stays
    expect(bob.client.closed.code).toBe(CloseCode.recordingDeclined)
    expect(pc.client.closed).toBeNull()
    expect(alice.client.view!.members[pc.id]).toBeDefined()
  })
})

describe('socket kinds (T-02)', () => {
  it('refuses every browser message on an agent socket, before and after its hello', () => {
    const t = setup()
    const alice = t.join('Alice')
    const { conn, client } = t.open(true, '1.1.1.1')
    const raw = { conn }
    void t.send(raw, { t: 'join', name: 'Mallory', token: null, client: null })
    void t.send(raw, { t: 'share' })
    expect(client.errors).toEqual(['bad_message', 'bad_message'])
    void t.send(alice, { t: 'pairStart' })
    void t.send(raw, { t: 'agentHello', pairing: alice.client.code!.code!, token: null, ...HELLO })
    const pc = client.of('agentWelcome')[0]
    expect(pc).toBeDefined()
    client.forget()
    for (const message of [
      { t: 'join', name: 'Mallory', token: null, client: null },
      { t: 'chat', text: 'hi' },
      { t: 'rename', name: 'Alice' },
      { t: 'pairStart' },
      { t: 'agentRemove', memberId: alice.id },
      { t: 'host', action: 'remove', memberId: alice.id },
      { t: 'controlRequest', agent: pc.memberId },
      { t: 'controlEvent', grant: 'A'.repeat(22), seq: 1, events: [] },
      { t: 'agentHello', pairing: null, token: pc.token, ...HELLO },
      { t: 'resync' },
    ]) {
      void t.send(raw, message)
    }
    expect(client.errors).toEqual(Array(10).fill('bad_message'))
    expect(client.closed).toBeNull()
    expect(alice.client.view!.members[alice.id]).toBeDefined()
    expect(alice.client.view!.members[pc.memberId].name).toBe(HELLO.device)
  })

  it('refuses agent messages on a browser socket, before and after its join', () => {
    const t = setup()
    const alice = t.join('Alice')
    void t.send(alice, { t: 'pairStart' })
    const code = alice.client.code!.code!
    const stranger = t.open(false, '1.1.1.1')
    void t.send(stranger, { t: 'agentHello', pairing: code, token: null, ...HELLO })
    expect(stranger.client.errors).toEqual(['bad_message'])
    alice.client.forget()
    void t.send(alice, { t: 'agentHello', pairing: code, token: null, ...HELLO })
    void t.send(alice, { t: 'controlAnswer', request: 'A'.repeat(22), decision: 'allow10' })
    expect(alice.client.errors).toEqual(['bad_message', 'bad_message'])
    // The code was never tried, so it still pairs
    expect(t.agent({ pairing: code }).id).not.toBe('')
  })

  it('does not let an agent token open a browser socket as the agent', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    const intruder = t.join('Mallory', pc.token)
    expect(intruder.id).not.toBe(pc.id)
    expect(intruder.token).not.toBe(pc.token)
    expect(pc.client.closed).toBeNull()
    expect(alice.client.view!.members[pc.id].agent).toBeDefined()
    expect(alice.client.view!.members[intruder.id].agent).toBeUndefined()
  })

  it('does not let a browser session token open an agent socket', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.agent({ token: alice.token })
    expect(pc.id).toBe('')
    expect(pc.client.closed).toEqual({ code: CloseCode.passwordRequired, reason: 'unknown token' })
    expect(alice.client.closed).toBeNull()
    expect(t.agent({ token: 'x'.repeat(43) }).client.closed?.code).toBe(CloseCode.passwordRequired)
  })

  it('checks each socket against its own protocol version at the upgrade', () => {
    const t = setup()
    const mismatch = {
      ok: false,
      code: CloseCode.versionMismatch,
      reason: 'protocol version mismatch',
    }
    expect(t.host.admit(V, null, true)).toEqual(mismatch)
    expect(t.host.admit(AV, null, false)).toEqual(mismatch)
    expect(t.host.admit(null, null, true)).toEqual(mismatch)
    expect(t.host.admit(AV, null, true)).toEqual({ ok: true })
  })

  it("keeps a socket's kind through an eviction (the attachment carries it)", () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.evict()
    pc.client.forget()
    alice.client.forget()
    void t.send(pc, { t: 'chat', text: 'hi' })
    expect(pc.client.errors).toEqual(['bad_message'])
    void t.send(alice, { t: 'chat', text: 'hi' })
    expect(alice.client.of('chat')).toHaveLength(1)
    expect(pc.client.of('chat')).toEqual([])
  })

  it('sends the agent no view, chat, strokes or lobby: its welcome, errors and notices only', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    void t.send(alice, { t: 'chat', text: 'hello' })
    void t.send(alice, { t: 'rename', name: 'Alice L.' })
    void t.send(alice, { t: 'whiteboard', open: true })
    void t.send(alice, { t: 'react', emoji: '👍' })
    void t.send(alice, { t: 'resync' })
    expect([...new Set(pc.client.received.map((m) => m.t))]).toEqual(['agentWelcome'])
  })
})

describe("the agent's screen and connection", () => {
  it('shares its screen through the SFU proxy with its own token, as a browser does', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const pc = t.pair(alice)
    expect(t.host.sfuAccess(pc.token, null, [])).toEqual({ ok: true, memberId: pc.id, pulls: [] })
    expect(t.host.bindSfu(pc.token, 'sess-pc')).toBe(true)
    // Its own session only
    expect(t.host.bindSfu(bob.token, 'sess-bob')).toBe(true)
    expect(t.host.sfuAccess(pc.token, 'sess-bob', [])).toEqual({ ok: false, reason: 'forbidden' })
    void t.send(pc, { t: 'share' })
    expect(bob.client.view!.room.shares[pc.id]).toBeDefined()
    void t.send(pc, {
      t: 'tracks',
      sessionId: 'sess-pc',
      tracks: [{ trackName: 'screen-pc', kind: 'screen', muted: false }],
    })
    expect(bob.client.view!.members[pc.id].tracks).toEqual([
      { sessionId: 'sess-pc', trackName: 'screen-pc', kind: 'screen', muted: false },
    ])
    expect(
      t.host.sfuAccess(bob.token, 'sess-bob', [{ sessionId: 'sess-pc', trackName: 'screen-pc' }]),
    ).toEqual({ ok: true, memberId: bob.id, pulls: ['screen'] })
    void t.send(pc, { t: 'unshare' })
    expect(bob.client.view!.room.shares[pc.id]).toBeUndefined()
    expect(bob.client.view!.members[pc.id].tracks).toEqual([])
    expect(pc.client.errors).toEqual([])
  })

  it('tells the agent a host stopped its share', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    void t.send(pc, { t: 'share' })
    void t.send(alice, { t: 'host', action: 'stopShare', memberId: pc.id })
    expect(pc.client.of('notice')).toEqual([{ t: 'notice', notice: 'shareStopped', by: alice.id }])
    expect(alice.client.view!.room.shares[pc.id]).toBeUndefined()
  })

  it("answers the heartbeat on an agent socket like a browser's", () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.tick(5_000)
    void t.send(pc, 'ping')
    expect(pc.client.errors).toEqual([])
    expect(pc.client.closed).toBeNull()
  })

  it('brings the agent back with its token within RECONNECT_GRACE_MS, as the same member', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    void t.send(pc, { t: 'share' })
    t.drop(pc)
    expect(alice.client.view!.members[pc.id].reconnecting).toBe(true)
    t.tick(RECONNECT_GRACE_MS / 2)
    const back = t.agent({ token: pc.token }, '9.9.9.9')
    expect(back.id).toBe(pc.id)
    expect(back.token).toBe(pc.token)
    expect(back.client.of('agentWelcome')[0]).toMatchObject({ owner: alice.id, ownerName: 'Alice' })
    expect(alice.client.view!.members[pc.id]).toMatchObject({
      reconnecting: false,
      name: HELLO.device,
    })
    expect(alice.client.view!.room.shares[pc.id]).toBeDefined()
    // A second socket with the token takes over: the first is closed as replaced
    const again = t.agent({ token: pc.token }, '9.9.9.9')
    expect(again.id).toBe(pc.id)
    expect(back.client.closed?.code).toBe(CloseCode.replaced)
  })

  it('forgets the agent after the grace: its token no longer works', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.drop(pc)
    const end = t.clock + RECONNECT_GRACE_MS + 1
    while (t.clock < end || alice.client.view!.members[pc.id]) t.alarm()
    expect(alice.client.view!.members[pc.id]).toBeUndefined()
    expect(t.agent({ token: pc.token }).client.closed?.code).toBe(CloseCode.passwordRequired)
    // Its owner may pair again
    void t.send(alice, { t: 'pairStart' })
    expect(alice.client.code?.code).toBeTruthy()
  })

  it('keeps the agent and its owner through an eviction', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.evict()
    expect(t.host.view().members[pc.id].agent?.owner).toBe(alice.id)
    t.drop(pc)
    const back = t.agent({ token: pc.token })
    expect(back.id).toBe(pc.id)
    expect(back.client.of('agentWelcome')[0]).toMatchObject({ owner: alice.id, ownerName: 'Alice' })
    alice.client.forget()
    void t.send(alice, { t: 'pairStart' })
    expect(alice.client.errors).toEqual(['pair_busy'])
  })
})

describe('agents never keep a room alive on their own', () => {
  it('sends the room name as null with createdBy when the room has none', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    expect(pc.client.of('agentWelcome')[0]).toMatchObject({ roomName: null, createdBy: 'Alice' })
  })

  it('closes every agent as ended when the last person leaves, and the room closes as empty', () => {
    const t = setup()
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    const alices = t.pair(alice)
    const bobs = t.pair(bob, '2.2.2.2')
    void t.send(alice, { t: 'leave' })
    // Bob is still here: both computers stay
    expect(alices.client.closed).toBeNull()
    expect(bobs.client.closed).toBeNull()
    void t.send(bob, { t: 'leave' })
    expect(alices.client.closed).toEqual({ code: CloseCode.ended, reason: 'nobody left' })
    expect(bobs.client.closed).toEqual({ code: CloseCode.ended, reason: 'nobody left' })
    expect(t.host.memberCount).toBe(0)
    expect(t.disk.sessions).toEqual([])
    // Nobody is connected: the usual empty-room close
    for (const who of [alices, bobs]) t.drop(who)
    expect(t.host.active).toBe(false)
    const closeAt = t.clock + EMPTY_ROOM_TTL_MS
    while (t.host.exists) t.alarm()
    expect(t.clock).toBeGreaterThanOrEqual(closeAt)
  })

  it("waits for the last person's reconnect grace before closing the agents", () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.drop(alice)
    t.tick(RECONNECT_GRACE_MS / 2)
    t.alarm()
    expect(pc.client.closed).toBeNull()
    // Alice comes back within the grace: nothing happens to her computer
    const back = t.join('Alice', alice.token)
    expect(back.id).toBe(alice.id)
    t.drop(back)
    const end = t.clock + RECONNECT_GRACE_MS + 1
    while (t.clock < end || !pc.client.closed) t.alarm()
    expect(pc.client.closed?.code).toBe(CloseCode.ended)
    expect(t.host.memberCount).toBe(0)
    while (t.host.exists) t.alarm()
  })

  it('counts someone waiting as a person', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    void t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const bob = t.join('Bob')
    expect(bob.client.of('lobby')).toHaveLength(1)
    void t.send(alice, { t: 'leave' })
    expect(pc.client.closed).toBeNull()
  })

  it('closes the agents after an eviction that finds no person left', () => {
    const t = setup()
    const alice = t.join('Alice')
    const pc = t.pair(alice)
    t.drop(alice)
    t.tick(RECONNECT_GRACE_MS + 1)
    t.evict()
    t.alarm()
    expect(pc.client.closed?.code).toBe(CloseCode.ended)
  })
})

describe('GET /api/rooms/<id>/agent', () => {
  function rooms() {
    const fetched: Request[] = []
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          fetched.push(request)
          return new Response('upgraded')
        },
      }),
    }
    const env = {
      ROOM: namespace,
      GUARD: { idFromName: (name: string) => name, get: () => ({}) },
    } as unknown as Env
    return { env, fetched }
  }

  it("hands the agent's WebSocket upgrade to the room, and nothing else", async () => {
    const { env, fetched } = rooms()
    const url = `https://x/api/rooms/abcdefghij/agent?v=${AV}`
    const res = await handleRequest(new Request(url, { headers: { Upgrade: 'websocket' } }), env)
    expect(await res.text()).toBe('upgraded')
    expect(fetched.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/rooms/abcdefghij/agent',
    ])
    expect((await handleRequest(new Request(url), env)).status).toBe(426)
    const other = await handleRequest(
      new Request('https://x/api/rooms/abcdefghij/agents', { headers: { Upgrade: 'websocket' } }),
      env,
    )
    expect(other.status).toBe(404)
    expect(fetched).toHaveLength(1)
  })
})
