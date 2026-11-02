import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  JOIN_TIMEOUT_MS,
  MAX_MEMBERS,
  MAX_PENDING_SOCKETS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  STALE_AFTER_MS,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { ASSUMED_BITRATE, MAX_REPORTED_BITRATE } from '../../shared/usage.ts'
import {
  MAX_USAGE_GAP_MS,
  RoomHost,
  type SessionRecord,
  type UsageCursor,
} from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

/** A browser as the room sees it: keeps its own copy of the view from what it receives */
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

function setup(prefix = 'm') {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const saved = {
    room: null as unknown,
    rev: 0,
    sessions: [] as SessionRecord[],
    usage: null as UsageCursor | null,
  }
  const host = new RoomHost({
    sockets: {
      send: (conn, message) => clients.get(conn)?.receive(message),
      close: (conn, code, reason) => {
        const client = clients.get(conn)
        if (client) client.closed = { code, reason }
      },
    },
    storage: {
      saveRoom: (info) => {
        saved.room = info
      },
      saveRev: (rev) => {
        saved.rev = rev
      },
      saveSessions: (sessions) => {
        saved.sessions = structuredClone(sessions)
      },
      saveUsage: (usage) => {
        saved.usage = usage
      },
    },
    now: () => clock,
    newMemberId: () => `${prefix}${++nextId}`,
    // The same shape as a real token, or parseClientMessage drops it
    newToken: () => `token-${prefix}${nextId}`.padEnd(43, '_'),
  })
  /** Opens a socket the way RoomDO does: admit, accept, then `opened` */
  function open(): { conn: string; client: FakeClient } {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `${prefix}c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    return { conn, client }
  }
  /** Opens a socket and joins on it; `id` and `token` are '' when it was not welcomed */
  function join(name = 'Gene', token: string | null = null) {
    const socket = open()
    host.message(socket.conn, JSON.stringify({ t: 'join', name, token }))
    const welcome = socket.client.received.find((message) => message.t === 'welcome')
    return {
      ...socket,
      id: welcome?.t === 'welcome' ? welcome.you : '',
      token: welcome?.t === 'welcome' ? welcome.token : '',
    }
  }
  return {
    host,
    saved,
    clients,
    open,
    join,
    tick: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

const member = (id: string, name: string, joinedAt: number, reconnecting = false) => ({
  id,
  name,
  joinedAt,
  reconnecting,
  tracks: [],
})

describe('RoomHost', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('is created once and stored', () => {
    expect(t.host.exists).toBe(false)
    expect(t.host.summary()).toBeNull()
    expect(t.host.create(ROOM)).toBe(true)
    expect(t.host.create({ ...ROOM, createdAt: 2 })).toBe(false)
    expect(t.saved.room).toEqual(ROOM)
    expect(t.host.view()).toEqual({ room: ROOM, members: {}, usage: 'normal' })
    expect(t.host.summary()).toEqual({ ...ROOM, memberCount: 0 })
  })

  it('refuses sockets to a room that was never created, of another version, or when full', () => {
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomNotFound })
    t.host.create(ROOM)
    expect(t.host.admit(null)).toMatchObject({ ok: false, code: CloseCode.versionMismatch })
    expect(t.host.admit('1')).toMatchObject({ ok: false, code: CloseCode.versionMismatch })
    for (let i = 0; i < MAX_MEMBERS + MAX_PENDING_SOCKETS; i++) t.open()
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomFull })
  })

  it('makes a member only on join, and welcomes it with its session token', () => {
    t.host.create(ROOM)
    const socket = t.open()
    expect(t.host.memberCount).toBe(0)
    expect(socket.client.received).toEqual([])
    t.host.message(socket.conn, JSON.stringify({ t: 'join', name: '  小潔  ', token: null }))
    expect(socket.client.received).toEqual([
      {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        you: 'm1',
        token: 'token-m1'.padEnd(43, '_'),
        rev: 1,
        state: { room: ROOM, members: { m1: member('m1', '小潔', t.now()) }, usage: 'normal' },
      },
    ])
    expect(t.host.summary()).toMatchObject({ memberCount: 1 })
  })

  it('welcomes a newcomer with the whole room and patches everyone else', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    t.tick(5)
    const b = t.join('小潔')
    expect(a.client.received[1]).toEqual({
      t: 'patch',
      rev: 2,
      ops: [{ op: 'set', path: ['members', b.id], value: member(b.id, '小潔', t.now()) }],
    })
    expect(b.client.received).toHaveLength(1)
    expect(b.client.received[0]).toMatchObject({ t: 'welcome', you: b.id, rev: 2 })
    expect(a.client.view).toEqual(b.client.view)
    expect(t.saved.rev).toBe(2)
  })

  it('never puts a session token in the view or a patch', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    const others = JSON.stringify([...a.client.received.slice(1), t.host.view()])
    expect(others).not.toContain(a.token)
    expect(others).not.toContain(b.token)
  })

  it('accepts only join before joining, and join only once', () => {
    t.host.create(ROOM)
    const socket = t.open()
    t.host.message(socket.conn, '{"t":"resync"}')
    t.host.message(socket.conn, '{"t":"join","name":"   "}')
    expect(socket.client.received).toEqual([
      { t: 'error', code: 'bad_message' },
      { t: 'error', code: 'bad_message' },
    ])
    const a = t.join()
    t.host.message(a.conn, '{"t":"join","name":"again","token":null}')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    expect(t.host.memberCount).toBe(1)
  })

  it('answers resync with a snapshot and a bad message with an error', () => {
    t.host.create(ROOM)
    const a = t.join()
    t.host.message(a.conn, '{"t":"resync"}')
    expect(a.client.received.at(-1)).toEqual({ t: 'snapshot', rev: 1, state: t.host.view() })
    t.host.message(a.conn, '{"t":"nope"}')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    const count = a.client.received.length
    t.host.message(a.conn, 'ping')
    t.host.message('ghost', '{"t":"resync"}')
    expect(a.client.received).toHaveLength(count)
  })

  it('keeps a dropped member as reconnecting and gives it back to the same token', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    const joinedAt = t.now()
    t.host.closed(b.conn)
    t.host.closed(b.conn)
    expect(a.client.received.at(-1)).toEqual({
      t: 'patch',
      rev: 3,
      ops: [{ op: 'set', path: ['members', b.id, 'reconnecting'], value: true }],
    })
    expect(t.host.memberCount).toBe(2)
    // The page reloads within the grace window: same member and token; the name may change
    t.tick(RECONNECT_GRACE_MS - 1000)
    const again = t.join('小潔 Chen', b.token)
    expect(again.id).toBe(b.id)
    expect(again.token).toBe(b.token)
    expect(a.client.view!.members[b.id]).toEqual(member(b.id, '小潔 Chen', joinedAt))
    expect(Object.keys(a.client.view!.members)).toEqual([a.id, b.id])
    expect(again.client.view).toEqual(a.client.view)
  })

  it('removes a reconnecting member once the grace window is over', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(b.conn)
    t.tick(RECONNECT_GRACE_MS)
    t.host.heartbeat(a.conn, t.now())
    expect(t.host.sweep()).toBe(0)
    t.tick(1)
    expect(t.host.sweep()).toBe(1)
    expect(Object.keys(a.client.view!.members)).toEqual([a.id])
    // Its token now makes a new member
    const late = t.join('小潔', b.token)
    expect(late.id).not.toBe(b.id)
    expect(late.token).not.toBe(b.token)
  })

  it('removes a member that leaves on purpose at once, and forgets its token', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.message(b.conn, '{"t":"leave"}')
    expect(b.client.closed).toEqual({ code: 1000, reason: 'left' })
    expect(a.client.received.at(-1)).toEqual({
      t: 'patch',
      rev: 3,
      ops: [{ op: 'del', path: ['members', b.id] }],
    })
    // The close that follows the leave changes nothing
    t.host.closed(b.conn)
    expect(a.client.received.at(-1)).toMatchObject({ rev: 3 })
    expect(t.join('小潔', b.token).id).not.toBe(b.id)
  })

  it('moves a session to the newest socket and closes the old one', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const tab = t.join('Gene', a.token)
    expect(tab.id).toBe(a.id)
    expect(a.client.closed).toEqual({ code: CloseCode.replaced, reason: 'session taken over' })
    expect(t.host.memberCount).toBe(1)
    // The old socket's late close does not mark the member as reconnecting
    t.host.closed(a.conn)
    expect(t.host.view().members[a.id].reconnecting).toBe(false)
  })

  it('lets a known member back into a full room, but not a new one', () => {
    t.host.create(ROOM)
    const all = Array.from({ length: MAX_MEMBERS }, (_, i) => t.join(`p${i}`))
    t.host.closed(all[0].conn)
    const stranger = t.join('stranger')
    expect(stranger.id).toBe('')
    expect(stranger.client.closed).toMatchObject({ code: CloseCode.roomFull })
    expect(t.join('p0', all[0].token).id).toBe(all[0].id)
  })

  it('keeps every member in step through joins, drops and leaves', () => {
    t.host.create(ROOM)
    const all = Array.from({ length: 5 }, (_, i) => t.join(`p${i}`))
    t.host.closed(all[1].conn)
    t.host.message(all[3].conn, '{"t":"leave"}')
    const late = t.join('late')
    const back = t.join('p1', all[1].token)
    for (const { conn, client } of [all[0], all[2], all[4], late, back]) {
      expect(client.view, conn).toEqual(t.host.view())
    }
  })

  it('closes sockets that never join', () => {
    t.host.create(ROOM)
    const idle = t.open()
    t.tick(JOIN_TIMEOUT_MS + 1)
    expect(t.host.sweep()).toBe(1)
    expect(idle.client.closed).toEqual({ code: CloseCode.stale, reason: 'no join' })
    expect(t.host.active).toBe(false)
  })

  it('closes silent sockets and lets their members reconnect', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.tick(STALE_AFTER_MS - 1000)
    t.host.heartbeat(a.conn, t.now())
    t.tick(2000)
    expect(t.host.sweep()).toBe(1)
    expect(b.client.closed).toEqual({ code: CloseCode.stale, reason: 'heartbeat timeout' })
    expect(a.client.closed).toBeNull()
    expect(a.client.view!.members[b.id].reconnecting).toBe(true)
    // A message counts as a heartbeat too
    t.tick(STALE_AFTER_MS - 1000)
    t.host.message(a.conn, 'ping')
    t.tick(2000)
    expect(t.host.sweep()).toBe(0)
    expect(t.join('小潔', b.token).id).toBe(b.id)
  })

  it('never moves a heartbeat backwards', () => {
    t.host.create(ROOM)
    const a = t.join()
    t.tick(STALE_AFTER_MS)
    t.host.heartbeat(a.conn, t.now())
    t.host.heartbeat(a.conn, 0)
    t.tick(1000)
    expect(t.host.sweep()).toBe(0)
  })

  it('stores the sessions on every change', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    expect(t.saved.sessions).toEqual([
      {
        token: a.token,
        member: member(a.id, 'Gene', t.now()),
        conn: a.conn,
        awaySince: null,
        sfu: null,
      },
    ])
    t.tick(10)
    t.host.closed(a.conn)
    expect(t.saved.sessions).toEqual([
      {
        token: a.token,
        member: member(a.id, 'Gene', t.now() - 10, true),
        conn: null,
        awaySince: t.now(),
        sfu: null,
      },
    ])
  })

  it('comes back from hibernation with the same view, rev and sessions', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(b.conn)
    const view = t.host.view()
    const woken = setup('w')
    woken.host.restore(ROOM, t.saved.rev, t.saved.sessions, [{ conn: a.conn, openedAt: 0 }])
    expect(woken.host.view()).toEqual(view)
    woken.clients.set(a.conn, a.client)
    // The next change continues the same numbering, so a's copy stays valid
    const back = woken.join('小潔', b.token)
    expect(back.id).toBe(b.id)
    expect(back.client.received[0]).toMatchObject({ rev: 4 })
    expect(a.client.view).toEqual(woken.host.view())
    expect(a.client.view!.members[b.id].reconnecting).toBe(false)
  })

  it('marks a stored member whose socket is gone as reconnecting when it wakes up', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    const b = t.join('小潔')
    const woken = setup('w')
    woken.clients.set(a.conn, a.client)
    woken.host.restore(ROOM, t.saved.rev, t.saved.sessions, [{ conn: a.conn, openedAt: 0 }])
    expect(a.client.received.at(-1)).toEqual({
      t: 'patch',
      rev: 3,
      ops: [{ op: 'set', path: ['members', b.id, 'reconnecting'], value: true }],
    })
    woken.tick(RECONNECT_GRACE_MS + 1)
    woken.host.heartbeat(a.conn, woken.now())
    expect(woken.host.sweep()).toBe(1)
    expect(Object.keys(a.client.view!.members)).toEqual([a.id])
  })

  it('restores a room that was never created as not existing', () => {
    t.host.restore(null, 0, [], [])
    expect(t.host.exists).toBe(false)
    expect(t.host.admit(V)).toMatchObject({ code: CloseCode.roomNotFound })
  })
})

describe('RoomHost media (e2-t03) and usage (e11-t13)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  const tracksMessage = (sessionId: string, tracks: { trackName: string; kind: string }[]) =>
    JSON.stringify({ t: 'tracks', sessionId, tracks })
  const statsMessage = (sessionId: string, bytesReceived: number) =>
    JSON.stringify({ t: 'stats', sessionId, bytesReceived })

  it('serves the SFU proxy only for a member, and only for its own session', () => {
    const a = t.join('Gene')
    const b = t.join('Wei')
    expect(t.host.sfuAccess('x'.repeat(43), null, [])).toEqual({
      ok: false,
      reason: 'unauthorized',
    })
    expect(t.host.sfuAccess(a.token, null, [])).toEqual({ ok: true, memberId: a.id, pulls: [] })
    // No session bound yet
    expect(t.host.sfuAccess(a.token, 'sess-a', [])).toEqual({ ok: false, reason: 'forbidden' })
    expect(t.host.bindSfu(a.token, 'sess-a')).toBe(true)
    expect(t.host.bindSfu(b.token, 'sess-b')).toBe(true)
    expect(t.host.sfuAccess(a.token, 'sess-a', [])).toMatchObject({ ok: true })
    expect(t.host.sfuAccess(a.token, 'sess-b', [])).toEqual({ ok: false, reason: 'forbidden' })
    expect(t.host.bindSfu('y'.repeat(43), 'sess-z')).toBe(false)
    // A member who left is nobody
    t.host.message(a.conn, JSON.stringify({ t: 'leave' }))
    expect(t.host.sfuAccess(a.token, 'sess-a', [])).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('lets a member pull only tracks published in this room', () => {
    const a = t.join('Gene')
    const b = t.join('Wei')
    t.host.bindSfu(a.token, 'sess-a')
    t.host.bindSfu(b.token, 'sess-b')
    t.host.message(
      b.conn,
      tracksMessage('sess-b', [
        { trackName: 'mic-1', kind: 'mic' },
        { trackName: 'cam-1', kind: 'cam' },
      ]),
    )
    expect(
      t.host.sfuAccess(a.token, 'sess-a', [
        { sessionId: 'sess-b', trackName: 'cam-1' },
        { sessionId: 'sess-b', trackName: 'mic-1' },
      ]),
    ).toEqual({ ok: true, memberId: a.id, pulls: ['cam', 'mic'] })
    for (const ref of [
      { sessionId: 'sess-b', trackName: 'cam-2' },
      { sessionId: 'elsewhere', trackName: 'cam-1' },
    ]) {
      expect(t.host.sfuAccess(a.token, 'sess-a', [ref])).toEqual({
        ok: false,
        reason: 'not_found',
      })
    }
  })

  it('lists what each member publishes and pushes it to everyone', () => {
    const a = t.join('Gene')
    const b = t.join('Wei')
    t.host.bindSfu(b.token, 'sess-b')
    t.host.message(b.conn, tracksMessage('sess-b', [{ trackName: 'mic-1', kind: 'mic' }]))
    const listed = [{ sessionId: 'sess-b', trackName: 'mic-1', kind: 'mic' }]
    expect(a.client.view!.members[b.id].tracks).toEqual(listed)
    expect(b.client.view!.members[b.id].tracks).toEqual(listed)
    expect(t.saved.sessions.find((r) => r.member.id === b.id)).toMatchObject({ sfu: 'sess-b' })
    // A list for another session (sent before a reload) changes nothing
    const before = a.client.received.length
    t.host.message(b.conn, tracksMessage('sess-old', [{ trackName: 'cam-9', kind: 'cam' }]))
    expect(a.client.received).toHaveLength(before)
    // A new session (a reload) drops the old session's tracks at once
    t.host.bindSfu(b.token, 'sess-b2')
    expect(a.client.view!.members[b.id].tracks).toEqual([])
    // Leaving takes the tracks along
    t.host.message(b.conn, tracksMessage('sess-b2', [{ trackName: 'cam-2', kind: 'cam' }]))
    expect(a.client.view!.members[b.id].tracks).toHaveLength(1)
    t.host.message(b.conn, JSON.stringify({ t: 'leave' }))
    expect(a.client.view!.members[b.id]).toBeUndefined()
  })

  it('refuses track lists before join like any other message', () => {
    const socket = t.open()
    t.host.message(socket.conn, tracksMessage('s', []))
    expect(socket.client.received).toEqual([{ t: 'error', code: 'bad_message' }])
  })

  it('keeps the bound session across the object being evicted', () => {
    const a = t.join('Gene')
    t.host.bindSfu(a.token, 'sess-a')
    const woken = setup()
    woken.host.restore(ROOM, t.saved.rev, t.saved.sessions, [{ conn: a.conn, openedAt: 0 }])
    expect(woken.host.sfuAccess(a.token, 'sess-a', [])).toMatchObject({ ok: true })
  })

  it('estimates egress from the tracks every connected member receives', () => {
    const a = t.join('Gene')
    t.join('Wei')
    const c = t.join('Lin')
    t.host.takeUsage()
    t.host.bindSfu(a.token, 'sess-a')
    t.host.message(
      a.conn,
      tracksMessage('sess-a', [
        { trackName: 'mic-1', kind: 'mic' },
        { trackName: 'cam-1', kind: 'cam' },
      ]),
    )
    t.tick(15_000)
    // Wei and Lin each receive Gene's microphone and camera; Gene receives nothing
    const perReceiver = ((ASSUMED_BITRATE.mic + ASSUMED_BITRATE.cam) / 8) * 15
    expect(t.host.takeUsage()).toEqual({ clientBytes: 0, estimateBytes: 2 * perReceiver })
    expect(t.saved.usage).toEqual({ at: t.now(), state: 'normal' })
    // A reconnecting member receives nothing
    t.host.closed(c.conn)
    t.tick(15_000)
    expect(t.host.takeUsage().estimateBytes).toBe(perReceiver)
    // A long gap (the room sat empty, or was evicted) counts at most MAX_USAGE_GAP_MS
    t.tick(10 * MAX_USAGE_GAP_MS)
    expect(t.host.takeUsage().estimateBytes).toBe((perReceiver * MAX_USAGE_GAP_MS) / 15_000)
  })

  it('counts what browsers report, from a baseline, clamped to a plausible rate', () => {
    const a = t.join('Gene')
    t.host.bindSfu(a.token, 'sess-a')
    t.tick(10_000)
    t.host.message(a.conn, statsMessage('sess-a', 1_000_000))
    t.tick(10_000)
    t.host.message(a.conn, statsMessage('sess-a', 3_000_000))
    // Another session's report, and a counter that went backwards, add nothing
    t.host.message(a.conn, statsMessage('sess-x', 9_000_000))
    t.host.message(a.conn, statsMessage('sess-a', 2_000_000))
    expect(t.host.takeUsage().clientBytes).toBe(3_000_000)
    expect(t.host.takeUsage().clientBytes).toBe(0)
    // 10 GB in 10 seconds is not a camera: clamped to MAX_REPORTED_BITRATE
    t.tick(10_000)
    t.host.message(a.conn, statsMessage('sess-a', 2_000_000 + 10_000_000_000))
    expect(t.host.takeUsage().clientBytes).toBe((MAX_REPORTED_BITRATE / 8) * 10)
  })

  it('only takes a baseline from the first report after being evicted', () => {
    const a = t.join('Gene')
    t.host.bindSfu(a.token, 'sess-a')
    const woken = setup()
    woken.host.restore(ROOM, t.saved.rev, t.saved.sessions, [{ conn: a.conn, openedAt: 0 }])
    woken.host.message(a.conn, statsMessage('sess-a', 5_000_000))
    expect(woken.host.takeUsage().clientBytes).toBe(0)
    woken.tick(10_000)
    woken.host.message(a.conn, statsMessage('sess-a', 6_000_000))
    expect(woken.host.takeUsage().clientBytes).toBe(1_000_000)
  })

  it('tells everyone the month state, and remembers it', () => {
    const a = t.join('Gene')
    t.host.setUsage('low')
    expect(a.client.view!.usage).toBe('low')
    expect(t.saved.usage).toMatchObject({ state: 'low' })
    const before = a.client.received.length
    t.host.setUsage('low')
    expect(a.client.received).toHaveLength(before)
    const woken = setup()
    woken.host.restore(ROOM, t.saved.rev, t.saved.sessions, [], t.saved.usage)
    expect(woken.host.view().usage).toBe('low')
    expect(woken.host.usageState).toBe('low')
  })
})
