// O2 (e11-t12): the chaos drill list, the parts that run without a deployment (DEPLOY.md §14).
//
// 1. Kill the room's Durable Object: a crash or a deploy throws the object away and every socket
//    with it. Everyone reconnects with their token (RoomConnection's backoff) and must get the same
//    seat back: id, role, share, raised hand, chat history; a locked room still lets them in. A
//    remote control grant (N3) is bound to the controller's socket, so it must end, not survive.
//    A whole office behind one address reconnecting at once must not trip the per-network limit.
// 2. The SFU's API hangs: the proxy gives up after REALTIME_TIMEOUT_MS with 502 (the browser
//    rebuilds, tests/app/RoomMedia.test.ts) instead of holding the negotiation open.
// 3. TURN unreachable: the credentials API hangs past TURN_API_TIMEOUT_MS, and the member gets
//    STUN only (unreachable and refusing are in tests/worker/turn.test.ts).
// 4. The drill endpoint itself (worker/chaos.ts): only where CHAOS_DRILLS is "1", and
//    wrangler.jsonc sets that for previews only.
//
// e2e/chaos.spec.ts runs the same drills against a pull request's preview with real browsers.
import { describe, expect, it, vi } from 'vitest'
import { ROOM_CONNECT_RATE } from '../../shared/abuse.ts'
import type { ChatMessage } from '../../shared/chat.ts'
import { AGENT_PROTOCOL_VERSION, type AgentServerMessage } from '../../shared/control.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  viewAsJson,
  type PairCodeMessage,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { STUN_SERVER } from '../../shared/turn.ts'
import { handleChaos } from '../../worker/chaos.ts'
import type { BreakoutState } from '../../worker/room-breakout.ts'
import type { ControlState } from '../../worker/room-control.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'
import type { PairingState } from '../../worker/room-pairing.ts'
import type { Schedule } from '../../worker/scheduler.ts'
import { handleSfu } from '../../worker/sfu.ts'
import { handleTurn } from '../../worker/turn.ts'

const V = String(PROTOCOL_VERSION)
const AV = String(AGENT_PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }
const HELLO = { device: '客廳的筆電', platform: 'windows', build: '0.1.0' } as const

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

  /** The chat as this browser holds it */
  get chat(): string[] {
    let log: ChatMessage[] = []
    for (const message of this.of('chat')) {
      log = message.reset ? [...message.messages] : [...log, ...message.messages]
    }
    return log.map((m) => m.text)
  }
}

type Who = { conn: string; client: FakeClient; id: string; token: string; ip: string }

/** A room on a RoomHost whose storage is a plain object, so the object can die and come back */
function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const kinds = new Map<string, { agent: boolean; ip: string | null }>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    schedule: null as Schedule | null,
    chat: new Map<number, ChatMessage>(),
    breakout: null as BreakoutState | null,
    pairing: null as PairingState | null,
    control: null as ControlState | null,
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
        saveChat: (message) => void disk.chat.set(message.id, structuredClone(message)),
        dropChat: (id) => void disk.chat.delete(id),
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        saveBreakout: (state) => void (disk.breakout = structuredClone(state)),
        savePairing: (state) => void (disk.pairing = structuredClone(state)),
        saveControl: (state) => void (disk.control = structuredClone(state)),
        clear: () => {
          disk.info = null
          disk.sessions = []
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = makeHost()
  host.create(ROOM)

  function open(agent: boolean, ip: string): { conn: string; client: FakeClient } | null {
    const admitted = host.admit(agent ? AV : V, ip, agent)
    if (!admitted.ok) return null
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    kinds.set(conn, { agent, ip })
    host.opened(conn, ip, null, agent)
    return { conn, client }
  }

  const send = (who: { conn: string }, message: object) =>
    host.message(who.conn, JSON.stringify(message))

  /** Someone joins (new, or with `token` coming back) from `ip`; null when the room refuses */
  function join(name: string, ip: string, token: string | null = null): Who | null {
    const opened = open(false, ip)
    if (!opened) return null
    void send(opened, { t: 'join', name, token, client: null })
    const welcome = opened.client.of('welcome')[0]
    if (!welcome) return null
    return { ...opened, id: welcome.you, token: welcome.token, ip }
  }

  return {
    get host() {
      return host
    },
    disk,
    join,
    send,
    open,
    /**
     * The object dies (DurableObjectState.abort, a crash, a deploy): every socket closes at once
     * and the next request builds a new object from storage, with no socket left
     */
    kill() {
      for (const client of clients.values()) {
        if (!client.closed) client.closed = { code: 1006, reason: 'object reset' }
      }
      host = makeHost()
      host.restore(
        disk.info,
        disk.rev,
        disk.sessions,
        [],
        null,
        disk.schedule,
        [...disk.chat.values()],
        [],
        { breakout: disk.breakout, pairing: disk.pairing, control: disk.control },
      )
    },
    tick: (ms: number) => void (clock += ms),
    alarm() {
      const next = host.nextAlarm()
      if (next === null) return
      clock = Math.max(clock, next)
      for (const [conn, client] of clients) if (!client.closed) host.heartbeat(conn, clock)
      host.alarm()
    },
  }
}

describe('chaos drill: the room’s Durable Object is killed mid-meeting (e11-t12)', () => {
  it('everyone comes back to the same seat: id, role, share, hand, chat; the lock lets them in', () => {
    const t = setup()
    const alice = t.join('Alice', '10.0.0.1')!
    const bob = t.join('Bob', '10.0.0.2')!
    const carol = t.join('Carol', '10.0.0.3')!
    void t.send(alice, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    void t.send(bob, { t: 'share' })
    void t.send(carol, { t: 'hand', up: true })
    for (const [who, text] of [
      [alice, '大家好'],
      [bob, '我分享一下畫面'],
      [carol, '我有問題'],
    ] as const) {
      void t.send(who, { t: 'chat', text })
    }
    void t.send(alice, { t: 'host', action: 'lock', on: true })
    const before = structuredClone(alice.client.view!)
    expect(before.room.locked).toBe(true)

    t.kill()
    // Nobody is connected; the room remembers who was there
    expect(t.disk.sessions.map((s) => s.member.id).sort()).toEqual(
      [alice.id, bob.id, carol.id].sort(),
    )

    // RoomConnection's backoff brings them back within seconds, in any order
    t.tick(1_500)
    const names = new Map([
      [alice, 'Alice'],
      [bob, 'Bob'],
      [carol, 'Carol'],
    ])
    const back = [carol, alice, bob].map((who) => t.join(names.get(who)!, who.ip, who.token)!)
    const [carol2, alice2, bob2] = back
    expect(back.map((w) => w.id)).toEqual([carol.id, alice.id, bob.id])
    expect(back.map((w) => w.token)).toEqual([carol.token, alice.token, bob.token])

    const view = bob2.client.view!
    expect(view.members[alice.id]).toMatchObject({ role: 'host', reconnecting: false })
    expect(view.members[bob.id]).toMatchObject({ role: 'cohost', reconnecting: false })
    expect(view.members[carol.id]).toMatchObject({ role: 'participant', reconnecting: false })
    expect(view.members[carol.id].hand).toBe(before.members[carol.id].hand)
    expect(Object.keys(view.room.shares)).toEqual([bob.id])
    expect(view.room.locked).toBe(true)
    for (const who of [alice2, bob2, carol2]) {
      expect(who.client.chat).toEqual(['大家好', '我分享一下畫面', '我有問題'])
    }
    // Everyone holds the same picture
    expect(alice2.client.view).toEqual(carol2.client.view)
    // And the locked room still keeps strangers out
    expect(t.join('Mallory', '10.0.0.9')).toBeNull()
  })

  it('who does not come back within RECONNECT_GRACE_MS leaves; the host passes on', () => {
    const t = setup()
    const alice = t.join('Alice', '10.0.0.1')!
    const bob = t.join('Bob', '10.0.0.2')!
    t.kill()
    t.tick(2_000)
    const bob2 = t.join('Bob', bob.ip, bob.token)!
    expect(bob2.id).toBe(bob.id)
    expect(bob2.client.view!.members[alice.id].reconnecting).toBe(true)
    // Alice's browser was closed meanwhile: her seat is kept for the grace window, then freed
    t.tick(RECONNECT_GRACE_MS)
    t.alarm()
    expect(bob2.client.view!.members[alice.id]).toBeUndefined()
    expect(bob2.client.view!.members[bob.id].role).toBe('host')
  })

  it('a remote control grant ends with the object: it was bound to the controller’s socket', () => {
    const t = setup()
    const owner = t.join('Alice', '10.0.0.1')!
    const helper = t.join('Bob', '10.0.0.2')!
    // Alice pairs her computer, which shares its screen (N2)
    void t.send(owner, { t: 'pairStart' })
    const code = owner.client.of('pairCode').at(-1)!.code!
    const agent = t.open(true, '20.0.0.1')!
    void t.send(agent, { t: 'agentHello', pairing: code, token: null, ...HELLO })
    const agentWelcome = agent.client.of('agentWelcome')[0]
    void t.send(agent, { t: 'share' })
    // Bob asks to control it and the person at the computer allows (N3)
    void t.send(helper, { t: 'controlRequest', agent: agentWelcome.memberId })
    const request = agent.client.of('controlAsk').at(-1)!.request
    void t.send(agent, { t: 'controlAnswer', request, decision: 'allow10' })
    const grant = helper.client.of('controlGranted').at(-1)!.grant
    expect(helper.client.view!.control).toBeTruthy()
    const move = (seq: number) => ({
      t: 'controlEvent',
      grant,
      seq,
      events: [{ type: 'move', x: 0.5, y: 0.5 }],
    })
    void t.send(helper, move(1))
    expect(agent.client.of('controlForward')).toHaveLength(1)

    t.kill()
    t.tick(1_500)
    // The computer and Bob both come back with their tokens
    const agent2 = t.open(true, '20.0.0.1')!
    void t.send(agent2, { t: 'agentHello', pairing: null, token: agentWelcome.token, ...HELLO })
    expect(agent2.client.of('agentWelcome')[0]?.memberId).toBe(agentWelcome.memberId)
    const helper2 = t.join('Bob', helper.ip, helper.token)!
    expect(helper2.id).toBe(helper.id)
    // Nothing of the grant is left: a new socket must ask again (threat model §5)
    expect(helper2.client.view!.control ?? null).toBeNull()
    void t.send(helper2, move(2))
    expect(agent2.client.of('controlForward')).toEqual([])
  })

  it('a whole office behind one address reconnects at once without tripping the limit', () => {
    const t = setup()
    const office = '203.0.113.7'
    const members = Array.from({ length: MAX_MEMBERS }, (_, i) => t.join(`同事${i + 1}`, office)!)
    expect(members.every(Boolean)).toBe(true)
    // They joined over a few minutes: the window has passed
    t.tick(ROOM_CONNECT_RATE.windowMs)
    t.kill()
    t.tick(1_000)
    const back = members.map((m, i) => t.join(`同事${i + 1}`, office, m.token))
    expect(back.map((m) => m?.id)).toEqual(members.map((m) => m.id))
    // Each of them may even need a second try (a socket that died on the way) and still fits
    expect(MAX_MEMBERS * 2).toBeLessThanOrEqual(ROOM_CONNECT_RATE.count)
  })
})

describe('chaos drill: the SFU and TURN APIs hang (e11-t12)', () => {
  /** A fetch that never answers, until the request's signal gives up */
  const hanging = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      }),
  )

  it('the SFU proxy answers 502 after its timeout instead of waiting forever', async () => {
    const room = {
      sfuAccess: vi.fn(async () => ({ ok: true as const, memberId: 'm1', pulls: [] })),
      bindSfu: vi.fn(async () => true),
    }
    const res = await handleSfu(
      new Request('https://longtalk.test/api/sfu/abcdefghij/sessions', {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(43)}` },
      }),
      { REALTIME_APP_ID: 'app', REALTIME_APP_SECRET: 'secret' },
      { room: () => room, usage: async () => 'normal', fetch: hanging, timeoutMs: 20 },
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream_error' })
    expect(hanging.mock.calls.at(-1)![1]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('TURN credentials fall back to STUN only after their timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await handleTurn(
      new Request('https://longtalk.test/api/turn/abcdefghij', {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(43)}` },
      }),
      { REALTIME_TURN_KEY_ID: 'key', REALTIME_TURN_KEY_API_TOKEN: 'token' },
      {
        room: () => ({
          sfuAccess: async () => ({ ok: true as const, memberId: 'm1', pulls: [] }),
        }),
        fetch: hanging,
        timeoutMs: 20,
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ turn: false, iceServers: [STUN_SERVER] })
  })
})

describe('the chaos drill endpoint (worker/chaos.ts)', () => {
  const url = (path: string) => new URL(`https://longtalk.test${path}`)
  const post = (path: string) => new Request(url(path), { method: 'POST' })

  it('does not exist unless CHAOS_DRILLS is "1"', async () => {
    const chaosKill = vi.fn(async () => {})
    for (const env of [{}, { CHAOS_DRILLS: '0' }, { CHAOS_DRILLS: 'true' }]) {
      const path = '/api/chaos/rooms/abcdefghij/kill'
      const res = await handleChaos(post(path), env, url(path), { room: () => ({ chaosKill }) })
      expect(res.status).toBe(404)
    }
    expect(chaosKill).not.toHaveBeenCalled()
  })

  it('kills the named room, and takes the failed call as the object going away', async () => {
    const env = { CHAOS_DRILLS: '1' }
    const named: string[] = []
    const chaosKill = vi.fn(async () => {
      throw new Error('chaos drill')
    })
    const path = '/api/chaos/rooms/abcdefghij/kill'
    const res = await handleChaos(post(path), env, url(path), {
      room: (id) => (named.push(id), { chaosKill }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ killed: 'abcdefghij' })
    expect(named).toEqual(['abcdefghij'])

    const get = await handleChaos(new Request(url(path)), env, url(path), {
      room: () => ({ chaosKill }),
    })
    expect(get.status).toBe(405)
    const bad = '/api/chaos/rooms/..%2F/kill'
    expect((await handleChaos(post(bad), env, url(bad), { room: () => ({ chaosKill }) })).status).toBe(400)
    const other = '/api/chaos/everything'
    expect((await handleChaos(post(other), env, url(other), { room: () => ({ chaosKill }) })).status).toBe(404)
    expect(chaosKill).toHaveBeenCalledTimes(1)
  })

  it('is turned on for the previews only, never in production (wrangler.jsonc)', () => {
    const fs = (
      globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }
    ).process.getBuiltinModule('node:fs') as { readFileSync(path: string, enc: 'utf8'): string }
    const wrangler = fs
      .readFileSync('wrangler.jsonc', 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    const envAt = wrangler.indexOf('"env"')
    expect(envAt).toBeGreaterThan(0)
    expect(wrangler.slice(0, envAt)).not.toContain('CHAOS_DRILLS')
    expect(wrangler.slice(envAt)).toContain('"CHAOS_DRILLS": "1"')
    // Deploys never pass it on the command line either
    for (const workflow of ['deploy.yml', 'preview.yml']) {
      expect(fs.readFileSync(`.github/workflows/${workflow}`, 'utf8')).not.toContain('CHAOS_DRILLS')
    }
  })
})
