import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  EMPTY_ROOM_TTL_MS,
  HOST_HANDOFF_MS,
  JOIN_TIMEOUT_MS,
  MAX_MEMBERS,
  MAX_PENDING_SOCKETS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  STALE_AFTER_MS,
  SWEEP_INTERVAL_MS,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { ASSUMED_BITRATE, MAX_REPORTED_BITRATE, RELAY_OVERHEAD } from '../../shared/usage.ts'
import {
  MAX_USAGE_GAP_MS,
  RoomHost,
  type SessionRecord,
  type UsageCursor,
} from '../../worker/room-host.ts'
import type { Schedule } from '../../worker/scheduler.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }
/** ROOM as created, before anyone joined */
const INFO = { ...ROOM, name: null, createdBy: null, startedAt: null, share: null }

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
    schedule: {} as Schedule,
    cleared: 0,
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
      saveSchedule: (schedule) => {
        saved.schedule = schedule
      },
      clear: () => {
        saved.cleared++
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

const member = (
  id: string,
  name: string,
  joinedAt: number,
  reconnecting = false,
  role: 'host' | 'participant' = 'participant',
) => ({
  id,
  name,
  role,
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
    expect(t.saved.room).toEqual(INFO)
    expect(t.host.view()).toEqual({ room: INFO, members: {}, usage: 'normal' })
    expect(t.host.summary()).toEqual({ ...INFO, memberCount: 0 })
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
        state: {
          room: { ...INFO, createdBy: '小潔', startedAt: t.now() },
          members: { m1: member('m1', '小潔', t.now(), false, 'host') },
          usage: 'normal',
        },
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
        member: member(a.id, 'Gene', t.now(), false, 'host'),
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
        member: member(a.id, 'Gene', t.now() - 10, true, 'host'),
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
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [
      { conn: a.conn, openedAt: 0 },
    ])
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

  const tracksMessage = (
    sessionId: string,
    tracks: { trackName: string; kind: string; muted?: boolean }[],
  ) =>
    JSON.stringify({
      t: 'tracks',
      sessionId,
      tracks: tracks.map((track) => ({ muted: false, ...track })),
    })
  const statsMessage = (sessionId: string, bytesReceived: number, relay = false) =>
    JSON.stringify({ t: 'stats', sessionId, bytesReceived, relay })

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
    const listed = [{ sessionId: 'sess-b', trackName: 'mic-1', kind: 'mic', muted: false }]
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

  it('syncs mute through the track list without changing the tracks (e2-t05)', () => {
    const a = t.join('Gene')
    const b = t.join('Wei')
    t.host.bindSfu(b.token, 'sess-b')
    const tracks = [
      { trackName: 'mic-1', kind: 'mic' },
      { trackName: 'cam-1', kind: 'cam' },
    ]
    t.host.message(b.conn, tracksMessage('sess-b', tracks))
    t.host.message(
      b.conn,
      tracksMessage('sess-b', [
        { ...tracks[0], muted: true },
        { ...tracks[1], muted: false },
      ]),
    )
    expect(a.client.view!.members[b.id].tracks).toEqual([
      { sessionId: 'sess-b', trackName: 'mic-1', kind: 'mic', muted: true },
      { sessionId: 'sess-b', trackName: 'cam-1', kind: 'cam', muted: false },
    ])
    // Only the flag changed: one small patch, and the same tracks can still be pulled
    const patch = a.client.received.at(-1)
    expect(patch).toMatchObject({ t: 'patch' })
    expect(t.host.sfuAccess(a.token, null, [{ sessionId: 'sess-b', trackName: 'mic-1' }])).toEqual({
      ok: true,
      memberId: a.id,
      pulls: ['mic'],
    })
    // The same state again sends nothing
    const before = a.client.received.length
    t.host.message(
      b.conn,
      tracksMessage('sess-b', [
        { ...tracks[0], muted: true },
        { ...tracks[1], muted: false },
      ]),
    )
    expect(a.client.received).toHaveLength(before)
  })

  it('keeps tracks stored by protocol v3 (no `muted`) as unmuted', () => {
    const a = t.join('Gene')
    t.host.bindSfu(a.token, 'sess-a')
    t.host.message(a.conn, tracksMessage('sess-a', [{ trackName: 'mic-1', kind: 'mic' }]))
    const stored = t.saved.sessions.map((record) => ({
      ...record,
      member: {
        ...record.member,
        tracks: record.member.tracks.map(({ sessionId, trackName, kind }) => ({
          sessionId,
          trackName,
          kind,
        })),
      },
    })) as unknown as typeof t.saved.sessions
    const woken = setup()
    woken.host.restore(ROOM, t.saved.rev, stored, [{ conn: a.conn, openedAt: 0 }])
    expect(woken.host.view().members[a.id].tracks).toEqual([
      { sessionId: 'sess-a', trackName: 'mic-1', kind: 'mic', muted: false },
    ])
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
    // A muted camera sends nothing
    t.host.message(
      a.conn,
      tracksMessage('sess-a', [
        { trackName: 'mic-1', kind: 'mic' },
        { trackName: 'cam-1', kind: 'cam', muted: true },
      ]),
    )
    t.tick(15_000)
    expect(t.host.takeUsage().estimateBytes).toBe(2 * (ASSUMED_BITRATE.mic / 8) * 15)
    t.host.message(
      a.conn,
      tracksMessage('sess-a', [
        { trackName: 'mic-1', kind: 'mic' },
        { trackName: 'cam-1', kind: 'cam' },
      ]),
    )
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

  it('counts a member receiving through TURN with the relay overhead (e2-t07)', () => {
    const a = t.join('Gene')
    const b = t.join('Wei')
    t.host.bindSfu(a.token, 'sess-a')
    t.host.bindSfu(b.token, 'sess-b')
    t.host.message(a.conn, tracksMessage('sess-a', [{ trackName: 'cam-1', kind: 'cam' }]))
    t.host.message(b.conn, tracksMessage('sess-b', [{ trackName: 'cam-2', kind: 'cam' }]))
    t.host.takeUsage()
    const perReceiver = (ASSUMED_BITRATE.cam / 8) * 10
    // Wei says its media goes through TURN: its share of the estimate and its report grow
    t.host.message(b.conn, statsMessage('sess-b', 1_000_000, true))
    t.tick(10_000)
    t.host.message(b.conn, statsMessage('sess-b', 2_000_000, true))
    expect(t.host.takeUsage()).toEqual({
      clientBytes: Math.round(2_000_000 * RELAY_OVERHEAD),
      estimateBytes: Math.round(perReceiver + perReceiver * RELAY_OVERHEAD),
    })
    // Back on a direct path: counted as before
    t.host.message(b.conn, statsMessage('sess-b', 2_500_000, false))
    t.tick(10_000)
    expect(t.host.takeUsage()).toEqual({ clientBytes: 500_000, estimateBytes: 2 * perReceiver })
    // A report for another session does not change it
    t.host.message(b.conn, statsMessage('sess-x', 0, true))
    t.tick(10_000)
    expect(t.host.takeUsage().estimateBytes).toBe(2 * perReceiver)
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

describe('RoomHost lifecycle (e1-t04): one alarm, empty-room close, host handoff', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  /**
   * Plays the alarm the way RoomDO does until `until`: jumps the clock to each due time, reports
   * a heartbeat for every connection in `alive`, and runs what is due
   */
  function runAlarms(until: number, alive: string[] = []) {
    const results = []
    for (let next = t.host.nextAlarm(); next !== null && next <= until; next = t.host.nextAlarm()) {
      t.tick(Math.max(next - t.now(), 0))
      for (const conn of alive) t.host.heartbeat(conn, t.now())
      results.push({ at: t.now(), ...t.host.alarm() })
    }
    t.tick(Math.max(until - t.now(), 0))
    return results
  }

  const roles = (view: RoomView | null) =>
    Object.fromEntries(Object.values(view!.members).map((m) => [m.name, m.role]))

  it('closes a room nobody joins, EMPTY_ROOM_TTL_MS after it was created', () => {
    const created = t.now()
    expect(t.host.nextAlarm()).toBe(created + EMPTY_ROOM_TTL_MS)
    expect(runAlarms(created + EMPTY_ROOM_TTL_MS - 1)).toEqual([])
    expect(t.host.exists).toBe(true)
    expect(runAlarms(created + EMPTY_ROOM_TTL_MS)).toEqual([
      { at: created + EMPTY_ROOM_TTL_MS, swept: false, closed: true },
    ])
    expect(t.saved.cleared).toBe(1)
    expect(t.host.exists).toBe(false)
    expect(t.host.summary()).toBeNull()
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomNotFound })
    expect(t.host.nextAlarm()).toBeNull()
  })

  it('sweeps while anyone is in, once more after, then closes 10 minutes after the last one left', () => {
    const a = t.join('Gene')
    const start = t.now()
    // Someone is in: the sweep, no close
    expect(t.saved.schedule).toEqual({ sweep: start + SWEEP_INTERVAL_MS })
    const sweeps = runAlarms(start + 3 * SWEEP_INTERVAL_MS, [a.conn])
    expect(sweeps.map((r) => r.at)).toEqual([1, 2, 3].map((n) => start + n * SWEEP_INTERVAL_MS))
    expect(sweeps.every((r) => r.swept && !r.closed)).toBe(true)
    t.tick(1000)
    t.host.heartbeat(a.conn, t.now())
    t.host.message(a.conn, '{"t":"leave"}')
    const left = t.now()
    // The last sweep (it flushes the usage) is still due; then only the close
    expect(t.saved.schedule).toEqual({
      sweep: start + 4 * SWEEP_INTERVAL_MS,
      close: left + EMPTY_ROOM_TTL_MS,
    })
    expect(runAlarms(left + EMPTY_ROOM_TTL_MS)).toEqual([
      { at: start + 4 * SWEEP_INTERVAL_MS, swept: true, closed: false },
      { at: left + EMPTY_ROOM_TTL_MS, swept: false, closed: true },
    ])
    expect(t.host.exists).toBe(false)
  })

  it('keeps the room while someone is reconnecting, and counts the 10 minutes from when they are gone', () => {
    const a = t.join('Gene')
    const joined = t.now()
    t.host.closed(a.conn)
    expect(t.saved.schedule.close).toBeUndefined()
    // The first sweep past the grace removes the member
    runAlarms(joined + RECONNECT_GRACE_MS + SWEEP_INTERVAL_MS)
    expect(t.host.memberCount).toBe(0)
    const removedAt =
      joined + (Math.floor(RECONNECT_GRACE_MS / SWEEP_INTERVAL_MS) + 1) * SWEEP_INTERVAL_MS
    expect(t.saved.schedule.close).toBe(removedAt + EMPTY_ROOM_TTL_MS)
  })

  it('does not close a room someone came back to before the 10 minutes ran out', () => {
    const a = t.join('Gene')
    t.host.message(a.conn, '{"t":"leave"}')
    const left = t.now()
    t.tick(EMPTY_ROOM_TTL_MS - 1000)
    const b = t.join('小潔')
    expect(t.saved.schedule.close).toBeUndefined()
    const results = runAlarms(left + 2 * EMPTY_ROOM_TTL_MS, [b.conn])
    expect(results.some((r) => r.closed)).toBe(false)
    expect(t.host.exists).toBe(true)
    // A socket that has not joined yet also keeps the room open
    t.host.message(b.conn, '{"t":"leave"}')
    const pending = t.open()
    expect(t.saved.schedule.close).toBeUndefined()
    t.host.closed(pending.conn)
    expect(t.saved.schedule.close).toBe(t.now() + EMPTY_ROOM_TTL_MS)
  })

  it('makes the first member the host, and hands it on at once when the host leaves', () => {
    const a = t.join('Gene')
    t.tick(5)
    const b = t.join('小潔')
    t.tick(5)
    const c = t.join('阿明')
    expect(roles(c.client.view)).toEqual({ Gene: 'host', 小潔: 'participant', 阿明: 'participant' })
    t.host.message(a.conn, '{"t":"leave"}')
    // The earliest-joined connected member takes over
    expect(roles(b.client.view)).toEqual({ 小潔: 'host', 阿明: 'participant' })
    expect(c.client.view).toEqual(b.client.view)
  })

  it('hands the host on after HOST_HANDOFF_MS reconnecting, and not back when it returns', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(a.conn)
    const dropped = t.now()
    expect(t.saved.schedule.handoff).toBe(dropped + HOST_HANDOFF_MS)
    // One alarm: the earliest job
    expect(t.host.nextAlarm()).toBe(dropped + SWEEP_INTERVAL_MS)
    runAlarms(dropped + HOST_HANDOFF_MS - 1, [b.conn])
    expect(roles(b.client.view)).toEqual({ Gene: 'host', 小潔: 'participant' })
    runAlarms(dropped + HOST_HANDOFF_MS, [b.conn])
    expect(roles(b.client.view)).toEqual({ Gene: 'participant', 小潔: 'host' })
    expect(t.saved.schedule.handoff).toBeUndefined()
    // Gene comes back (still within the reconnect grace) as a participant
    const back = t.join('Gene', a.token)
    expect(back.id).toBe(a.id)
    expect(roles(back.client.view)).toEqual({ Gene: 'participant', 小潔: 'host' })
  })

  it('keeps the host who comes back within HOST_HANDOFF_MS', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(a.conn)
    t.tick(HOST_HANDOFF_MS - 1000)
    t.host.heartbeat(b.conn, t.now())
    const back = t.join('Gene', a.token)
    expect(t.saved.schedule.handoff).toBeUndefined()
    runAlarms(t.now() + 2 * HOST_HANDOFF_MS, [back.conn, b.conn])
    expect(roles(b.client.view)).toEqual({ Gene: 'host', 小潔: 'participant' })
  })

  it('leaves the role with a reconnecting host while nobody else is connected', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(a.conn)
    t.host.closed(b.conn)
    // Nobody could take over: no handoff job
    expect(t.saved.schedule.handoff).toBeUndefined()
    t.tick(HOST_HANDOFF_MS + 1000)
    // 小潔 comes back first, after the host's minute ran out: she takes over
    const back = t.join('小潔', b.token)
    expect(roles(back.client.view)).toEqual({ Gene: 'participant', 小潔: 'host' })
  })

  it('gives a room whose host left to whoever connects next', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(b.conn)
    t.host.message(a.conn, '{"t":"leave"}')
    // Only 小潔 is left, reconnecting: no host for now
    expect(Object.values(t.host.view().members).map((m) => m.role)).toEqual(['participant'])
    const back = t.join('小潔', b.token)
    expect(roles(back.client.view)).toEqual({ 小潔: 'host' })
  })

  it('stores the schedule and picks it up again after the object is evicted', () => {
    const a = t.join('Gene')
    t.join('小潔')
    t.host.closed(a.conn)
    const woken = setup('w')
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [], null, {
      ...t.saved.schedule,
    })
    expect(woken.host.nextAlarm()).toBe(t.host.nextAlarm())
  })

  it('gives a room stored before C2 a host, a schedule and the new room fields', () => {
    const a = t.join('Gene')
    t.tick(5)
    const b = t.join('小潔')
    // As protocol v5 stored them: no role, no room name
    const old = t.saved.sessions.map((s) => {
      const { role: _role, ...member } = s.member
      return { ...s, member } as unknown as SessionRecord
    })
    const woken = setup('w')
    woken.clients.set(a.conn, a.client)
    woken.clients.set(b.conn, b.client)
    woken.host.restore(ROOM, t.saved.rev, old, [
      { conn: a.conn, openedAt: woken.now() },
      { conn: b.conn, openedAt: woken.now() },
    ])
    expect(woken.host.view().room).toEqual(INFO)
    expect(roles(woken.host.view())).toEqual({ Gene: 'host', 小潔: 'participant' })
    expect(woken.host.nextAlarm()).toBe(woken.now() + SWEEP_INTERVAL_MS)
  })
})

describe('RoomHost names (e1-t05)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  it('names the default after the first member and starts the clock when they join', () => {
    t.tick(30_000)
    const a = t.join('Gene')
    const joined = t.now()
    t.tick(5)
    t.join('小潔')
    expect(a.client.view!.room).toEqual({ ...INFO, createdBy: 'Gene', startedAt: joined })
    expect(t.saved.room).toEqual(a.client.view!.room)
  })

  it('lets a member rename themselves', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.message(b.conn, JSON.stringify({ t: 'rename', name: '  小潔 2  ' }))
    expect(a.client.view!.members[b.id].name).toBe('小潔 2')
    t.host.message(b.conn, JSON.stringify({ t: 'rename', name: '   ' }))
    expect(b.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    expect(a.client.view!.members[b.id].name).toBe('小潔 2')
  })

  it('lets the host rename the room, and nobody else', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.message(a.conn, JSON.stringify({ t: 'renameRoom', name: ' 週五聊天 ' }))
    expect(b.client.view!.room.name).toBe('週五聊天')
    expect((t.saved.room as RoomInfo).name).toBe('週五聊天')
    t.host.message(b.conn, JSON.stringify({ t: 'renameRoom', name: '小潔的房間' }))
    expect(b.client.received.at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    expect(a.client.view!.room.name).toBe('週五聊天')
    // Too long for a room name
    t.host.message(a.conn, JSON.stringify({ t: 'renameRoom', name: 'x'.repeat(61) }))
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
  })

  it('lets the new host rename the room after a handoff', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.message(a.conn, '{"t":"leave"}')
    t.host.message(b.conn, JSON.stringify({ t: 'renameRoom', name: '接手了' }))
    expect(b.client.view!.room.name).toBe('接手了')
  })
})

describe('RoomHost screen share (e3-t02): one sharer, take-over, host stop', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  const share = (conn: string, takeOver = false) =>
    t.host.message(conn, JSON.stringify({ t: 'share', takeOver }))
  const tracks = (conn: string, sessionId: string, kinds: string[]) =>
    t.host.message(
      conn,
      JSON.stringify({
        t: 'tracks',
        sessionId,
        tracks: kinds.map((kind) => ({ trackName: `${kind}-1`, kind, muted: false })),
      }),
    )
  const kinds = (view: RoomView | null, id: string) =>
    view!.members[id].tracks.map((track) => track.kind)
  /** Three members with SFU sessions; Gene is the host */
  function three() {
    const a = t.join('Gene')
    const b = t.join('小潔')
    const c = t.join('阿明')
    t.host.bindSfu(a.token, 'sa')
    t.host.bindSfu(b.token, 'sb')
    t.host.bindSfu(c.token, 'sc')
    return { a, b, c }
  }

  it('grants the share to the first member who asks, and tells everyone', () => {
    const { a, b } = three()
    t.tick(7)
    share(b.conn)
    const granted = { memberId: b.id, since: t.now() }
    expect(a.client.view!.room.share).toEqual(granted)
    expect((t.saved.room as RoomInfo).share).toEqual(granted)
    tracks(b.conn, 'sb', ['mic', 'cam', 'screen'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic', 'cam', 'screen'])
    // Asking again changes nothing (a resend after a reconnect)
    const before = a.client.received.length
    share(b.conn)
    expect(a.client.received).toHaveLength(before)
  })

  it('refuses a second sharer with share_busy unless they confirmed taking over', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    share(c.conn)
    expect(c.client.received.at(-1)).toEqual({ t: 'error', code: 'share_busy' })
    expect(a.client.view!.room.share?.memberId).toBe(b.id)
    // Confirmed: the share moves in one patch, and the previous sharer's screen goes with it
    const rev = a.client.rev
    share(c.conn, true)
    expect(a.client.rev).toBe(rev + 1)
    expect(a.client.view!.room.share?.memberId).toBe(c.id)
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])
  })

  it('drops a screen listed by a member who does not hold the share', () => {
    const { a, b, c } = three()
    tracks(b.conn, 'sb', ['mic', 'screen'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])
    share(b.conn)
    share(c.conn, true)
    // B's list from before it saw the take-over must not bring its screen back
    tracks(b.conn, 'sb', ['mic', 'screen', 'screenAudio'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])
  })

  it('ends the share on unshare, on leave, and once the sharer is gone for good', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    // Someone else's unshare does nothing
    t.host.message(c.conn, '{"t":"unshare"}')
    expect(a.client.view!.room.share?.memberId).toBe(b.id)
    t.host.message(b.conn, '{"t":"unshare"}')
    expect(a.client.view!.room.share).toBeNull()
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])

    share(c.conn)
    t.host.message(c.conn, '{"t":"leave"}')
    expect(a.client.view!.room.share).toBeNull()

    share(b.conn)
    // Reconnecting keeps the share; gone for RECONNECT_GRACE_MS ends it
    t.host.closed(b.conn)
    expect(a.client.view!.room.share?.memberId).toBe(b.id)
    t.tick(RECONNECT_GRACE_MS + SWEEP_INTERVAL_MS)
    t.host.message(a.conn, 'ping')
    t.host.sweep()
    expect(a.client.view!.members[b.id]).toBeUndefined()
    expect(a.client.view!.room.share).toBeNull()
  })

  it('keeps the share across the object being evicted', () => {
    const { a, b } = three()
    share(b.conn)
    const woken = setup('w')
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [
      { conn: a.conn, openedAt: woken.now() },
      { conn: b.conn, openedAt: woken.now() },
    ])
    expect(woken.host.view().room.share?.memberId).toBe(b.id)
    // A stored share whose member is gone is dropped
    const stale = setup('s')
    stale.host.restore({ ...INFO, share: { memberId: 'nobody', since: 1 } }, 3, [], [])
    expect(stale.host.view().room.share).toBeNull()
  })

  it('lets the host stop anyone’s share (the entry point F1 puts on the wire), nobody else', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    expect(t.host.stopShare(c.id, b.id)).toBe(false)
    expect(t.host.stopShare(a.id, c.id)).toBe(false)
    expect(a.client.view!.room.share?.memberId).toBe(b.id)
    expect(t.host.stopShare(a.id, b.id)).toBe(true)
    expect(c.client.view!.room.share).toBeNull()
    expect(kinds(c.client.view, b.id)).toEqual(['mic'])
  })

  it('refuses to start a share in an audio-only month', () => {
    const { a, b } = three()
    t.host.setUsage('audioOnly')
    share(b.conn)
    expect(b.client.received.at(-1)).toEqual({ t: 'error', code: 'audio_only' })
    expect(a.client.view!.room.share).toBeNull()
  })

  it('refuses a share message of the wrong shape', () => {
    const { b } = three()
    t.host.message(b.conn, JSON.stringify({ t: 'share' }))
    expect(b.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
  })
})
