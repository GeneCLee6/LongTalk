// I2 (e1-t13): personal persistent rooms in RoomHost, on a fake clock: the owner is always the
// host when they join (past the lock, the password, the waiting room and a ban), the settings
// outlive meetings (ending one and the empty-room close only clear the meeting: members, chat,
// recordings), the room is restored with its owner after an eviction, the owner's /me changes
// reach everyone, and deleting it leaves nothing.
import { describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  EMPTY_ROOM_TTL_MS,
  ENDED_TOMBSTONE_MS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  SWEEP_INTERVAL_MS,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import type { PasswordRecord } from '../../worker/password.ts'
import { RoomHost, type PersistentRecord, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const OWNER = 'account-owner'
const SLUG = 'gene-weekly'

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null
  closed: { code: number; reason: string } | null = null

  receive(message: ServerMessage) {
    this.received.push(message)
    if (message.t === 'welcome' || message.t === 'snapshot') this.view = message.state
    else if (message.t === 'patch' && this.view) {
      this.view = applyPatch(viewAsJson(this.view), message.ops) as RoomView
    }
  }
}

/** What the adapter would have in storage, key by key */
type Stored = {
  room?: RoomInfo
  password?: PasswordRecord | null
  persistent?: PersistentRecord | null
  ended?: number | null
  sessions?: SessionRecord[]
  chat: number
}

function setup() {
  let clock = 1_000_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const stored: Stored = { chat: 0 }
  const make = () =>
    new RoomHost({
      sockets: {
        send: (conn, message) => clients.get(conn)?.receive(message),
        close: (conn, code, reason) => {
          const client = clients.get(conn)
          if (client) client.closed = { code, reason }
        },
      },
      storage: {
        saveRoom: (info) => void (stored.room = structuredClone(info)),
        saveRev: () => {},
        saveSessions: (sessions) => void (stored.sessions = structuredClone(sessions)),
        saveUsage: () => {},
        saveSchedule: () => {},
        saveChat: () => void stored.chat++,
        dropChat: () => {},
        saveBans: () => {},
        savePassword: (record) => void (stored.password = record),
        saveGuesses: () => {},
        saveEnded: (until) => void (stored.ended = until),
        savePersistent: (record) => void (stored.persistent = record),
        clear: () => {
          for (const key of ['room', 'password', 'persistent', 'ended', 'sessions'] as const) {
            delete stored[key]
          }
          stored.chat = 0
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
    })
  let host = make()
  expect(host.createPersistent({ slug: SLUG, owner: OWNER, createdAt: clock }, '週會')).toBe(true)

  async function join(
    name: string,
    options: { account?: string; token?: string | null; password?: string } = {},
  ) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn, null, options.account ?? null)
    await host.message(
      conn,
      JSON.stringify({
        t: 'join',
        name,
        token: options.token ?? null,
        client: `browser-${name}`.padEnd(16, '0'),
        password: options.password,
      }),
    )
    const welcome = client.received.find((m) => m.t === 'welcome')
    return {
      conn,
      client,
      id: welcome?.t === 'welcome' ? welcome.you : '',
      token: welcome?.t === 'welcome' ? welcome.token : '',
    }
  }

  const send = (conn: string, message: object) => host.message(conn, JSON.stringify(message))
  const role = (viewer: FakeClient, memberId: string) => viewer.view?.members[memberId]?.role

  return {
    get host() {
      return host
    },
    stored,
    join,
    send,
    role,
    tick: (ms: number) => {
      clock += ms
    },
    /** Runs every alarm due up to now */
    alarms: () => {
      let next = host.nextAlarm()
      while (next !== null && next <= clock) {
        host.alarm()
        next = host.nextAlarm()
      }
    },
    /** The object leaves memory and comes back from what was stored */
    evict: () => {
      host = make()
      host.restore(stored.room ?? null, 0, stored.sessions ?? [], [], null, null, [], [], {
        password: stored.password ?? null,
        endedUntil: stored.ended ?? null,
        persistent: stored.persistent ?? null,
      })
    },
  }
}

describe('a persistent room (e1-t13)', () => {
  it('is created once, with its name, and says it is persistent but not whose', () => {
    const t = setup()
    expect(t.host.createPersistent({ slug: SLUG, owner: 'someone', createdAt: 1 }, null)).toBe(false)
    expect(t.host.summary()).toMatchObject({ id: SLUG, name: '週會', persistent: true, owner: false })
    expect(t.host.summary(OWNER)?.owner).toBe(true)
    expect(JSON.stringify(t.host.view())).not.toContain(OWNER)
    // Nothing to close while nobody has used it
    expect(t.host.nextAlarm()).toBeNull()
  })

  it('makes its owner the host, past the lock, the password and the waiting room', async () => {
    const t = setup()
    const guest = await t.join('Guest')
    expect(t.role(guest.client, guest.id)).toBe('host')
    await t.send(guest.conn, { t: 'host', action: 'setPassword', password: '4321' })
    await t.send(guest.conn, { t: 'host', action: 'waitingRoom', on: true })
    await t.send(guest.conn, { t: 'host', action: 'lock', on: true })
    // A stranger is kept out by the lock; the owner walks in and is the host
    const stranger = await t.join('Stranger')
    expect(stranger.client.closed?.code).toBe(CloseCode.locked)
    const owner = await t.join('Gene', { account: OWNER })
    expect(owner.id).not.toBe('')
    expect(t.role(owner.client, owner.id)).toBe('host')
    // The host before is a co-host, and is told by whom
    expect(t.role(guest.client, guest.id)).toBe('cohost')
    expect(guest.client.received).toContainEqual({ t: 'notice', notice: 'madeCohost', by: owner.id })
    // Another signed-in account is nobody special
    await t.send(owner.conn, { t: 'host', action: 'lock', on: false })
    const other = await t.join('Other', { account: 'someone-else', password: '4321' })
    expect(other.client.received.some((m) => m.t === 'lobby')).toBe(true)
  })

  it('lets the owner hand the host role on, and takes it back when the owner comes back', async () => {
    const t = setup()
    const owner = await t.join('Gene', { account: OWNER })
    const bob = await t.join('Bob')
    expect(t.role(bob.client, bob.id)).toBe('participant')
    await t.send(owner.conn, { t: 'host', action: 'makeHost', memberId: bob.id })
    expect(t.role(bob.client, bob.id)).toBe('host')
    // Reloading the tab: the same member, host again
    t.host.closed(owner.conn)
    const back = await t.join('Gene', { account: OWNER, token: owner.token })
    expect(back.id).toBe(owner.id)
    expect(t.role(bob.client, owner.id)).toBe('host')
    expect(t.role(bob.client, bob.id)).toBe('cohost')
  })

  it('keeps its settings and loses the meeting when the host ends it', async () => {
    const t = setup()
    const owner = await t.join('Gene', { account: OWNER })
    const bob = await t.join('Bob')
    await t.send(owner.conn, { t: 'host', action: 'setPassword', password: 'tea4two' })
    await t.send(owner.conn, { t: 'host', action: 'waitingRoom', on: true })
    await t.send(owner.conn, { t: 'renameRoom', name: 'Standup' })
    await t.send(bob.conn, { t: 'chat', text: 'hello' })
    expect(t.stored.chat).toBe(1)
    await t.send(owner.conn, { t: 'host', action: 'endMeeting' })
    expect(bob.client.closed?.code).toBe(CloseCode.ended)
    expect(t.host.summary()).toMatchObject({
      name: 'Standup',
      waitingRoom: true,
      persistent: true,
      memberCount: 0,
      startedAt: null,
      recordings: {},
      annotationPolicy: 'everyone' as const,
      whiteboard: null,
    })
    expect(t.host.summary()?.passwordSetAt).not.toBeNull()
    expect(t.stored).toMatchObject({ chat: 0, persistent: { owner: OWNER } })
    expect(t.stored.password).not.toBeNull()
    // Bob's dropped tab coming back with this meeting's token learns it ended…
    const late = await t.join('Bob', { token: bob.token })
    expect(late.client.closed?.code).toBe(CloseCode.ended)
    // …someone new is asked for the password, and the owner simply comes back as host
    const fresh = await t.join('Carol')
    expect(fresh.client.closed?.code).toBe(CloseCode.passwordRequired)
    const again = await t.join('Gene', { account: OWNER })
    expect(t.role(again.client, again.id)).toBe('host')
    expect(again.client.received.find((m) => m.t === 'chat')).toMatchObject({ messages: [] })
    // The tombstone runs out; the settings do not
    t.tick(ENDED_TOMBSTONE_MS)
    t.alarms()
    expect(t.stored.ended).toBeNull()
    expect(t.host.summary()?.name).toBe('Standup')
  })

  it('clears the meeting but not the settings when it stays empty, and survives an eviction', async () => {
    const t = setup()
    const owner = await t.join('Gene', { account: OWNER })
    await t.send(owner.conn, { t: 'host', action: 'lock', on: true })
    await t.send(owner.conn, { t: 'chat', text: 'notes' })
    await t.send(owner.conn, { t: 'leave' })
    t.tick(SWEEP_INTERVAL_MS)
    t.alarms()
    t.tick(EMPTY_ROOM_TTL_MS)
    t.alarms()
    expect(t.host.exists).toBe(true)
    expect(t.host.summary()).toMatchObject({ locked: true, name: '週會', startedAt: null })
    expect(t.stored.chat).toBe(0)
    expect(t.host.nextAlarm()).toBeNull()
    t.evict()
    expect(t.host.isPersistent).toBe(true)
    expect(t.host.summary(OWNER)).toMatchObject({ locked: true, owner: true })
    const back = await t.join('Gene', { account: OWNER })
    expect(t.role(back.client, back.id)).toBe('host')
    // Reconnecting members keep their place as in any room
    t.host.closed(back.conn)
    t.tick(RECONNECT_GRACE_MS / 2)
    expect(t.host.memberCount).toBe(1)
  })

  it('takes the owner’s changes from /me, telling everyone in it', async () => {
    const t = setup()
    const bob = await t.join('Bob')
    await t.join('Waiting Wendy')
    const settings = await t.host.updateSettings({
      name: 'Renamed',
      locked: true,
      waitingRoom: true,
      password: 'abcd',
    })
    expect(settings).toEqual({
      name: 'Renamed',
      locked: true,
      waitingRoom: true,
      password: true,
      memberCount: 2,
      startMuted: false,
      allowAnnotation: true,
      allowRecording: true,
      allowControl: true,
    })
    expect(bob.client.view?.room).toMatchObject({ name: 'Renamed', locked: true, waitingRoom: true })
    expect((await t.host.updateSettings({ password: null }))?.password).toBe(false)
  })

  it('leaves nothing behind when deleted', async () => {
    const t = setup()
    const bob = await t.join('Bob')
    t.host.destroy()
    expect(bob.client.closed?.code).toBe(CloseCode.ended)
    expect(t.host.exists).toBe(false)
    expect(t.host.summary()).toBeNull()
    expect(t.stored).toEqual({ chat: 0 })
    expect(t.host.admit(V)).toMatchObject({ ok: false, code: CloseCode.roomNotFound })
    expect(t.host.settings()).toBeNull()
  })
})

