// I4 (e8-t02, AC-8.2; CLAUDE.md rules 1 and 4): who records is RoomDO state everyone sees
// (RoomInfo.recordings), granted only by the room: the host (worker/roles.ts `record`) or a
// member the host allowed (`allowRecord`). Leaving ends a recording, reconnecting does not; the
// host stops anyone's (the recorder is told); a browser of an older version is refused.
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../shared/patch.ts'
import {
  CloseCode,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  parseClientMessage,
  recordingOrder,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null
  rev = -1

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

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t)
  }
}

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const saved = { room: null as RoomInfo | null, sessions: [] as SessionRecord[] }
  const noop = () => {}
  const host = new RoomHost({
    sockets: {
      send: (conn, message) => clients.get(conn)?.receive(message),
      close: noop,
    },
    storage: {
      saveRoom: (info) => {
        saved.room = structuredClone(info)
      },
      saveRev: noop,
      saveSessions: (sessions) => {
        saved.sessions = structuredClone(sessions)
      },
      saveUsage: noop,
      saveSchedule: noop,
      saveChat: noop,
      dropChat: noop,
      saveBans: noop,
      savePassword: noop,
      saveGuesses: noop,
      saveEnded: noop,
      clear: noop,
    },
    now: () => clock,
    newMemberId: () => `m${++nextId}`,
    newToken: () => `token-m${nextId}`.padEnd(43, '_'),
  })
  host.create(ROOM)
  function join(name: string, token: string | null = null) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    void host.message(conn, JSON.stringify({ t: 'join', name, token, client: null }))
    const welcome = client.of('welcome')[0]
    return {
      conn,
      client,
      id: welcome?.you ?? '',
      token: welcome?.token ?? '',
    }
  }
  const send = (who: { conn: string }, message: object) =>
    void host.message(who.conn, JSON.stringify(message))
  return { host, saved, join, send, tick: (ms: number) => (clock += ms), now: () => clock }
}

const recorders = (view: RoomView | null) =>
  recordingOrder(view?.room.recordings).map((r) => r.memberId)

describe('recording state (e8-t02)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('parses record and the two host actions, nothing malformed', () => {
    expect(parseClientMessage('{"t":"record","on":true}')).toEqual({ t: 'record', on: true })
    expect(parseClientMessage('{"t":"record","on":"yes"}')).toBeNull()
    expect(parseClientMessage('{"t":"host","action":"stopRecording","memberId":"m2"}')).toEqual({
      t: 'host',
      action: 'stopRecording',
      memberId: 'm2',
    })
    expect(
      parseClientMessage('{"t":"host","action":"allowRecord","memberId":"m2","on":false}'),
    ).toEqual({ t: 'host', action: 'allowRecord', memberId: 'm2', on: false })
    expect(parseClientMessage('{"t":"host","action":"allowRecord","memberId":"m2"}')).toBeNull()
  })

  it('refuses a browser of the previous protocol version (it could not show the red light)', () => {
    expect(PROTOCOL_VERSION).toBe(17)
    expect(t.host.admit('16')).toMatchObject({ ok: false, code: CloseCode.versionMismatch })
  })

  it('lets the host record; everyone, and the pre-join summary, sees who and since when', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    t.tick(50)
    t.send(host, { t: 'record', on: true })
    const info = { memberId: host.id, since: t.now() }
    expect(bob.client.view!.room.recordings).toEqual({ [host.id]: info })
    expect(host.client.view!.room.recordings).toEqual({ [host.id]: info })
    expect(t.host.summary()?.recordings).toEqual({ [host.id]: info })
    // Stored with the room (it outlasts an eviction)
    expect(t.saved.room?.recordings).toEqual({ [host.id]: info })
    // Asking again changes nothing
    const patches = bob.client.of('patch').length
    t.send(host, { t: 'record', on: true })
    expect(bob.client.of('patch')).toHaveLength(patches)
    t.send(host, { t: 'record', on: false })
    expect(bob.client.view!.room.recordings).toEqual({})
    expect(t.host.summary()?.recordings).toEqual({})
  })

  it('refuses participants and co-hosts with forbidden, until the host allows them', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    t.send(host, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
    for (const who of [bob, carol]) {
      t.send(who, { t: 'record', on: true })
      expect(who.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    }
    expect(recorders(host.client.view)).toEqual([])
    // Only the host may allow (a co-host may not)
    t.send(carol, { t: 'host', action: 'allowRecord', memberId: bob.id, on: true })
    expect(carol.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    expect(bob.client.view!.members[bob.id].mayRecord).toBe(false)
    t.send(host, { t: 'host', action: 'allowRecord', memberId: bob.id, on: true })
    expect(bob.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'recordAllowed',
      by: host.id,
    })
    expect(host.client.view!.members[bob.id].mayRecord).toBe(true)
    t.tick(10)
    t.send(bob, { t: 'record', on: true })
    t.tick(10)
    t.send(host, { t: 'record', on: true })
    // Several at once, in the order they started
    expect(recorders(carol.client.view)).toEqual([bob.id, host.id])
  })

  it('stops a recording the host took the permission back from, and tells the recorder', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    t.send(host, { t: 'host', action: 'allowRecord', memberId: bob.id, on: true })
    t.send(bob, { t: 'record', on: true })
    expect(recorders(host.client.view)).toEqual([bob.id])
    t.send(host, { t: 'host', action: 'allowRecord', memberId: bob.id, on: false })
    expect(bob.client.of('notice').slice(-2)).toEqual([
      { t: 'notice', notice: 'recordRevoked', by: host.id },
      { t: 'notice', notice: 'recordingStopped', by: host.id },
    ])
    expect(recorders(host.client.view)).toEqual([])
    expect(host.client.view!.members[bob.id].mayRecord).toBe(false)
    t.send(bob, { t: 'record', on: true })
    expect(bob.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
  })

  it('lets the host stop anyone’s recording; nobody else can', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    const carol = t.join('Carol')
    t.send(host, { t: 'host', action: 'allowRecord', memberId: bob.id, on: true })
    t.send(bob, { t: 'record', on: true })
    // Not a participant, not the recorder on someone else, not a co-host
    t.send(carol, { t: 'host', action: 'stopRecording', memberId: bob.id })
    expect(carol.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    t.send(host, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
    t.send(carol, { t: 'host', action: 'stopRecording', memberId: bob.id })
    expect(carol.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    expect(recorders(host.client.view)).toEqual([bob.id])
    t.send(host, { t: 'host', action: 'stopRecording', memberId: bob.id })
    expect(bob.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'recordingStopped',
      by: host.id,
    })
    expect(recorders(carol.client.view)).toEqual([])
    // Stopping one that is not on tells nobody
    const notices = bob.client.of('notice').length
    t.send(host, { t: 'host', action: 'stopRecording', memberId: bob.id })
    expect(bob.client.of('notice')).toHaveLength(notices)
  })

  it('keeps a recording while its recorder reconnects, ends it when they leave or time out', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    t.send(host, { t: 'record', on: true })
    t.host.closed(host.conn)
    expect(recorders(bob.client.view)).toEqual([host.id])
    // Back within the grace window: still recording
    t.tick(RECONNECT_GRACE_MS - 1000)
    const again = t.join('Gene', host.token)
    expect(again.id).toBe(host.id)
    expect(recorders(bob.client.view)).toEqual([host.id])
    // Gone past the grace window: the red light goes out with them
    t.host.closed(again.conn)
    t.tick(RECONNECT_GRACE_MS + 1)
    t.host.heartbeat(bob.conn, t.now())
    t.host.sweep()
    expect(bob.client.view!.members[host.id]).toBeUndefined()
    expect(recorders(bob.client.view)).toEqual([])
    // Leaving on purpose ends it at once
    t.send(host, { t: 'record', on: true })
    const carol = t.join('Carol')
    // Bob is the host now (the old host is gone)
    t.send(bob, { t: 'record', on: true })
    expect(recorders(carol.client.view)).toEqual([bob.id])
    t.send(bob, { t: 'leave' })
    expect(recorders(carol.client.view)).toEqual([])
  })

  it('refuses someone in the waiting room', () => {
    const host = t.join('Gene')
    t.send(host, { t: 'host', action: 'waitingRoom', on: true })
    const wei = t.join('Wei')
    expect(wei.id).toBe('')
    const lobby = wei.client.of('lobby')[0]
    expect(lobby).toBeDefined()
    // The host cannot allow someone who waits either
    t.send(host, { t: 'host', action: 'allowRecord', memberId: lobby.you, on: true })
    t.send(wei, { t: 'record', on: true })
    expect(wei.client.of('error').at(-1)).toEqual({ t: 'error', code: 'forbidden' })
    expect(recorders(host.client.view)).toEqual([])
  })

  it('restores recordings and permissions, dropping a recorder who is gone; old rooms record nothing', () => {
    const host = t.join('Gene')
    const bob = t.join('Bob')
    t.send(host, { t: 'host', action: 'allowRecord', memberId: bob.id, on: true })
    t.send(host, { t: 'record', on: true })
    const woken = setup()
    woken.host.restore(t.saved.room, 9, t.saved.sessions, [])
    expect(recorders(woken.host.view())).toEqual([host.id])
    expect(woken.host.view().members[bob.id].mayRecord).toBe(true)
    // A stored recorder who is no longer a member is dropped
    const stale = setup()
    stale.host.restore(
      { ...t.saved.room!, recordings: { nobody: { memberId: 'nobody', since: 1 } } },
      3,
      [],
      [],
    )
    expect(stale.host.view().room.recordings).toEqual({})
    // A room and members stored by v16 have neither
    const { recordings: _none, ...v16 } = t.saved.room!
    const old = setup()
    old.host.restore(
      v16 as RoomInfo,
      9,
      t.saved.sessions.map((record) => {
        const { mayRecord: _no, ...member } = record.member
        return { ...record, member: member as typeof record.member }
      }),
      [],
    )
    expect(old.host.view().room.recordings).toEqual({})
    expect(old.host.view().members[bob.id].mayRecord).toBe(false)
  })
})
