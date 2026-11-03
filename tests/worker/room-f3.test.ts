// F3 (e1-t15 – e1-t17): the room password and its guess limit, co-hosts and handing over the host
// role, and ending the meeting (the tombstone)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import { PASSWORD_MAX_FAILS, PASSWORD_WAIT_MS, normalizePassword } from '../../shared/password.ts'
import {
  CloseCode,
  ENDED_TOMBSTONE_MS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  parseClientMessage,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import {
  GUESS_MEMORY_MS,
  PasswordGuard,
  addressKey,
  constantTimeEqual,
  hashPassword,
  verifyPassword,
  type GuessRecord,
  type PasswordRecord,
} from '../../worker/password.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const PASSWORD = 'tea4two'

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null
  rev = -1
  closed: { code: number; reason: string } | null = null

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
}

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const saved = {
    password: null as PasswordRecord | null,
    guesses: [] as GuessRecord[],
    ended: null as number | null,
    sessions: [] as SessionRecord[],
    /** Everything the room ever stored, as JSON: the password must never be in it */
    log: [] as string[],
  }
  const store = (what: unknown) => saved.log.push(JSON.stringify(what))
  const host = new RoomHost({
    sockets: {
      send: (conn, message) => clients.get(conn)?.receive(message),
      close: (conn, code, reason) => {
        const client = clients.get(conn)
        if (client) client.closed = { code, reason }
      },
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
      savePassword: (record) => {
        saved.password = record
        store(record)
      },
      saveGuesses: (guesses) => {
        saved.guesses = structuredClone(guesses)
        store(guesses)
      },
      saveEnded: (until) => {
        saved.ended = until
        store(until)
      },
      clear: () => store('clear'),
    },
    now: () => clock,
    newMemberId: () => `m${++nextId}`,
    newToken: () => `token-m${nextId}`.padEnd(43, '_'),
  })
  host.create({ id: 'abcdefghij', createdAt: 1000 })

  function open(ip: string | null = null) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn, ip)
    return { conn, client }
  }

  /** Joins on a new socket; awaits the password check when there is one */
  async function join(
    name: string,
    options: { token?: string | null; password?: string; client?: string; ip?: string } = {},
  ) {
    const socket = open(options.ip ?? null)
    await host.message(
      socket.conn,
      JSON.stringify({
        t: 'join',
        name,
        token: options.token ?? null,
        client: options.client ?? `browser-${name}`.padEnd(16, '0'),
        password: options.password,
      }),
    )
    const welcome = socket.client.received.find((m) => m.t === 'welcome')
    return {
      ...socket,
      id: welcome?.t === 'welcome' ? welcome.you : '',
      token: welcome?.t === 'welcome' ? welcome.token : '',
    }
  }

  const send = (conn: string, message: object) => host.message(conn, JSON.stringify(message))

  return {
    host,
    saved,
    open,
    join,
    send,
    tick: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

const forbidden: ServerMessage = { t: 'error', code: 'forbidden' }

describe('room password: digest and compare (e1-t15)', () => {
  it('keeps a salted SHA-256, never the password, and tells right from wrong', async () => {
    const a = await hashPassword(PASSWORD)
    const b = await hashPassword(PASSWORD)
    expect(JSON.stringify(a)).not.toContain(PASSWORD)
    // A fresh salt every time: the same password never gives the same digest
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(atob(a.salt)).toHaveLength(16)
    expect(atob(a.hash)).toHaveLength(32)
    expect(await verifyPassword(PASSWORD, a)).toBe(true)
    expect(await verifyPassword(PASSWORD, b)).toBe(true)
    expect(await verifyPassword('tea4twO', a)).toBe(false)
    expect(await verifyPassword('', a)).toBe(false)
  })

  it('compares every byte whatever the first difference', () => {
    const bytes = (...values: number[]) => new Uint8Array(values)
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true)
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(0, 2, 3))).toBe(false)
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false)
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2))).toBe(false)
    expect(constantTimeEqual(bytes(), bytes())).toBe(true)
  })

  it('accepts 4–12 printable characters, folding full-width ones', () => {
    expect(normalizePassword('1234')).toBe('1234')
    expect(normalizePassword('  abcDEF123!  ')).toBe('abcDEF123!')
    expect(normalizePassword('１２３４ａＢ')).toBe('1234aB')
    for (const bad of [
      '123',
      '1234567890123',
      'ab cd',
      '密碼密碼',
      '',
      null,
      1234,
      'a'.repeat(80),
    ]) {
      expect(normalizePassword(bad)).toBeNull()
    }
  })

  it('keeps network addresses as a digest bound to the room', async () => {
    const key = await addressKey('203.0.113.9', 'abcdefghij')
    expect(key).not.toContain('203')
    expect(key).toBe(await addressKey('203.0.113.9', 'abcdefghij'))
    expect(key).not.toBe(await addressKey('203.0.113.9', 'bcdefghijk'))
    expect(await addressKey(null, 'abcdefghij')).toBeNull()
  })
})

describe('room password: the guess limit with a fake clock (AC-1.8)', () => {
  it(`makes a browser wait ${PASSWORD_WAIT_MS / 1000} s after ${PASSWORD_MAX_FAILS} wrong guesses`, () => {
    const guard = new PasswordGuard()
    let now = 0
    expect(guard.waitUntil(['c:x'], now)).toBeNull()
    for (let i = 1; i < PASSWORD_MAX_FAILS; i++) {
      expect(guard.fail(['c:x'], (now += 1000))).toBeNull()
    }
    expect(guard.fail(['c:x'], (now += 1000))).toBe(now + PASSWORD_WAIT_MS)
    expect(guard.waitUntil(['c:x'], now + PASSWORD_WAIT_MS - 1)).toBe(now + PASSWORD_WAIT_MS)
    expect(guard.waitUntil(['c:x'], now + PASSWORD_WAIT_MS)).toBeNull()
    // After the wait, another PASSWORD_MAX_FAILS tries
    now += PASSWORD_WAIT_MS
    expect(guard.fail(['c:x'], now)).toBeNull()
  })

  it('counts a browser and its address together, and forgets old guesses', () => {
    const guard = new PasswordGuard()
    guard.fail(['c:a', 'a:ip'], 0)
    guard.fail(['c:b', 'a:ip'], 1)
    // A third browser on the same address hits the address's limit: both wait
    expect(guard.fail(['c:c', 'a:ip'], 2)).toBe(2 + PASSWORD_WAIT_MS)
    expect(guard.waitUntil(['c:c'], 3)).toBe(2 + PASSWORD_WAIT_MS)
    expect(guard.waitUntil(['c:z', 'a:ip'], 3)).toBe(2 + PASSWORD_WAIT_MS)
    expect(guard.waitUntil(['c:a'], 3)).toBeNull()
    // A wrong guess long ago no longer counts
    const later = new PasswordGuard()
    later.fail(['c:x'], 0)
    later.fail(['c:x'], 1)
    expect(later.fail(['c:x'], 2 + GUESS_MEMORY_MS)).toBeNull()
    expect(later.prune(3 + 2 * GUESS_MEMORY_MS)).toBe(true)
    expect(later.size).toBe(0)
  })

  it('starts counting again after the right password, and survives being stored', () => {
    const guard = new PasswordGuard()
    guard.fail(['c:x'], 0)
    guard.fail(['c:x'], 1)
    guard.succeed(['c:x'])
    expect(guard.fail(['c:x'], 2)).toBeNull()
    const restored = new PasswordGuard(structuredClone(guard.toJSON()))
    expect(restored.fail(['c:x'], 3)).toBeNull()
    expect(restored.fail(['c:x'], 4)).toBe(4 + PASSWORD_WAIT_MS)
  })
})

describe('RoomHost password (e1-t15)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  async function withPassword() {
    const alice = await t.join('Alice')
    await t.send(alice.conn, { t: 'host', action: 'setPassword', password: PASSWORD })
    return alice
  }

  it('lets only the host set, change and clear it; everyone sees when, nobody sees it', async () => {
    const alice = await t.join('Alice')
    const bob = await t.join('Bob')
    await t.send(bob.conn, { t: 'host', action: 'setPassword', password: PASSWORD })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    expect(t.host.view().room.passwordSetAt).toBeNull()
    // A co-host may not either (F1's decision)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    await t.send(bob.conn, { t: 'host', action: 'setPassword', password: PASSWORD })
    expect(bob.client.received.at(-1)).toEqual(forbidden)

    await t.send(alice.conn, { t: 'host', action: 'setPassword', password: PASSWORD })
    expect(bob.client.view!.room.passwordSetAt).toBe(t.now())
    expect(t.saved.password).not.toBeNull()
    expect(await verifyPassword(PASSWORD, t.saved.password!)).toBe(true)
    t.tick(1000)
    await t.send(alice.conn, { t: 'host', action: 'setPassword', password: 'other1' })
    expect(bob.client.view!.room.passwordSetAt).toBe(t.now())
    expect(await verifyPassword(PASSWORD, t.saved.password!)).toBe(false)
    await t.send(alice.conn, { t: 'host', action: 'setPassword', password: null })
    expect(bob.client.view!.room.passwordSetAt).toBeNull()
    expect(t.saved.password).toBeNull()
    // Not a password: refused as a bad message, nothing changes
    await t.send(alice.conn, { t: 'host', action: 'setPassword', password: '12' })
    expect(alice.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
  })

  it('asks someone new for it: none, wrong, then right', async () => {
    await withPassword()
    const none = await t.join('Carol')
    expect(none.client.closed).toEqual({
      code: CloseCode.passwordRequired,
      reason: 'password required',
    })
    const wrong = await t.join('Carol', { password: 'nope1' })
    expect(wrong.client.closed).toEqual({ code: CloseCode.passwordWrong, reason: 'wrong password' })
    expect(wrong.client.received).toEqual([])
    const right = await t.join('Carol', { password: PASSWORD })
    expect(right.client.closed).toBeNull()
    expect(right.client.view!.members[right.id].name).toBe('Carol')
    // Full-width digits from an IME count as the same password
    const fullWidth = await t.join('Dave', { password: 'ｔｅａ４ｔｗｏ' })
    expect(fullWidth.id).not.toBe('')
  })

  it(`makes a browser wait after ${PASSWORD_MAX_FAILS} wrong guesses, then lets it try again`, async () => {
    await withPassword()
    for (let i = 1; i < PASSWORD_MAX_FAILS; i++) {
      const guess = await t.join('Eve', { password: `wrong${i}` })
      expect(guess.client.closed?.code).toBe(CloseCode.passwordWrong)
    }
    const last = await t.join('Eve', { password: 'wrong9' })
    expect(last.client.closed).toEqual({
      code: CloseCode.passwordWait,
      reason: String(PASSWORD_WAIT_MS),
    })
    // Even the right password waits, without being checked
    t.tick(10_000)
    const early = await t.join('Eve', { password: PASSWORD })
    expect(early.client.closed).toEqual({
      code: CloseCode.passwordWait,
      reason: String(PASSWORD_WAIT_MS - 10_000),
    })
    // Another browser is not held up by Eve's guesses
    expect((await t.join('Frank', { password: PASSWORD })).id).not.toBe('')
    // The wait is stored (the object may sleep), and runs out
    expect(t.saved.guesses.some((g) => g.until !== null)).toBe(true)
    t.tick(PASSWORD_WAIT_MS - 10_000)
    expect((await t.join('Eve', { password: PASSWORD })).id).not.toBe('')
  })

  it('counts guesses per network address too, across browsers', async () => {
    await withPassword()
    for (const name of ['P', 'Q', 'R']) {
      await t.join(name, { password: 'nope1', ip: 'office' })
    }
    const s = await t.join('S', { password: PASSWORD, ip: 'office' })
    expect(s.client.closed?.code).toBe(CloseCode.passwordWait)
    expect((await t.join('S', { password: PASSWORD, ip: 'home' })).id).not.toBe('')
  })

  it('does not ask again within the grace period, nor someone already waiting', async () => {
    const alice = await withPassword()
    const bob = await t.join('Bob', { password: PASSWORD })
    t.host.closed(bob.conn)
    t.tick(RECONNECT_GRACE_MS - 1000)
    const back = await t.join('Bob', { token: bob.token })
    expect(back.id).toBe(bob.id)
    // Someone waiting gave it already; coming back after a reload, they keep their place
    await t.send(alice.conn, { t: 'host', action: 'waitingRoom', on: true })
    const carol = await t.join('Carol', { password: PASSWORD })
    const lobby = carol.client.received.find((m) => m.t === 'lobby')
    expect(lobby).toBeDefined()
    t.host.closed(carol.conn)
    const again = await t.join('Carol', { token: lobby!.t === 'lobby' ? lobby!.token : null })
    expect(again.client.received.some((m) => m.t === 'lobby')).toBe(true)
    expect(again.client.closed).toBeNull()
  })

  it('checks the lock before the password, and the password before the waiting room', async () => {
    const alice = await withPassword()
    await t.send(alice.conn, { t: 'host', action: 'lock', on: true })
    // A locked room says nothing about the password, and costs no guess
    for (let i = 0; i < PASSWORD_MAX_FAILS + 1; i++) {
      const locked = await t.join('Eve', { password: 'wrong1' })
      expect(locked.client.closed?.code).toBe(CloseCode.locked)
    }
    expect(t.saved.guesses).toEqual([])
    await t.send(alice.conn, { t: 'host', action: 'lock', on: false })
    await t.send(alice.conn, { t: 'host', action: 'waitingRoom', on: true })
    const wrong = await t.join('Eve', { password: 'wrong1' })
    expect(wrong.client.closed?.code).toBe(CloseCode.passwordWrong)
    expect(t.host.view().waiting).toEqual({})
    const right = await t.join('Eve', { password: PASSWORD })
    expect(right.client.received.some((m) => m.t === 'lobby')).toBe(true)
  })

  it('refuses a guess checked against a password the host changed meanwhile', async () => {
    const alice = await withPassword()
    const socket = t.open()
    // The new password's digest is asked for first, so it is ready before the guess is checked
    const changing = t.send(alice.conn, { t: 'host', action: 'setPassword', password: 'newer1' })
    const pending = t.host.message(
      socket.conn,
      JSON.stringify({ t: 'join', name: 'Eve', token: null, client: null, password: PASSWORD }),
    )
    // A second join on the same socket while the first is checked is refused
    await t.host.message(socket.conn, JSON.stringify({ t: 'join', name: 'Eve', token: null }))
    expect(socket.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    await changing
    await pending
    expect(socket.client.closed).toEqual({
      code: CloseCode.passwordWrong,
      reason: 'password changed',
    })
  })

  it('never writes the password anywhere: storage, views, messages, the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    )
    try {
      const alice = await withPassword()
      const bob = await t.join('Bob', { password: PASSWORD })
      await t.join('Eve', { password: 'tea4twX' })
      const everything = [
        ...t.saved.log,
        JSON.stringify(t.host.view()),
        JSON.stringify(alice.client.received),
        JSON.stringify(bob.client.received),
        ...spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))),
      ].join('\n')
      expect(everything).not.toContain(PASSWORD)
      expect(everything).not.toContain('tea4twX')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('reads a password only from join and setPassword', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', name: 'A', token: null }))).toEqual({
      t: 'join',
      name: 'A',
      token: null,
      client: null,
    })
    expect(
      parseClientMessage(JSON.stringify({ t: 'join', name: 'A', token: null, password: ' 1234 ' })),
    ).toMatchObject({ password: '1234' })
    expect(
      parseClientMessage(JSON.stringify({ t: 'join', name: 'A', token: null, password: 'ab' })),
    ).not.toHaveProperty('password')
  })
})

describe('RoomHost co-hosts and handing over (e1-t16)', () => {
  let t: ReturnType<typeof setup>
  let alice: Awaited<ReturnType<ReturnType<typeof setup>['join']>>
  let bob: typeof alice
  let carol: typeof alice
  beforeEach(async () => {
    t = setup()
    alice = await t.join('Alice')
    bob = await t.join('Bob')
    carol = await t.join('Carol')
  })
  const role = (id: string) => t.host.view().members[id].role
  const publishMic = async (who: typeof alice) => {
    expect(t.host.bindSfu(who.token, `sfu-${who.id}`)).toBe(true)
    await t.send(who.conn, {
      t: 'tracks',
      sessionId: `sfu-${who.id}`,
      tracks: [{ trackName: 'mic', kind: 'mic', muted: false }],
    })
  }

  it('lets only the host name and revoke co-hosts; the member is told first', async () => {
    await t.send(bob.conn, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    expect(role(bob.id)).toBe('cohost')
    const told = bob.client.received.findIndex((m) => m.t === 'notice')
    expect(bob.client.received[told]).toEqual({ t: 'notice', notice: 'madeCohost', by: alice.id })
    // The notice comes before the patch that shows the new role
    expect(bob.client.received.slice(told).some((m) => m.t === 'patch')).toBe(true)
    // A co-host may not name another
    await t.send(bob.conn, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: false })
    expect(role(bob.id)).toBe('participant')
    expect(bob.client.received.at(-2)).toEqual({
      t: 'notice',
      notice: 'cohostRevoked',
      by: alice.id,
    })
    // Not on oneself
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: alice.id, on: true })
    expect(alice.client.received.at(-1)).toEqual(forbidden)
    expect(role(alice.id)).toBe('host')
  })

  it('gives a co-host the host controls but end, password, co-hosts, handover', async () => {
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    await publishMic(carol)
    await publishMic(alice)
    await t.send(bob.conn, { t: 'host', action: 'muteMember', memberId: carol.id })
    expect(t.host.view().members[carol.id].tracks[0].muted).toBe(true)
    expect(carol.client.received.at(-2)).toEqual({ t: 'notice', notice: 'muted', by: bob.id })
    // Not the host
    await t.send(bob.conn, { t: 'host', action: 'muteMember', memberId: alice.id })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    for (const message of [
      { t: 'host', action: 'endMeeting' },
      { t: 'host', action: 'setPassword', password: PASSWORD },
      { t: 'host', action: 'makeHost', memberId: carol.id },
      { t: 'host', action: 'setCohost', memberId: carol.id, on: true },
    ]) {
      await t.send(bob.conn, message)
      expect(bob.client.received.at(-1)).toEqual(forbidden)
    }
    expect(t.host.exists).toBe(true)
    // What a co-host may do to the whole room
    await t.send(bob.conn, { t: 'host', action: 'lock', on: true })
    expect(t.host.view().room.locked).toBe(true)
  })

  it('lets a named co-host spotlight someone (G2), and not once revoked', async () => {
    await t.send(bob.conn, { t: 'spotlight', memberId: carol.id })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: true })
    await t.send(bob.conn, { t: 'spotlight', memberId: carol.id })
    expect(carol.client.view!.room.spotlight).toBe(carol.id)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: bob.id, on: false })
    await t.send(bob.conn, { t: 'spotlight', memberId: null })
    expect(bob.client.received.at(-1)).toEqual(forbidden)
    expect(t.host.view().room.spotlight).toBe(carol.id)
  })

  it('hands the host role over: the previous host is a co-host, the new one is told', async () => {
    await t.send(alice.conn, { t: 'host', action: 'makeHost', memberId: carol.id })
    expect(role(carol.id)).toBe('host')
    expect(role(alice.id)).toBe('cohost')
    expect(carol.client.received.some((m) => m.t === 'notice' && m.notice === 'madeHost')).toBe(
      true,
    )
    // Only one host: Alice cannot do it again, Carol can end the meeting
    await t.send(alice.conn, { t: 'host', action: 'makeHost', memberId: bob.id })
    expect(alice.client.received.at(-1)).toEqual(forbidden)
    expect(Object.values(t.host.view().members).filter((m) => m.role === 'host')).toHaveLength(1)
  })

  it('does not hand over to someone reconnecting or waiting', async () => {
    t.host.closed(bob.conn)
    await t.send(alice.conn, { t: 'host', action: 'makeHost', memberId: bob.id })
    expect(alice.client.received.at(-1)).toEqual(forbidden)
    expect(role(alice.id)).toBe('host')
    await t.send(alice.conn, { t: 'host', action: 'waitingRoom', on: true })
    const dave = await t.join('Dave')
    const lobby = dave.client.received.find((m) => m.t === 'lobby')
    const daveId = lobby?.t === 'lobby' ? lobby.you : ''
    await t.send(alice.conn, { t: 'host', action: 'makeHost', memberId: daveId })
    expect(alice.client.received.at(-1)).toEqual(forbidden)
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: daveId, on: true })
    expect(t.host.view().waiting[daveId]).toBeDefined()
  })

  it('a host leaving hands over to a co-host first, or to whom it names', async () => {
    await t.send(alice.conn, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
    await t.send(alice.conn, { t: 'leave' })
    // Bob joined before Carol, but Carol is a co-host
    expect(role(carol.id)).toBe('host')
    const dave = await t.join('Dave')
    await t.send(carol.conn, { t: 'leave', host: dave.id })
    expect(role(dave.id)).toBe('host')
    expect(dave.client.received.some((m) => m.t === 'notice' && m.notice === 'madeHost')).toBe(true)
    expect(t.host.view().members[carol.id]).toBeUndefined()
    // Naming someone who cannot take it falls back to the rule; a participant naming is ignored
    await t.send(bob.conn, { t: 'leave', host: dave.id })
    expect(role(dave.id)).toBe('host')
    await t.send(dave.conn, { t: 'leave', host: 'nobody' })
    expect(Object.values(t.host.view().members)).toEqual([])
  })
})

describe('RoomHost ending the meeting (e1-t17)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('closes everyone with `ended`, and a member coming back later still learns it ended', async () => {
    const alice = await t.join('Alice')
    const bob = await t.join('Bob')
    // Bob's connection dropped just before the end
    t.host.closed(bob.conn)
    await t.send(alice.conn, { t: 'host', action: 'endMeeting' })
    expect(alice.client.closed).toEqual({ code: CloseCode.ended, reason: 'ended' })
    expect(t.host.exists).toBe(false)
    expect(t.saved.ended).toBe(t.now() + ENDED_TOMBSTONE_MS)
    // Bob's browser reconnects: the socket is refused with `ended`, not `roomNotFound`
    t.tick(30_000)
    expect(t.host.admit(V)).toEqual({ ok: false, code: CloseCode.ended, reason: 'ended' })
    expect(t.host.create({ id: 'abcdefghij', createdAt: t.now() })).toBe(false)
    // The tombstone survives the object being evicted
    const restored = setup()
    restored.host.restore(null, 0, [], [], null, { ended: t.saved.ended! }, [], [], {
      endedUntil: t.saved.ended,
    })
    restored.tick(t.now() - restored.now())
    expect(restored.host.admit(V)).toMatchObject({ code: CloseCode.ended })
    t.tick(ENDED_TOMBSTONE_MS)
    expect(t.host.admit(V)).toMatchObject({ code: CloseCode.roomNotFound })
  })
})
