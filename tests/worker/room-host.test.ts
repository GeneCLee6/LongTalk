import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  STALE_AFTER_MS,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { RoomHost } from '../../worker/room-host.ts'

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

function setup(idPrefix = 'm') {
  let clock = 10_000
  let nextId = 0
  const clients = new Map<string, FakeClient>()
  const saved = { room: null as unknown, rev: 0 }
  const host = new RoomHost({
    sockets: {
      send: (id, message) => clients.get(id)?.receive(message),
      close: (id, code, reason) => {
        const client = clients.get(id)
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
    },
    now: () => clock,
    newMemberId: () => `${idPrefix}${++nextId}`,
  })
  /** Connects a browser the way RoomDO does: admit, accept the socket, then `connected` */
  function join(): { id: string; client: FakeClient } {
    expect(host.admit(V)).toEqual({ ok: true })
    const member = host.newMember()
    const client = new FakeClient()
    clients.set(member.id, client)
    host.connected(member)
    return { id: member.id, client }
  }
  return {
    host,
    saved,
    clients,
    join,
    tick: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

describe('RoomHost', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('is created once and stored', () => {
    expect(t.host.exists).toBe(false)
    expect(t.host.create(ROOM)).toBe(true)
    expect(t.host.create({ ...ROOM, createdAt: 2 })).toBe(false)
    expect(t.saved.room).toEqual(ROOM)
    expect(t.host.view()).toEqual({ room: ROOM, members: {} })
  })

  it('refuses sockets to a room that was never created, of another version, or when full', () => {
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomNotFound })
    t.host.create(ROOM)
    expect(t.host.admit(null)).toMatchObject({ ok: false, code: CloseCode.versionMismatch })
    expect(t.host.admit('0')).toMatchObject({ ok: false, code: CloseCode.versionMismatch })
    for (let i = 0; i < MAX_MEMBERS; i++) t.join()
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomFull })
  })

  it('welcomes a newcomer with the whole room and patches everyone else', () => {
    t.host.create(ROOM)
    const a = t.join()
    expect(a.client.received).toEqual([
      {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        you: a.id,
        rev: 1,
        state: { room: ROOM, members: { [a.id]: { id: a.id, joinedAt: t.now() } } },
      },
    ])
    t.tick(5)
    const b = t.join()
    // a gets only the new member, not the whole room
    expect(a.client.received[1]).toEqual({
      t: 'patch',
      rev: 2,
      ops: [{ op: 'set', path: ['members', b.id], value: { id: b.id, joinedAt: t.now() } }],
    })
    expect(b.client.received).toHaveLength(1)
    expect(b.client.received[0]).toMatchObject({ t: 'welcome', you: b.id, rev: 2 })
    expect(a.client.view).toEqual(b.client.view)
    expect(Object.keys(b.client.view!.members)).toEqual([a.id, b.id])
    expect(t.saved.rev).toBe(2)
  })

  it('tells everyone when a member leaves, and ignores a second close', () => {
    t.host.create(ROOM)
    const a = t.join()
    const b = t.join()
    t.host.disconnected(b.id)
    t.host.disconnected(b.id)
    expect(a.client.received.at(-1)).toEqual({
      t: 'patch',
      rev: 3,
      ops: [{ op: 'del', path: ['members', b.id] }],
    })
    expect(a.client.view).toEqual(t.host.view())
    expect(t.host.memberCount).toBe(1)
  })

  it('keeps every member in step through joins and leaves', () => {
    t.host.create(ROOM)
    const all = Array.from({ length: 5 }, () => t.join())
    t.host.disconnected(all[1].id)
    t.host.disconnected(all[3].id)
    const late = t.join()
    for (const { id, client } of [...all.filter((_, i) => i !== 1 && i !== 3), late]) {
      expect(client.view, id).toEqual(t.host.view())
    }
  })

  it('answers resync with a snapshot and a bad message with an error', () => {
    t.host.create(ROOM)
    const a = t.join()
    t.host.message(a.id, '{"t":"resync"}')
    expect(a.client.received.at(-1)).toEqual({ t: 'snapshot', rev: 1, state: t.host.view() })
    t.host.message(a.id, '{"t":"nope"}')
    expect(a.client.received.at(-1)).toEqual({ t: 'error', code: 'bad_message' })
    const count = a.client.received.length
    t.host.message(a.id, 'ping')
    t.host.message('ghost', '{"t":"resync"}')
    expect(a.client.received).toHaveLength(count)
  })

  it('drops members whose heartbeat stopped and closes their sockets', () => {
    t.host.create(ROOM)
    const a = t.join()
    const b = t.join()
    t.tick(STALE_AFTER_MS - 1000)
    t.host.heartbeat(a.id, t.now())
    t.tick(2000)
    expect(t.host.sweep()).toBe(1)
    expect(b.client.closed).toEqual({ code: CloseCode.stale, reason: 'heartbeat timeout' })
    expect(a.client.closed).toBeNull()
    expect(Object.keys(a.client.view!.members)).toEqual([a.id])
    // A message counts as a heartbeat too
    t.tick(STALE_AFTER_MS - 1000)
    t.host.message(a.id, 'ping')
    t.tick(2000)
    expect(t.host.sweep()).toBe(0)
  })

  it('never moves a heartbeat backwards', () => {
    t.host.create(ROOM)
    const a = t.join()
    t.tick(STALE_AFTER_MS)
    t.host.heartbeat(a.id, t.now())
    t.host.heartbeat(a.id, 0)
    t.tick(1000)
    expect(t.host.sweep()).toBe(0)
  })

  it('comes back from hibernation with the same view and rev', () => {
    t.host.create(ROOM)
    const a = t.join()
    t.join()
    const view = t.host.view()
    const woken = setup('w')
    woken.host.restore(ROOM, t.saved.rev, Object.values(view.members))
    expect(woken.host.view()).toEqual(view)
    // The next change continues the same numbering, so a's copy stays valid
    woken.clients.set(a.id, a.client)
    const c = woken.join()
    expect(a.client.view).toEqual(woken.host.view())
    expect(c.client.received[0]).toMatchObject({ rev: 3 })
  })

  it('restores a room that was never created as not existing', () => {
    t.host.restore(null, 0, [])
    expect(t.host.exists).toBe(false)
    expect(t.host.admit(V)).toMatchObject({ code: CloseCode.roomNotFound })
  })
})
