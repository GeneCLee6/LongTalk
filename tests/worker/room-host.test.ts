import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_CHUNK, CHAT_HISTORY, CHAT_RATE, type ChatMessage } from '../../shared/chat.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  BAN_MS,
  CloseCode,
  DENY_COOLDOWN_MS,
  EMPTY_ROOM_TTL_MS,
  ENDED_TOMBSTONE_MS,
  HOST_HANDOFF_MS,
  JOIN_TIMEOUT_MS,
  MAX_MEMBERS,
  MAX_PENDING_SOCKETS,
  MAX_SHARES,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  STALE_AFTER_MS,
  SWEEP_INTERVAL_MS,
  WAIT_TIMEOUT_MS,
  shareOrder,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { ASSUMED_BITRATE, MAX_REPORTED_BITRATE, RELAY_OVERHEAD } from '../../shared/usage.ts'
import {
  MAX_USAGE_GAP_MS,
  RoomHost,
  type Ban,
  type SessionRecord,
  type UsageCursor,
} from '../../worker/room-host.ts'
import type { Schedule } from '../../worker/scheduler.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }
/** ROOM as created, before anyone joined */
const INFO = {
  ...ROOM,
  name: null,
  createdBy: null,
  startedAt: null,
  shares: {},
  locked: false,
  waitingRoom: false,
  passwordSetAt: null,
  spotlight: null,
  persistent: false,
  recordings: {},
  annotationPolicy: 'everyone' as const,
  whiteboard: null,
}

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
    chat: new Map<number, ChatMessage>(),
    bans: [] as Ban[],
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
      saveChat: (message) => {
        saved.chat.set(message.id, structuredClone(message))
      },
      dropChat: (id) => {
        saved.chat.delete(id)
      },
      saveBans: (bans) => {
        saved.bans = structuredClone(bans)
      },
      savePassword: () => {},
      saveGuesses: () => {},
      saveEnded: () => {},
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
  hand: null,
  signal: null,
  mayRecord: false,
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
    expect(t.host.view()).toEqual({ room: INFO, members: {}, waiting: {}, usage: 'normal' })
    expect(t.host.summary()).toEqual({ ...INFO, memberCount: 0, owner: false })
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
          waiting: {},
          usage: 'normal',
        },
      },
      // The chat history follows every welcome (D3), even when there is none yet
      { t: 'chat', messages: [], reset: true },
      // And the strokes on the shares (J2)
      { t: 'annotations', share: null, strokes: [], reset: true, done: true },
    ])
    expect(t.host.summary()).toMatchObject({ memberCount: 1 })
  })

  it('welcomes a newcomer with the whole room and patches everyone else', () => {
    t.host.create(ROOM)
    const a = t.join('Gene')
    t.tick(5)
    const b = t.join('小潔')
    expect(a.client.received[3]).toEqual({
      t: 'patch',
      rev: 2,
      ops: [{ op: 'set', path: ['members', b.id], value: member(b.id, '小潔', t.now()) }],
    })
    expect(b.client.received).toHaveLength(3)
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
        client: null,
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
        client: null,
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

describe('RoomHost screen shares (e3-t02, e3-t07): up to MAX_SHARES at once, host stop', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  const share = (conn: string) => t.host.message(conn, JSON.stringify({ t: 'share' }))
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
  const sharers = (view: RoomView | null) => shareOrder(view!.room.shares).map((s) => s.memberId)
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

  it('grants the share to a member who asks, and tells everyone', () => {
    const { a, b } = three()
    t.tick(7)
    share(b.conn)
    const granted = { memberId: b.id, since: t.now() }
    expect(a.client.view!.room.shares).toEqual({ [b.id]: granted })
    expect((t.saved.room as RoomInfo).shares).toEqual({ [b.id]: granted })
    tracks(b.conn, 'sb', ['mic', 'cam', 'screen'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic', 'cam', 'screen'])
    // Asking again changes nothing (a resend after a reconnect)
    const before = a.client.received.length
    share(b.conn)
    expect(a.client.received).toHaveLength(before)
  })

  it('lets several members share at once, in the order they started', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    t.tick(5)
    share(c.conn)
    tracks(c.conn, 'sc', ['mic', 'screen', 'screenAudio'])
    expect(sharers(a.client.view)).toEqual([b.id, c.id])
    // Nobody's screen was taken away
    expect(kinds(a.client.view, b.id)).toEqual(['mic', 'screen'])
    expect(kinds(a.client.view, c.id)).toEqual(['mic', 'screen', 'screenAudio'])
    expect(b.client.received.some((m) => m.t === 'error')).toBe(false)
    expect(c.client.received.some((m) => m.t === 'error')).toBe(false)
  })

  it('refuses a share past MAX_SHARES with share_full, and grants it once one ends', () => {
    const { a, b, c } = three()
    const d = t.join('小美')
    t.host.bindSfu(d.token, 'sd')
    expect(MAX_SHARES).toBe(3)
    share(a.conn)
    share(b.conn)
    share(c.conn)
    share(d.conn)
    expect(d.client.received.at(-1)).toEqual({ t: 'error', code: 'share_full' })
    expect(sharers(a.client.view)).toEqual([a.id, b.id, c.id])
    t.host.message(b.conn, '{"t":"unshare"}')
    t.tick(1)
    share(d.conn)
    expect(sharers(a.client.view)).toEqual([a.id, c.id, d.id])
  })

  it('drops a screen listed by a member who does not share', () => {
    const { a, b } = three()
    tracks(b.conn, 'sb', ['mic', 'screen'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])
    share(b.conn)
    t.host.stopShare(a.id, b.id)
    // B's list from before it saw the stop must not bring its screen back
    tracks(b.conn, 'sb', ['mic', 'screen', 'screenAudio'])
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])
  })

  it('ends a share on unshare, on leave, and once the sharer is gone for good', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    t.tick(1)
    share(c.conn)
    // An unshare from someone who does not share does nothing
    t.host.message(a.conn, '{"t":"unshare"}')
    expect(sharers(a.client.view)).toEqual([b.id, c.id])
    t.host.message(b.conn, '{"t":"unshare"}')
    expect(sharers(a.client.view)).toEqual([c.id])
    expect(kinds(a.client.view, b.id)).toEqual(['mic'])

    t.host.message(c.conn, '{"t":"leave"}')
    expect(a.client.view!.room.shares).toEqual({})

    share(b.conn)
    // Reconnecting keeps the share; gone for RECONNECT_GRACE_MS ends it
    t.host.closed(b.conn)
    expect(sharers(a.client.view)).toEqual([b.id])
    t.tick(RECONNECT_GRACE_MS + SWEEP_INTERVAL_MS)
    t.host.message(a.conn, 'ping')
    t.host.sweep()
    expect(a.client.view!.members[b.id]).toBeUndefined()
    expect(a.client.view!.room.shares).toEqual({})
  })

  it('keeps the shares across the object being evicted, and reads a room stored before v15', () => {
    const { a, b, c } = three()
    share(b.conn)
    t.tick(1)
    share(c.conn)
    const woken = setup('w')
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [
      { conn: a.conn, openedAt: woken.now() },
      { conn: b.conn, openedAt: woken.now() },
    ])
    expect(sharers(woken.host.view())).toEqual([b.id, c.id])
    // A stored share whose member is gone is dropped
    const stale = setup('s')
    stale.host.restore(
      { ...INFO, shares: { nobody: { memberId: 'nobody', since: 1 } } } as RoomInfo,
      3,
      [],
      [],
    )
    expect(stale.host.view().room.shares).toEqual({})
    // v14 stored one `share`: it becomes the only entry of `shares`
    const old = setup('o')
    const { shares: _none, ...v14 } = t.saved.room as RoomInfo
    old.host.restore(
      { ...v14, share: { memberId: b.id, since: 9 } } as unknown as RoomInfo,
      t.saved.rev,
      t.saved.sessions,
      [{ conn: b.conn, openedAt: old.now() }],
    )
    expect(old.host.view().room.shares).toEqual({ [b.id]: { memberId: b.id, since: 9 } })
    expect('share' in old.host.view().room).toBe(false)
  })

  it('lets the host stop anyone’s share and only that one; nobody else may', () => {
    const { a, b, c } = three()
    share(b.conn)
    tracks(b.conn, 'sb', ['mic', 'screen'])
    t.tick(1)
    share(c.conn)
    tracks(c.conn, 'sc', ['mic', 'screen'])
    expect(t.host.stopShare(c.id, b.id)).toBe(false)
    expect(t.host.stopShare(a.id, a.id)).toBe(false)
    expect(sharers(a.client.view)).toEqual([b.id, c.id])
    expect(t.host.stopShare(a.id, b.id)).toBe(true)
    expect(sharers(c.client.view)).toEqual([c.id])
    expect(kinds(c.client.view, b.id)).toEqual(['mic'])
    expect(kinds(b.client.view, c.id)).toEqual(['mic', 'screen'])
    // A sharer may stop its own
    expect(t.host.stopShare(c.id, c.id)).toBe(true)
    expect(a.client.view!.room.shares).toEqual({})
  })

  it('refuses to start a share in an audio-only month', () => {
    const { a, b } = three()
    t.host.setUsage('audioOnly')
    share(b.conn)
    expect(b.client.received.at(-1)).toEqual({ t: 'error', code: 'audio_only' })
    expect(a.client.view!.room.shares).toEqual({})
  })

  it('takes a share message in a v14 browser’s shape too (takeOver is ignored)', () => {
    const { a, b } = three()
    t.host.message(b.conn, JSON.stringify({ t: 'share', takeOver: true }))
    expect(sharers(a.client.view)).toEqual([b.id])
  })
})

describe('RoomHost chat (e5-t01): history, rate limit, storage', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  const say = (conn: string, text: string) =>
    t.host.message(conn, JSON.stringify({ t: 'chat', text }))
  const chatFrames = (client: FakeClient) =>
    client.received.filter((message) => message.t === 'chat')

  it('sends every message to everyone joined, the sender too, with name, id and time', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    const pending = t.open()
    t.tick(7)
    say(a.conn, '  大家好\r\n連結 https://example.com  ')
    const message: ChatMessage = {
      id: 1,
      from: a.id,
      name: 'Gene',
      text: '大家好\n連結 https://example.com',
      at: t.now(),
    }
    expect(a.client.received.at(-1)).toEqual({ t: 'chat', messages: [message] })
    expect(b.client.received.at(-1)).toEqual({ t: 'chat', messages: [message] })
    // A socket that has not joined hears nothing
    expect(pending.client.received).toEqual([])
    expect([...t.saved.chat.values()]).toEqual([message])
    // Chat never touches the view or its numbering
    expect(t.saved.rev).toBe(2)
  })

  it('refuses empty, too long, or non-string text, and strips control characters', () => {
    const a = t.join('Gene')
    say(a.conn, ' \n\t ')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    say(a.conn, '字'.repeat(2001))
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    t.host.message(a.conn, JSON.stringify({ t: 'chat', text: 42 }))
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    say(a.conn, '字'.repeat(2000))
    expect(a.client.received.at(-1)).toMatchObject({ t: 'chat' })
    say(a.conn, 'a\u0000b\u202Ec\u0007d<b>e</b>')
    // Text, not HTML: angle brackets stay as they are (the browser renders text only)
    expect(t.host.chatHistory.at(-1)!.text).toBe('abcd<b>e</b>')
  })

  it('keeps the name a message was sent under after a rename', () => {
    const a = t.join('Gene')
    say(a.conn, 'before')
    t.host.message(a.conn, JSON.stringify({ t: 'rename', name: 'Gene Lee' }))
    say(a.conn, 'after')
    expect(t.host.chatHistory.map((m) => m.name)).toEqual(['Gene', 'Gene Lee'])
  })

  it(`limits each member to ${CHAT_RATE.count} messages in ${CHAT_RATE.windowMs / 1000} s`, () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    for (let i = 0; i < CHAT_RATE.count; i++) say(a.conn, `m${i}`)
    say(a.conn, 'one too many')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'rate_limited' })
    expect(t.host.chatHistory).toHaveLength(CHAT_RATE.count)
    // Someone else is not held back by it
    say(b.conn, 'mine')
    expect(t.host.chatHistory.at(-1)!.text).toBe('mine')
    // The window slides
    t.tick(CHAT_RATE.windowMs)
    say(a.conn, 'later')
    expect(t.host.chatHistory.at(-1)!.text).toBe('later')
  })

  it(`keeps the latest ${CHAT_HISTORY} messages, in memory and in storage`, () => {
    const a = t.join('Gene')
    for (let i = 1; i <= CHAT_HISTORY + 5; i++) {
      t.tick(CHAT_RATE.windowMs)
      say(a.conn, `message ${i}`)
    }
    expect(t.host.chatHistory).toHaveLength(CHAT_HISTORY)
    expect(t.host.chatHistory[0]).toMatchObject({ id: 6, text: 'message 6' })
    expect(t.host.chatHistory.at(-1)).toMatchObject({ id: CHAT_HISTORY + 5 })
    expect([...t.saved.chat.keys()].sort((x, y) => x - y)).toEqual(
      t.host.chatHistory.map((m) => m.id),
    )
  })

  it('sends a joiner the whole history in chunks after its welcome, the first one resetting', () => {
    const a = t.join('Gene')
    for (let i = 1; i <= CHAT_CHUNK + 3; i++) {
      t.tick(CHAT_RATE.windowMs)
      say(a.conn, `message ${i}`)
    }
    const b = t.join('小潔')
    expect(b.client.received.map((message) => message.t)).toEqual([
      'welcome',
      'chat',
      'chat',
      'annotations',
    ])
    const [first, second] = chatFrames(b.client)
    expect(first).toMatchObject({ reset: true })
    expect(first.t === 'chat' && first.messages).toHaveLength(CHAT_CHUNK)
    expect(second).not.toHaveProperty('reset')
    expect(second.t === 'chat' && second.messages.map((m) => m.text)).toEqual([
      `message ${CHAT_CHUNK + 1}`,
      `message ${CHAT_CHUNK + 2}`,
      `message ${CHAT_CHUNK + 3}`,
    ])
  })

  it('sends the history again after a reconnect, so missed messages arrive', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    t.host.closed(b.conn)
    say(a.conn, 'while you were away')
    const again = t.join('小潔', b.token)
    expect(chatFrames(again.client)).toEqual([
      { t: 'chat', messages: [t.host.chatHistory[0]], reset: true },
    ])
  })

  it('keeps the history across hibernation and eviction, and continues the ids', () => {
    const a = t.join('Gene')
    say(a.conn, 'one')
    say(a.conn, 'two')
    const woken = setup('w')
    woken.host.restore(
      t.saved.room as RoomInfo,
      t.saved.rev,
      t.saved.sessions,
      [{ conn: a.conn, openedAt: 0 }],
      null,
      null,
      // Storage lists them in key order; restore sorts anyway
      [...t.saved.chat.values()].reverse(),
    )
    woken.clients.set(a.conn, a.client)
    expect(woken.host.chatHistory.map((m) => m.text)).toEqual(['one', 'two'])
    const b = woken.join('小潔')
    expect(chatFrames(b.client)[0]).toMatchObject({
      reset: true,
      messages: [{ id: 1 }, { id: 2 }],
    })
    woken.host.message(a.conn, JSON.stringify({ t: 'chat', text: 'three' }))
    expect(woken.host.chatHistory.at(-1)).toMatchObject({ id: 3, text: 'three' })
  })

  it('forgets the chat when the room closes', () => {
    const a = t.join('Gene')
    say(a.conn, 'bye')
    t.host.message(a.conn, JSON.stringify({ t: 'leave' }))
    t.tick(EMPTY_ROOM_TTL_MS + 1)
    t.host.alarm()
    expect(t.host.exists).toBe(false)
    expect(t.host.chatHistory).toEqual([])
    expect(t.saved.cleared).toBe(1)
  })
})

describe('RoomHost host controls (F1, e1-t07)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  /** Joins with this browser's own id (what a ban is on) */
  function joinAs(name: string, client: string | null) {
    const socket = t.open()
    t.host.message(socket.conn, JSON.stringify({ t: 'join', name, token: null, client }))
    const welcome = socket.client.received.find((message) => message.t === 'welcome')
    const id = welcome?.t === 'welcome' ? welcome.you : ''
    const token = welcome?.t === 'welcome' ? welcome.token : ''
    return { ...socket, id, token }
  }
  function publish(who: { conn: string; token: string }, session: string, kinds: string[]) {
    t.host.bindSfu(who.token, session)
    t.host.message(
      who.conn,
      JSON.stringify({
        t: 'tracks',
        sessionId: session,
        tracks: kinds.map((kind) => ({ trackName: `${kind}-1`, kind, muted: false })),
      }),
    )
  }
  /** Gene (the host), 小潔 and 阿明, each publishing an unmuted microphone and camera */
  function three() {
    const a = joinAs('Gene', 'browser-gene-000000')
    const b = joinAs('小潔', 'browser-xiaojie-0000')
    const c = joinAs('阿明', 'browser-aming-000000')
    publish(a, 'sa', ['mic', 'cam'])
    publish(b, 'sb', ['mic', 'cam'])
    publish(c, 'sc', ['mic', 'cam'])
    return { a, b, c }
  }
  const host = (conn: string, action: string, memberId?: string) =>
    t.host.message(conn, JSON.stringify({ t: 'host', action, memberId }))
  const muted = (view: RoomView | null, id: string, kind: string) =>
    view!.members[id].tracks.find((track) => track.kind === kind)?.muted
  const notices = (client: FakeClient) => client.received.filter((m) => m.t === 'notice')
  const forbidden = { t: 'error', code: 'forbidden' }

  it('mutes one member: everyone sees it at once, the member is told who did it', () => {
    const { a, b, c } = three()
    host(a.conn, 'muteMember', b.id)
    expect(muted(c.client.view, b.id, 'mic')).toBe(true)
    expect(muted(c.client.view, b.id, 'cam')).toBe(false)
    expect(notices(b.client)).toEqual([{ t: 'notice', notice: 'muted', by: a.id }])
    expect(notices(c.client)).toEqual([])
    // Already muted: nothing more to tell
    host(a.conn, 'muteMember', b.id)
    expect(notices(b.client)).toHaveLength(1)
    // Only the member turns it back on
    publish(b, 'sb2', ['mic', 'cam'])
    expect(muted(a.client.view, b.id, 'mic')).toBe(false)
  })

  it('refuses every control from a participant, and changes nothing', () => {
    const { a, b, c } = three()
    t.host.message(b.conn, JSON.stringify({ t: 'share' }))
    const before = structuredClone(a.client.view)
    for (const action of ['muteMember', 'camOff', 'stopShare', 'remove']) {
      host(c.conn, action, a.id)
      expect(c.client.received.at(-1)).toEqual(forbidden)
      host(c.conn, action, b.id)
      expect(c.client.received.at(-1)).toEqual(forbidden)
    }
    host(c.conn, 'muteAll')
    expect(c.client.received.at(-1)).toEqual(forbidden)
    host(c.conn, 'endMeeting')
    expect(c.client.received.at(-1)).toEqual(forbidden)
    expect(a.client.view).toEqual(before)
    expect(notices(a.client)).toEqual([])
    expect(notices(b.client)).toEqual([])
    expect(t.host.exists).toBe(true)
  })

  it('refuses a control on oneself or on someone who is not there', () => {
    const { a } = three()
    host(a.conn, 'muteMember', a.id)
    expect(a.client.received.at(-1)).toEqual(forbidden)
    host(a.conn, 'remove', 'nobody')
    expect(a.client.received.at(-1)).toEqual(forbidden)
    expect(a.client.view!.members[a.id]).toBeDefined()
    // A malformed one is not a control at all
    host(a.conn, 'muteMember')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    host(a.conn, 'unmute', a.id)
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
  })

  it('turns a camera off the same way', () => {
    const { a, b } = three()
    host(a.conn, 'camOff', b.id)
    expect(muted(a.client.view, b.id, 'cam')).toBe(true)
    expect(muted(a.client.view, b.id, 'mic')).toBe(false)
    expect(notices(b.client)).toEqual([{ t: 'notice', notice: 'camOff', by: a.id }])
  })

  it('mutes everyone but the host, telling each one who had a microphone on', () => {
    const { a, b, c } = three()
    host(a.conn, 'muteMember', c.id)
    host(a.conn, 'muteAll')
    expect(muted(b.client.view, a.id, 'mic')).toBe(false)
    expect(muted(b.client.view, b.id, 'mic')).toBe(true)
    expect(muted(b.client.view, c.id, 'mic')).toBe(true)
    expect(notices(b.client)).toEqual([{ t: 'notice', notice: 'muted', by: a.id, all: true }])
    // 阿明 was muted already: only the first notice
    expect(notices(c.client)).toEqual([{ t: 'notice', notice: 'muted', by: a.id }])
    expect(notices(a.client)).toEqual([])
  })

  it('stops a share (RoomHost.stopShare on the wire) and tells the sharer', () => {
    const { a, b, c } = three()
    t.host.message(b.conn, JSON.stringify({ t: 'share' }))
    publish(b, 'sb', ['mic', 'cam', 'screen'])
    host(a.conn, 'stopShare', c.id)
    expect(notices(c.client)).toEqual([])
    host(a.conn, 'stopShare', b.id)
    expect(c.client.view!.room.shares).toEqual({})
    expect(c.client.view!.members[b.id].tracks.map((track) => track.kind)).toEqual(['mic', 'cam'])
    expect(notices(b.client)).toEqual([{ t: 'notice', notice: 'shareStopped', by: a.id }])
  })

  it('removes a member: closed with `removed`, gone for everyone, its share with it', () => {
    const { a, b, c } = three()
    t.host.message(b.conn, JSON.stringify({ t: 'share' }))
    host(a.conn, 'remove', b.id)
    expect(b.client.closed).toEqual({ code: CloseCode.removed, reason: 'removed' })
    expect(c.client.view!.members[b.id]).toBeUndefined()
    expect(c.client.view!.room.shares).toEqual({})
    expect(t.host.banList).toEqual([{ client: 'browser-xiaojie-0000', until: t.now() + BAN_MS }])
    expect(t.saved.bans).toEqual(t.host.banList)
    // Its session is over: the SFU proxy no longer knows its token
    expect(t.host.sfuAccess(b.token, 'sb', [])).toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('keeps the removed browser out for BAN_MS, then lets it back in (fake clock)', () => {
    const { a, b } = three()
    host(a.conn, 'remove', b.id)
    // Straight back, as someone new or with the old token: refused
    const again = joinAs('小潔', 'browser-xiaojie-0000')
    expect(again.id).toBe('')
    expect(again.client.closed).toEqual({ code: CloseCode.removed, reason: 'removed' })
    const withToken = t.open()
    t.host.message(
      withToken.conn,
      JSON.stringify({ t: 'join', name: '小潔', token: b.token, client: 'browser-xiaojie-0000' }),
    )
    expect(withToken.client.closed?.code).toBe(CloseCode.removed)
    // Another browser is someone else
    expect(joinAs('小潔', 'browser-other-000000').id).not.toBe('')
    // The ban's expiry is a job of the room's one alarm
    expect(t.saved.schedule.bans).toBe(t.now() + BAN_MS)
    t.tick(BAN_MS - 1)
    expect(joinAs('小潔', 'browser-xiaojie-0000').id).toBe('')
    t.tick(1)
    t.host.message(a.conn, 'ping')
    t.host.alarm()
    expect(t.host.banList).toEqual([])
    expect(t.saved.bans).toEqual([])
    expect(t.saved.schedule.bans).toBeUndefined()
    expect(joinAs('小潔', 'browser-xiaojie-0000').id).not.toBe('')
  })

  it('removes a reconnecting member too: it cannot come back with its token', () => {
    const { a, b } = three()
    t.host.closed(b.conn)
    host(a.conn, 'remove', b.id)
    expect(a.client.view!.members[b.id]).toBeUndefined()
    const back = t.open()
    t.host.message(
      back.conn,
      JSON.stringify({ t: 'join', name: '小潔', token: b.token, client: 'browser-xiaojie-0000' }),
    )
    expect(back.client.closed?.code).toBe(CloseCode.removed)
  })

  it('keeps the bans across the object being evicted', () => {
    const { a, b } = three()
    host(a.conn, 'remove', b.id)
    const woken = setup('w')
    woken.host.restore(
      t.saved.room as RoomInfo,
      t.saved.rev,
      t.saved.sessions,
      [{ conn: a.conn, openedAt: woken.now() }],
      null,
      t.saved.schedule,
      [],
      t.saved.bans,
    )
    expect(woken.host.banList).toEqual(t.host.banList)
  })

  it('ends the meeting: every socket closed with `ended`, the room gone at once', () => {
    const { a, b, c } = three()
    const pending = t.open()
    t.host.message(a.conn, JSON.stringify({ t: 'chat', text: 'bye' }))
    host(a.conn, 'endMeeting')
    for (const client of [a.client, b.client, c.client, pending.client]) {
      expect(client.closed).toEqual({ code: CloseCode.ended, reason: 'ended' })
    }
    expect(t.host.exists).toBe(false)
    expect(t.host.summary()).toBeNull()
    expect(t.host.chatHistory).toEqual([])
    expect(t.saved.cleared).toBe(1)
    // F3: for ENDED_TOMBSTONE_MS a socket opening learns the meeting ended, then it is not found
    expect(t.host.nextAlarm()).toBe(t.now() + ENDED_TOMBSTONE_MS)
    expect(t.host.admit(String(PROTOCOL_VERSION))).toEqual({
      ok: false,
      code: CloseCode.ended,
      reason: 'ended',
    })
    t.tick(ENDED_TOMBSTONE_MS)
    t.host.alarm()
    expect(t.saved.cleared).toBe(2)
    expect(t.host.nextAlarm()).toBeNull()
    expect(t.host.admit(String(PROTOCOL_VERSION))).toEqual({
      ok: false,
      code: CloseCode.roomNotFound,
      reason: 'room not found',
    })
  })

  it('moves the controls with the host role (AC-1.3 handoff)', () => {
    const { a, b, c } = three()
    t.host.message(a.conn, '{"t":"leave"}')
    expect(b.client.view!.members[b.id].role).toBe('host')
    host(c.conn, 'muteMember', b.id)
    expect(c.client.received.at(-1)).toEqual(forbidden)
    host(b.conn, 'muteMember', c.id)
    expect(muted(b.client.view, c.id, 'mic')).toBe(true)
  })
})

describe('RoomHost lock and waiting room (F2, e1-t09, e1-t10)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  /** Joins with this browser's own id; `id` and `token` come from `welcome` or `lobby` */
  function joinAs(name: string, client: string | null = null, token: string | null = null) {
    const socket = t.open()
    t.host.message(socket.conn, JSON.stringify({ t: 'join', name, token, client }))
    const first = socket.client.received.find((m) => m.t === 'welcome' || m.t === 'lobby')
    const id = first?.t === 'welcome' || first?.t === 'lobby' ? first.you : ''
    const tok = first?.t === 'welcome' || first?.t === 'lobby' ? first.token : ''
    return { ...socket, id, token: tok }
  }
  const host = (conn: string, message: Record<string, unknown>) =>
    t.host.message(conn, JSON.stringify({ t: 'host', ...message }))
  const lobbies = (client: FakeClient) => client.received.filter((m) => m.t === 'lobby')
  const lastLobby = (client: FakeClient) => lobbies(client).at(-1)
  const forbidden = { t: 'error', code: 'forbidden' }
  /** Gene (the host) and 小潔 in the room, the waiting room on */
  function room() {
    const a = joinAs('Gene', 'browser-gene-000000')
    const b = joinAs('小潔', 'browser-xiaojie-0000')
    host(a.conn, { action: 'waitingRoom', on: true })
    return { a, b }
  }

  it('lets the host turn the waiting room on and off, and nobody else', () => {
    const a = joinAs('Gene')
    const b = joinAs('小潔')
    expect(a.client.view!.room.waitingRoom).toBe(false)
    host(b.conn, { action: 'waitingRoom', on: true })
    expect(b.client.received.at(-1)).toEqual(forbidden)
    expect(a.client.view!.room.waitingRoom).toBe(false)
    host(a.conn, { action: 'waitingRoom', on: true })
    expect(b.client.view!.room.waitingRoom).toBe(true)
    expect((t.saved.room as RoomInfo).waitingRoom).toBe(true)
    host(a.conn, { action: 'waitingRoom', on: false })
    expect(b.client.view!.room.waitingRoom).toBe(false)
  })

  it('puts someone new in the waiting room: a lobby, no view, no chat, no media', () => {
    const { a, b } = room()
    t.host.message(a.conn, JSON.stringify({ t: 'chat', text: 'before' }))
    t.tick(5)
    const c = joinAs('阿明', 'browser-aming-000000')
    expect(c.id).not.toBe('')
    expect(c.client.received).toEqual([
      {
        t: 'lobby',
        v: PROTOCOL_VERSION,
        you: c.id,
        token: c.token,
        position: 1,
        count: 1,
        room: { name: null, createdBy: 'Gene' },
        hostPresent: true,
        recording: false,
      },
    ])
    // The room sees who waits, apart from its members
    expect(a.client.view!.members[c.id]).toBeUndefined()
    expect(b.client.view!.waiting).toEqual({
      [c.id]: { id: c.id, name: '阿明', since: t.now(), reconnecting: false },
    })
    expect(t.host.memberCount).toBe(2)
    expect(t.host.summary()).toMatchObject({ memberCount: 2, waitingRoom: true })
    // Nothing of the meeting reaches the waiting room: patches, chat
    t.host.message(b.conn, JSON.stringify({ t: 'rename', name: '小潔潔' }))
    t.host.message(a.conn, JSON.stringify({ t: 'chat', text: 'after' }))
    expect(c.client.received.filter((m) => m.t !== 'lobby')).toEqual([])
    // A resync gets the lobby again, never a snapshot
    t.host.message(c.conn, '{"t":"resync"}')
    expect(c.client.received.map((m) => m.t)).toEqual(['lobby', 'lobby'])
    // Chat, sharing and host controls are refused (worker/roles.ts)
    t.host.message(c.conn, JSON.stringify({ t: 'chat', text: 'hi' }))
    expect(c.client.received.at(-1)).toEqual(forbidden)
    t.host.message(c.conn, JSON.stringify({ t: 'share' }))
    expect(c.client.received.at(-1)).toEqual(forbidden)
    host(c.conn, { action: 'admit', memberId: c.id })
    expect(c.client.received.at(-1)).toEqual(forbidden)
    // The SFU proxy and TURN refuse it (`media`)
    expect(t.host.sfuAccess(c.token, null, [])).toEqual({ ok: false, reason: 'forbidden' })
    expect(t.host.bindSfu(c.token, 'sc')).toBe(false)
    // Renaming oneself still works, and the room sees it
    t.host.message(c.conn, JSON.stringify({ t: 'rename', name: '阿明明' }))
    expect(a.client.view!.waiting[c.id].name).toBe('阿明明')
  })

  it('admits one: welcome, chat history, a participant with media from then on', () => {
    const { a, b } = room()
    t.host.message(a.conn, JSON.stringify({ t: 'chat', text: 'hello' }))
    const c = joinAs('阿明')
    t.tick(10)
    const d = joinAs('阿華')
    expect(lastLobby(d.client)).toMatchObject({ position: 2, count: 2 })
    t.tick(10)
    host(a.conn, { action: 'admit', memberId: c.id })
    const welcome = c.client.received.find((m) => m.t === 'welcome')
    expect(welcome).toMatchObject({ you: c.id, token: c.token, rev: a.client.rev })
    expect(c.client.view!.members[c.id]).toMatchObject({ role: 'participant', joinedAt: t.now() })
    expect(c.client.view!.waiting).toEqual({ [d.id]: expect.objectContaining({ name: '阿華' }) })
    expect(c.client.received.at(-2)).toMatchObject({ t: 'chat', reset: true })
    expect(c.client.received.at(-1)).toMatchObject({ t: 'annotations', reset: true, done: true })
    expect(b.client.view).toEqual(c.client.view)
    // The next in line moves up
    expect(lastLobby(d.client)).toMatchObject({ position: 1, count: 1 })
    expect(t.host.sfuAccess(c.token, null, [])).toMatchObject({ ok: true, memberId: c.id })
    // From now on c gets the patches like everyone
    t.host.message(b.conn, JSON.stringify({ t: 'rename', name: '小潔潔' }))
    expect(c.client.view!.members[b.id].name).toBe('小潔潔')
    // Admitting again (another co-host with a stale panel) changes nothing
    const rev = a.client.rev
    host(a.conn, { action: 'admit', memberId: c.id })
    expect(a.client.rev).toBe(rev)
  })

  it('admits everyone at once', () => {
    const { a } = room()
    const c = joinAs('阿明')
    const d = joinAs('阿華')
    host(a.conn, { action: 'admitAll' })
    for (const who of [c, d]) {
      expect(who.client.received.some((m) => m.t === 'welcome')).toBe(true)
      expect(who.client.view!.waiting).toEqual({})
    }
    expect(Object.keys(a.client.view!.members)).toHaveLength(4)
  })

  it('admits everyone waiting when the waiting room is turned off', () => {
    const { a, b } = room()
    const c = joinAs('阿明')
    host(a.conn, { action: 'waitingRoom', on: false })
    expect(c.client.received.some((m) => m.t === 'welcome')).toBe(true)
    expect(b.client.view!.members[c.id].role).toBe('participant')
    // The next one comes straight in
    expect(joinAs('阿華').client.received[0].t).toBe('welcome')
  })

  it('refuses admit and deny from a participant', () => {
    const { b } = room()
    const c = joinAs('阿明')
    for (const action of ['admit', 'deny']) {
      host(b.conn, { action, memberId: c.id })
      expect(b.client.received.at(-1)).toEqual(forbidden)
    }
    host(b.conn, { action: 'admitAll' })
    expect(b.client.received.at(-1)).toEqual(forbidden)
    expect(b.client.view!.waiting[c.id]).toBeDefined()
    expect(c.client.closed).toBeNull()
  })

  it('denies: closed with `denied`, then the browser waits out DENY_COOLDOWN_MS (fake clock)', () => {
    const { a, b } = room()
    const c = joinAs('阿明', 'browser-aming-000000')
    host(a.conn, { action: 'deny', memberId: c.id })
    expect(c.client.closed).toEqual({ code: CloseCode.denied, reason: 'denied' })
    expect(b.client.view!.waiting).toEqual({})
    // Asking again at once: refused, with the old token too (it is forgotten)
    expect(joinAs('阿明', 'browser-aming-000000').client.closed?.code).toBe(CloseCode.denied)
    const back = joinAs('阿明', 'browser-aming-000000', c.token)
    expect(back.client.closed?.code).toBe(CloseCode.denied)
    expect(t.saved.bans).toEqual([
      { client: 'browser-aming-000000', until: t.now() + DENY_COOLDOWN_MS, denied: true },
    ])
    expect(t.saved.schedule.bans).toBe(t.now() + DENY_COOLDOWN_MS)
    t.tick(DENY_COOLDOWN_MS)
    t.host.message(a.conn, 'ping')
    t.host.message(b.conn, 'ping')
    t.host.alarm()
    expect(t.host.banList).toEqual([])
    const later = joinAs('阿明', 'browser-aming-000000')
    expect(later.client.closed).toBeNull()
    expect(lastLobby(later.client)).toMatchObject({ position: 1 })
  })

  it('keeps the longer ban of a removal over a denial', () => {
    const { a } = room()
    const c = joinAs('阿明', 'browser-aming-000000')
    host(a.conn, { action: 'admit', memberId: c.id })
    host(a.conn, { action: 'remove', memberId: c.id })
    expect(joinAs('阿明', 'browser-aming-000000').client.closed?.code).toBe(CloseCode.removed)
    expect(t.host.banList).toEqual([{ client: 'browser-aming-000000', until: t.now() + BAN_MS }])
  })

  it('locks: nobody new gets in, not even into the waiting room; the host unlocks', () => {
    const a = joinAs('Gene')
    const b = joinAs('小潔')
    host(b.conn, { action: 'lock', on: true })
    expect(b.client.received.at(-1)).toEqual(forbidden)
    host(a.conn, { action: 'lock', on: true })
    expect(b.client.view!.room.locked).toBe(true)
    expect(t.host.summary()).toMatchObject({ locked: true })
    const c = joinAs('阿明')
    expect(c.client.closed).toEqual({ code: CloseCode.locked, reason: 'locked' })
    expect(c.id).toBe('')
    host(a.conn, { action: 'waitingRoom', on: true })
    expect(joinAs('阿明').client.closed?.code).toBe(CloseCode.locked)
    expect(a.client.view!.waiting).toEqual({})
    host(a.conn, { action: 'lock', on: false })
    expect(joinAs('阿明').client.closed).toBeNull()
  })

  it('lets a member back into a locked room within its grace period, and someone waiting', () => {
    const { a, b } = room()
    const c = joinAs('阿明')
    host(a.conn, { action: 'lock', on: true })
    // The page of b reloads; the network of c drops
    t.host.closed(b.conn)
    t.host.closed(c.conn)
    t.tick(RECONNECT_GRACE_MS - 1)
    const b2 = joinAs('小潔', null, b.token)
    expect(b2.id).toBe(b.id)
    expect(b2.client.received[0].t).toBe('welcome')
    const c2 = joinAs('阿明', null, c.token)
    expect(c2.id).toBe(c.id)
    expect(c2.client.received).toEqual([expect.objectContaining({ t: 'lobby', position: 1 })])
    // The host can still admit who waits in a locked room
    host(a.conn, { action: 'admit', memberId: c.id })
    expect(c2.client.received.some((m) => m.t === 'welcome')).toBe(true)
    // After the grace period the token is forgotten: someone new, and refused
    t.host.closed(b2.conn)
    t.tick(RECONNECT_GRACE_MS + 1)
    t.host.message(a.conn, 'ping')
    t.host.message(c2.conn, 'ping')
    t.host.sweep()
    expect(joinAs('小潔', null, b.token).client.closed?.code).toBe(CloseCode.locked)
  })

  it('keeps a reloading waiting member in its place in the queue', () => {
    room()
    const c = joinAs('阿明')
    t.tick(1)
    const d = joinAs('阿華')
    t.host.closed(c.conn)
    expect(t.host.view().waiting[c.id].reconnecting).toBe(true)
    const c2 = joinAs('阿明', null, c.token)
    expect(c2.client.received).toEqual([expect.objectContaining({ position: 1, count: 2 })])
    expect(lastLobby(d.client)).toMatchObject({ position: 2 })
  })

  it(`sends away whoever waits for ${WAIT_TIMEOUT_MS / 60_000} minutes (fake clock)`, () => {
    const { a, b } = room()
    const c = joinAs('阿明')
    const cSince = t.now()
    expect(t.saved.schedule.waiting).toBe(cSince + WAIT_TIMEOUT_MS)
    t.tick(60_000)
    const d = joinAs('阿華')
    const ping = () => {
      for (const who of [a, b, c, d]) t.host.message(who.conn, 'ping')
    }
    // Keep everyone heard from while the clock runs (the sweep would mark them stale)
    while (t.now() < cSince + WAIT_TIMEOUT_MS - SWEEP_INTERVAL_MS) {
      t.tick(SWEEP_INTERVAL_MS)
      ping()
      t.host.sweep()
    }
    t.tick(cSince + WAIT_TIMEOUT_MS - 1 - t.now())
    ping()
    t.host.alarm()
    expect(c.client.closed).toBeNull()
    t.tick(1)
    ping()
    t.host.alarm()
    expect(c.client.closed).toEqual({ code: CloseCode.waitExpired, reason: 'waited too long' })
    expect(d.client.closed).toBeNull()
    expect(lastLobby(d.client)).toMatchObject({ position: 1, count: 1 })
    expect(t.saved.schedule.waiting).toBe(cSince + 60_000 + WAIT_TIMEOUT_MS)
    expect(Object.keys(a.client.view!.waiting)).toEqual([d.id])
  })

  it('hands the host on to someone in the room, never to someone waiting (AC-1.3)', () => {
    const { a, b } = room()
    const c = joinAs('阿明')
    t.host.message(a.conn, '{"t":"leave"}')
    expect(b.client.view!.members[b.id].role).toBe('host')
    expect(lastLobby(c.client)).toMatchObject({ hostPresent: true })
    // The last one in the room leaves: nobody can admit, the waiting member is told
    t.host.message(b.conn, '{"t":"leave"}')
    expect(lastLobby(c.client)).toMatchObject({ hostPresent: false })
    expect(t.host.view().members).toEqual({})
    expect(t.host.view().waiting[c.id]).toBeDefined()
    // Someone waiting keeps the room open (it is not empty)
    expect(t.saved.schedule.close).toBeUndefined()
  })

  it('tells who waits when the host is reconnecting, and again when it is back', () => {
    const { a } = room()
    const c = joinAs('阿明')
    t.host.closed(a.conn)
    // 小潔 is still connected but not staff until the handoff
    expect(lastLobby(c.client)).toMatchObject({ hostPresent: false })
    const a2 = joinAs('Gene', null, a.token)
    expect(a2.id).toBe(a.id)
    expect(lastLobby(c.client)).toMatchObject({ hostPresent: true })
  })

  it('keeps who waits across the object being evicted', () => {
    const { a } = room()
    const c = joinAs('阿明')
    const woken = setup('w')
    woken.clients.set(a.conn, a.client)
    woken.clients.set(c.conn, c.client)
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [
      { conn: a.conn, openedAt: woken.now() },
      { conn: c.conn, openedAt: woken.now() },
    ])
    expect(woken.host.view().waiting[c.id]).toBeDefined()
    expect(woken.host.view().members[c.id]).toBeUndefined()
    expect(woken.host.view().room).toMatchObject({ waitingRoom: true, locked: false })
    expect(woken.host.sfuAccess(c.token, null, [])).toEqual({ ok: false, reason: 'forbidden' })
  })
})

describe('RoomHost spotlight (G2, e4-t11)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.host.create(ROOM)
  })

  const spotlight = (conn: string, memberId: string | null) =>
    t.host.message(conn, JSON.stringify({ t: 'spotlight', memberId }))
  const forbidden = { t: 'error', code: 'forbidden' }
  const errors = (client: FakeClient) => client.received.filter((m) => m.t === 'error')

  it('lets the host spotlight anyone for everyone, move it, and end it', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    const c = t.join('阿明')
    spotlight(a.conn, b.id)
    for (const who of [a, b, c]) expect(who.client.view!.room.spotlight).toBe(b.id)
    expect((t.saved.room as RoomInfo).spotlight).toBe(b.id)
    // One at a time: a new spotlight replaces the old; the host may spotlight themselves
    spotlight(a.conn, a.id)
    expect(c.client.view!.room.spotlight).toBe(a.id)
    spotlight(a.conn, null)
    expect(c.client.view!.room.spotlight).toBeNull()
    expect(errors(a.client)).toEqual([])
  })

  it('refuses a participant (worker/roles.ts), and changes nothing', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    spotlight(a.conn, a.id)
    const rev = b.client.rev
    spotlight(b.conn, b.id)
    spotlight(b.conn, null)
    expect(errors(b.client)).toEqual([forbidden, forbidden])
    expect(b.client.rev).toBe(rev)
    expect(a.client.view!.room.spotlight).toBe(a.id)
  })

  it('refuses someone who is not in the room: gone, or still in the waiting room', () => {
    const a = t.join('Gene')
    t.host.message(a.conn, JSON.stringify({ t: 'host', action: 'waitingRoom', on: true }))
    const socket = t.open()
    t.host.message(socket.conn, JSON.stringify({ t: 'join', name: '阿明', token: null }))
    const lobby = socket.client.received.find((m) => m.t === 'lobby')
    const waitingId = lobby?.t === 'lobby' ? lobby.you : ''
    expect(waitingId).not.toBe('')
    spotlight(a.conn, waitingId)
    spotlight(a.conn, 'nobody')
    expect(errors(a.client)).toEqual([forbidden, forbidden])
    expect(a.client.view!.room.spotlight).toBeNull()
  })

  it('ends when the member leaves, not while they reconnect', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    spotlight(a.conn, b.id)
    t.host.closed(b.conn)
    expect(a.client.view!.room.spotlight).toBe(b.id)
    const back = t.join('小潔', b.token)
    expect(back.id).toBe(b.id)
    t.host.message(back.conn, JSON.stringify({ t: 'leave' }))
    expect(a.client.view!.room.spotlight).toBeNull()
    expect((t.saved.room as RoomInfo).spotlight).toBeNull()
  })

  it('keeps the spotlight across the object being evicted; drops one on a member who is gone', () => {
    const a = t.join('Gene')
    const b = t.join('小潔')
    spotlight(a.conn, b.id)
    const woken = setup('w')
    woken.host.restore(t.saved.room as RoomInfo, t.saved.rev, t.saved.sessions, [
      { conn: a.conn, openedAt: woken.now() },
      { conn: b.conn, openedAt: woken.now() },
    ])
    expect(woken.host.view().room.spotlight).toBe(b.id)
    const stale = setup('s')
    stale.host.restore({ ...(t.saved.room as RoomInfo), spotlight: 'gone' }, 0, [], [])
    expect(stale.host.view().room.spotlight).toBeNull()
    // A room stored before v11 has no spotlight at all
    const { spotlight: _, ...old } = t.saved.room as RoomInfo
    const older = setup('o')
    older.host.restore(old, 0, [], [])
    expect(older.host.view().room.spotlight).toBeNull()
  })
})

describe('RoomHost abuse limits (I1, e11-t05)', () => {
  it('closes a socket that floods frames with rateLimited, and marks its member away', async () => {
    const { ROOM_CONNECT_RATE, SOCKET_MESSAGE_RATE } = await import('../../shared/abuse.ts')
    const offences: string[] = []
    const t = setup()
    ;(t.host as unknown as { deps: { offence: unknown } }).deps.offence = (
      conn: string | null,
      _ip: string | null,
      kind: string,
    ) => offences.push(`${conn}:${kind}`)
    t.host.create(ROOM)
    const alice = t.join('Alice')
    const bob = t.join('Bob')
    // The join was one frame; the rest of the window fills up without trouble
    for (let i = 1; i < SOCKET_MESSAGE_RATE.count; i++) t.host.message(alice.conn, '{"t":"resync"}')
    expect(alice.client.closed).toBeNull()
    t.host.message(alice.conn, '{"t":"resync"}')
    expect(alice.client.closed).toEqual({ code: CloseCode.rateLimited, reason: 'too many messages' })
    expect(offences).toEqual([`${alice.conn}:flood`])
    expect(bob.client.view?.members[alice.id].reconnecting).toBe(true)
    // Further frames on the closed connection are ignored
    t.host.message(alice.conn, JSON.stringify({ t: 'rename', name: 'Eve' }))
    expect(bob.client.view?.members[alice.id].name).toBe('Alice')
    // A new window lets a well-behaved socket go on for ever
    t.tick(SOCKET_MESSAGE_RATE.windowMs)
    for (let i = 0; i < SOCKET_MESSAGE_RATE.count - 1; i++) t.host.message(bob.conn, '{"t":"resync"}')
    t.tick(SOCKET_MESSAGE_RATE.windowMs)
    for (let i = 0; i < SOCKET_MESSAGE_RATE.count - 1; i++) t.host.message(bob.conn, '{"t":"resync"}')
    expect(bob.client.closed).toBeNull()
    expect(ROOM_CONNECT_RATE.count).toBeGreaterThan(MAX_MEMBERS / 2)
  })

  it('refuses upgrades over ROOM_CONNECT_RATE from one address, not from others', async () => {
    const { ROOM_CONNECT_RATE } = await import('../../shared/abuse.ts')
    const t = setup()
    t.host.create(ROOM)
    for (let i = 0; i < ROOM_CONNECT_RATE.count; i++) {
      expect(t.host.admit(V, 'net-a')).toEqual({ ok: true })
    }
    expect(t.host.admit(V, 'net-a')).toMatchObject({ ok: false, code: CloseCode.rateLimited })
    expect(t.host.admit(V, 'net-b')).toEqual({ ok: true })
    // Unknown addresses (local development) are not limited
    expect(t.host.admit(V, null)).toEqual({ ok: true })
    t.tick(ROOM_CONNECT_RATE.windowMs)
    expect(t.host.admit(V, 'net-a')).toEqual({ ok: true })
  })
})
