// J2 (e7-t04): the room keeps the strokes on each share. Who may is the table's `annotate` row,
// everything from the wire goes through parseAnnotationOps, the limits are
// shared/annotation-limits.ts, storage is written in batches and a restore (hibernation, eviction)
// brings back the same strokes in the same order.
import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_FLUSH_MS,
  ANNOTATION_FRAME_RATE,
  ANNOTATION_STROKE_RATE,
  MAX_MEMBER_COST,
  MAX_MEMBER_STROKES,
  MAX_SHARE_COST,
  MAX_STROKES,
  SEGMENT_CHARS,
  SNAPSHOT_FRAME_CHARS,
} from '../../shared/annotation-limits.ts'
import { SOCKET_MESSAGE_RATE } from '../../shared/abuse.ts'
import type { NormPoint, Stroke } from '../../shared/annotation.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  viewAsJson,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import type { AnnotationSegment, AnnotationWrite } from '../../worker/room-annotations.ts'
import { RoomAnnotations } from '../../worker/room-annotations.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'
import type { RoomInfo } from '../../shared/protocol.ts'

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
  /** What storage holds, the way RoomDO keeps it */
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    segments: new Map<string, AnnotationSegment>(),
    /** How many rows each save wrote */
    writes: 0,
  }
  /** Timers given to `later`: run by `tick` when due */
  let timers: { at: number; work: () => void }[] = []
  const closes: { conn: string; code: number }[] = []
  const makeHost = () =>
    new RoomHost({
      sockets: {
        send: (conn, message) => clients.get(conn)?.receive(message),
        close: (conn, code) => void closes.push({ conn, code }),
      },
      storage: {
        saveRoom: (info) => void (disk.info = structuredClone(info)),
        saveRev: (rev) => void (disk.rev = rev),
        saveSessions: (sessions) => void (disk.sessions = structuredClone(sessions)),
        saveUsage: () => {},
        saveSchedule: () => {},
        saveChat: () => {},
        dropChat: () => {},
        saveBans: () => {},
        savePassword: () => {},
        saveGuesses: () => {},
        saveEnded: () => {},
        saveAnnotations: (writes: AnnotationWrite[]) => {
          for (const { share, segment, strokes } of writes) {
            disk.writes += 1
            const key = `${share}:${segment}`
            if (strokes === null) disk.segments.delete(key)
            else disk.segments.set(key, structuredClone({ share, segment, strokes }))
          }
        },
        clear: () => {
          disk.info = null
          disk.segments.clear()
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
      later: (ms, work) => void timers.push({ at: clock + ms, work }),
    })
  let host = makeHost()
  host.create(ROOM)
  function join(name: string) {
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    void host.message(conn, JSON.stringify({ t: 'join', name, token: null, client: null }))
    return { conn, client, id: client.of('welcome')[0]?.you ?? '' }
  }
  const tick = (ms: number) => {
    clock += ms
    const due = timers.filter((timer) => timer.at <= clock)
    timers = timers.filter((timer) => timer.at > clock)
    for (const { work } of due) work()
  }
  const send = (who: { conn: string }, message: object) =>
    void host.message(who.conn, JSON.stringify(message))
  /** The object goes away (a timer with it) and wakes up from storage, every socket still open */
  const evict = () => {
    timers = []
    host = makeHost()
    const sockets = [...clients.keys()].map((conn) => ({ conn, openedAt: clock }))
    host.restore(disk.info, disk.rev, disk.sessions, sockets, null, null, [], [], {
      annotations: [...disk.segments.values()],
    })
    return host
  }
  return {
    get host() {
      return host
    },
    disk,
    closes,
    join,
    send,
    tick,
    evict,
    clients,
    now: () => clock,
  }
}

const pen = (id: string, points: NormPoint[] = [[0.1, 0.1]]): Omit<Stroke, 'by'> => ({
  id,
  tool: 'pen',
  color: 'rose',
  width: 'medium',
  points,
})

/** A long stroke: costs about 16 characters a point */
const longPath = (count: number, seed = 0): NormPoint[] =>
  Array.from({ length: count }, (_, i): NormPoint => [
    ((i * 7 + seed) % 1000) / 1000,
    ((i * 13 + seed) % 1000) / 1000,
  ])

/** Alice shares, Bob draws, Carol watches */
function sharing() {
  const t = setup()
  const alice = t.join('Alice')
  const bob = t.join('Bob')
  const carol = t.join('Carol')
  t.send(alice, { t: 'share' })
  const annotate = (who: { conn: string }, ops: object[], share = alice.id) =>
    t.send(who, { t: 'annotate', share, ops })
  return { t, alice, bob, carol, annotate }
}

describe('annotate: what the others get', () => {
  it('goes to everyone in the room but the sender, stamped with who drew it', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: { ...pen('s1'), by: 'carol-forged' }, live: true }])
    const stroke = { ...pen('s1'), by: bob.id }
    expect(carol.client.of('annotation')).toEqual([
      {
        t: 'annotation',
        share: alice.id,
        by: bob.id,
        ops: [{ op: 'add', stroke, live: true }],
      },
    ])
    expect(alice.client.of('annotation')).toHaveLength(1)
    // It drew it already
    expect(bob.client.of('annotation')).toEqual([])
    expect(t.host.annotationsOf(alice.id)).toEqual([stroke])
  })

  it('passes incremental points on and keeps the stroke up to date', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s1'), live: true }])
    annotate(bob, [{ op: 'update', id: 's1', at: 1, points: [[0.2, 0.2]] }])
    annotate(bob, [
      {
        op: 'update',
        id: 's1',
        at: 2,
        points: [
          [0.3, 0.3],
          [0.4, 0.4],
        ],
      },
    ])
    expect(t.host.annotationsOf(alice.id)[0].points).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
      [0.4, 0.4],
    ])
    expect(carol.client.of('annotation')).toHaveLength(3)
  })

  it('the final add replaces the live stroke, in its place', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s1'), live: true }])
    annotate(carol, [{ op: 'add', stroke: pen('c1') }])
    annotate(bob, [{ op: 'add', stroke: pen('s1', [[0.5, 0.5]]) }])
    expect(t.host.annotationsOf(alice.id).map((stroke) => stroke.id)).toEqual(['s1', 'c1'])
    expect(t.host.annotationsOf(alice.id)[0].points).toEqual([[0.5, 0.5]])
  })

  it('a member changes and removes only their own strokes', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s1') }])
    const heard = () => alice.client.of('annotation').length
    const before = heard()
    annotate(carol, [{ op: 'update', id: 's1', at: 1, points: [[0.9, 0.9]] }])
    annotate(carol, [{ op: 'remove', id: 's1' }])
    expect(heard()).toBe(before)
    // Their own `add` with someone else's id comes back removed, and the stroke stays Bob's
    annotate(carol, [{ op: 'add', stroke: pen('s1', [[0.7, 0.7]]) }])
    expect(carol.client.of('annotation').at(-1)).toEqual({
      t: 'annotation',
      share: alice.id,
      by: null,
      ops: [{ op: 'remove', id: 's1' }],
    })
    expect(t.host.annotationsOf(alice.id)).toEqual([{ ...pen('s1'), by: bob.id }])
    annotate(bob, [{ op: 'remove', id: 's1' }])
    expect(t.host.annotationsOf(alice.id)).toEqual([])
  })

  it('clear takes the sender\'s own strokes, nobody else\'s', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('b1') }])
    annotate(carol, [{ op: 'add', stroke: pen('c1') }])
    annotate(bob, [{ op: 'clear' }])
    expect(t.host.annotationsOf(alice.id).map((stroke) => stroke.id)).toEqual(['c1'])
    expect(alice.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'clear', by: bob.id }])
  })

  it('the laser pointer goes to the others and is kept nowhere', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    const writes = t.disk.writes
    annotate(bob, [{ op: 'laser', at: [0.3, 0.4], color: 'amber' }])
    t.tick(ANNOTATION_FLUSH_MS * 3)
    expect(carol.client.of('annotation').at(-1)).toEqual({
      t: 'annotation',
      share: alice.id,
      by: bob.id,
      ops: [{ op: 'laser', at: [0.3, 0.4], color: 'amber' }],
    })
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    expect(t.disk.writes).toBe(writes)
    const dave = t.join('Dave')
    expect(dave.client.of('annotations')).toEqual([
      { t: 'annotations', share: null, strokes: [], reset: true, done: true },
    ])
  })

  it('each share has its own layer', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    t.send(bob, { t: 'share' })
    annotate(carol, [{ op: 'add', stroke: pen('on-alice') }], alice.id)
    annotate(carol, [{ op: 'add', stroke: pen('on-bob') }], bob.id)
    expect(t.host.annotationsOf(alice.id).map((stroke) => stroke.id)).toEqual(['on-alice'])
    expect(t.host.annotationsOf(bob.id).map((stroke) => stroke.id)).toEqual(['on-bob'])
    t.send(bob, { t: 'unshare' })
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    expect(t.host.annotationsOf(alice.id)).toHaveLength(1)
  })
})

describe('annotate: who may', () => {
  it('someone in the waiting room may not, and gets no strokes either', () => {
    const { t, alice, bob, annotate } = sharing()
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const dave = t.join('Dave')
    annotate(dave, [{ op: 'add', stroke: pen('d1') }])
    expect(dave.client.of('error')).toEqual([{ t: 'error', code: 'forbidden' }])
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    annotate(bob, [{ op: 'add', stroke: pen('b1') }])
    expect(dave.client.of('annotation').flatMap((frame) => frame.ops)).toEqual([
      { op: 'remove', id: 'd1' },
    ])
    expect(dave.client.of('annotations')).toEqual([])
  })

  it('a share that is not there: nothing kept, and the sender is told the layer is gone', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('b1') }], carol.id)
    expect(t.host.annotationsOf(carol.id)).toEqual([])
    expect(bob.client.of('annotation')).toEqual([
      { t: 'annotation', share: carol.id, by: null, ops: [{ op: 'clear' }] },
    ])
    expect(bob.client.of('error')).toEqual([])
    expect(alice.client.of('annotation')).toEqual([])
  })

  it('malformed frames are refused whole', () => {
    const { t, alice, bob, annotate } = sharing()
    for (const ops of [
      [],
      [{ op: 'add', stroke: { ...pen('x'), tool: 'spray' } }],
      [{ op: 'add', stroke: { ...pen('x'), points: [[2, 2]] } }],
      [{ op: 'add', stroke: pen('good') }, { op: 'nonsense' }],
      [{ op: 'update', id: 'x', at: -1, points: [[0.1, 0.1]] }],
      [{ op: 'laser', at: [0.1], color: 'rose' }],
      Array.from({ length: 33 }, (_, i) => ({ op: 'add', stroke: pen(`s${i}`) })),
    ]) {
      annotate(bob, ops as object[])
    }
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    expect(bob.client.of('error').every((error) => error.code === 'bad_message')).toBe(true)
    expect(bob.client.of('error')).toHaveLength(7)
  })
})

describe('annotate: limits', () => {
  it('a browser keeping its pace is never near closing the socket', () => {
    expect(ANNOTATION_FRAME_RATE.count).toBeGreaterThanOrEqual(100)
    expect(ANNOTATION_FRAME_RATE.count).toBeLessThan(SOCKET_MESSAGE_RATE.count)
    expect(ANNOTATION_FRAME_RATE.windowMs).toBe(SOCKET_MESSAGE_RATE.windowMs)
  })

  it('frames over the rate are dropped; a refused stroke comes back; the socket stays', () => {
    const { t, alice, bob, annotate } = sharing()
    for (let i = 0; i < ANNOTATION_FRAME_RATE.count; i++) {
      annotate(bob, [{ op: 'laser', at: [0.1, 0.1], color: 'rose' }])
    }
    expect(bob.client.of('error')).toEqual([])
    annotate(bob, [{ op: 'add', stroke: pen('late') }])
    expect(bob.client.of('error')).toEqual([{ t: 'error', code: 'annotation_limit' }])
    expect(bob.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'remove', id: 'late' }])
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    expect(t.closes).toEqual([])
    t.tick(ANNOTATION_FRAME_RATE.windowMs)
    annotate(bob, [{ op: 'add', stroke: pen('later') }])
    expect(t.host.annotationsOf(alice.id)).toHaveLength(1)
  })

  it('new strokes over the rate are refused; finishing one that exists still works', () => {
    const { t, alice, bob, annotate } = sharing()
    let sent = 0
    while (sent < ANNOTATION_STROKE_RATE.count) {
      annotate(bob, [{ op: 'add', stroke: pen(`s${sent}`), live: true }])
      sent += 1
    }
    annotate(bob, [{ op: 'add', stroke: pen('one-too-many') }])
    expect(bob.client.of('error').at(-1)).toEqual({ t: 'error', code: 'annotation_limit' })
    expect(t.host.annotationsOf(alice.id)).toHaveLength(ANNOTATION_STROKE_RATE.count)
    annotate(bob, [{ op: 'add', stroke: pen('s0', [[0.6, 0.6]]) }])
    expect(t.host.annotationsOf(alice.id)[0].points).toEqual([[0.6, 0.6]])
  })

  it('an update that would pass the point limit does not apply', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s', longPath(800)) }])
    annotate(bob, [{ op: 'update', id: 's', at: 800, points: [[0.5, 0.5]] }])
    expect(t.host.annotationsOf(alice.id)[0].points).toHaveLength(800)
    // A gap neither
    annotate(bob, [{ op: 'update', id: 's', at: 801, points: [[0.5, 0.5]] }])
    expect(t.host.annotationsOf(alice.id)[0].points).toHaveLength(800)
  })

  it('past a member\'s stroke limit their own oldest falls out, and everyone hears', () => {
    const layers = new RoomAnnotations()
    for (let i = 0; i < MAX_MEMBER_STROKES; i++) {
      expect(layers.put('a', { ...pen(`s${i}`), by: 'bob' })!.evicted).toEqual([])
    }
    layers.put('a', { ...pen('c'), by: 'carol' })
    expect(layers.put('a', { ...pen('next'), by: 'bob' })!.evicted).toEqual(['s0'])
    expect(layers.has('a', 'c')).toBe(true)
  })

  it('past a member\'s size limit too', () => {
    const layers = new RoomAnnotations()
    let evicted: string[] = []
    let total = 0
    for (let i = 0; total <= MAX_MEMBER_COST; i++) {
      evicted = layers.put('a', { ...pen(`s${i}`, longPath(800, i)), by: 'bob' })!.evicted
      total += 80 + 800 * 16
    }
    expect(evicted).toEqual(['s0'])
  })

  it('past the share\'s limits the oldest of anyone falls out, never the stroke just touched', () => {
    const layers = new RoomAnnotations()
    for (let i = 0; i < MAX_STROKES; i++) {
      layers.put('a', { ...pen(`s${i}`), by: `m${Math.floor(i / 100)}` })
    }
    expect(layers.strokes('a')).toHaveLength(MAX_STROKES)
    expect(layers.put('a', { ...pen('next'), by: 'new' })!.evicted).toEqual(['s0'])

    const size = new RoomAnnotations()
    const each = 80 + 800 * 16
    const fits = Math.floor(MAX_SHARE_COST / each)
    let last: string[] = []
    for (let i = 0; i <= fits; i++) {
      // Everyone different: only the share's own limit is in play
      last = size.put('a', { ...pen(`s${i}`, longPath(800, i)), by: `m${i}` })!.evicted
    }
    expect(last).toEqual(['s0'])
  })
})

describe('annotate: storage', () => {
  it('nothing is written per point: only a batch every ANNOTATION_FLUSH_MS', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s'), live: true }])
    for (let i = 1; i < 40; i++) {
      annotate(bob, [{ op: 'update', id: 's', at: i, points: [[i / 100, i / 100]] }])
      t.tick(100)
    }
    // Four seconds of drawing: not a row yet
    expect(t.disk.writes).toBe(0)
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.disk.writes).toBe(1)
    expect([...t.disk.segments.values()][0]).toMatchObject({ share: alice.id, segment: 0 })
    // Nothing new: nothing written
    t.tick(ANNOTATION_FLUSH_MS * 2)
    expect(t.disk.writes).toBe(1)
  })

  it('a lot of strokes in one flush are few rows', () => {
    const layers = new RoomAnnotations()
    let cost = 0
    for (let i = 0; cost < SEGMENT_CHARS * 3; i++) {
      layers.put('a', { ...pen(`s${i}`, longPath(100, i)), by: 'bob' })
      cost += 80 + 100 * 16
    }
    const writes = layers.takeWrites()
    expect(writes.length).toBeLessThanOrEqual(4)
    expect(writes.flatMap((write) => write.strokes ?? [])).toHaveLength(layers.strokes('a').length)
    expect(layers.takeWrites()).toEqual([])
  })

  it('survives eviction: same strokes, same order, new ones after them', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('b1') }])
    annotate(carol, [{ op: 'add', stroke: pen('c1') }])
    annotate(bob, [{ op: 'add', stroke: pen('b2') }])
    t.tick(ANNOTATION_FLUSH_MS)
    const before = t.host.annotationsOf(alice.id)
    const host = t.evict()
    expect(host.annotationsOf(alice.id)).toEqual(before)
    annotate(carol, [{ op: 'add', stroke: pen('c2') }])
    expect(host.annotationsOf(alice.id).map((stroke) => stroke.id)).toEqual([
      'b1',
      'c1',
      'b2',
      'c2',
    ])
    // Still theirs after waking: the owner may remove, nobody else
    annotate(carol, [{ op: 'remove', id: 'b1' }])
    expect(host.annotationsOf(alice.id)).toHaveLength(4)
    annotate(bob, [{ op: 'remove', id: 'b1' }])
    expect(host.annotationsOf(alice.id)).toHaveLength(3)
    // And that survives the next one
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.evict().annotationsOf(alice.id).map((stroke) => stroke.id)).toEqual([
      'c1',
      'b2',
      'c2',
    ])
  })

  it('a stroke being drawn survives too, once a batch has gone', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s'), live: true }])
    annotate(bob, [{ op: 'update', id: 's', at: 1, points: [[0.2, 0.2]] }])
    t.tick(ANNOTATION_FLUSH_MS)
    const host = t.evict()
    expect(host.annotationsOf(alice.id)[0].points).toHaveLength(2)
    // Its updates carry on
    annotate(bob, [{ op: 'update', id: 's', at: 2, points: [[0.3, 0.3]] }])
    expect(host.annotationsOf(alice.id)[0].points).toHaveLength(3)
  })

  it('the last socket going writes at once: the object may go to sleep next', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    expect(t.disk.writes).toBe(0)
    t.host.closed(alice.conn)
    t.host.closed(bob.conn)
    expect(t.disk.writes).toBe(0)
    t.host.closed(carol.conn)
    expect(t.disk.writes).toBe(1)
  })

  it('the alarm writes what is waiting too', () => {
    const { t, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.host.alarm()
    expect(t.disk.writes).toBe(1)
  })

  it('a restore drops segments of a share that already ended', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.disk.segments.size).toBe(1)
    t.disk.info = { ...t.disk.info!, shares: {} }
    const host = t.evict()
    expect(host.annotationsOf(alice.id)).toEqual([])
    expect(t.disk.segments.size).toBe(0)
  })
})

describe('annotate: snapshot', () => {
  it('someone late gets every share\'s strokes after the welcome, `reset` first, `done` last', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    t.send(bob, { t: 'share' })
    annotate(carol, [{ op: 'add', stroke: pen('a1') }], alice.id)
    annotate(carol, [{ op: 'add', stroke: pen('b1') }], bob.id)
    const dave = t.join('Dave')
    const kinds = dave.client.received.map((message) => message.t)
    expect(kinds.indexOf('annotations')).toBeGreaterThan(kinds.indexOf('welcome'))
    const frames = dave.client.of('annotations')
    expect(frames).toEqual([
      {
        t: 'annotations',
        share: alice.id,
        strokes: [{ ...pen('a1'), by: carol.id }],
        reset: true,
      },
      { t: 'annotations', share: bob.id, strokes: [{ ...pen('b1'), by: carol.id }], done: true },
    ])
  })

  it('a big layer comes in frames a socket can carry', () => {
    const layers = new RoomAnnotations()
    for (let i = 0; i < 40; i++) layers.put('a', { ...pen(`s${i}`, longPath(800, i)), by: 'bob' })
    const frames = layers.snapshot()
    expect(frames.length).toBeGreaterThan(1)
    expect(frames[0].reset).toBe(true)
    expect(frames.at(-1)!.done).toBe(true)
    for (const frame of frames) {
      expect(JSON.stringify(frame).length).toBeLessThan(SNAPSHOT_FRAME_CHARS * 1.3)
    }
    expect(frames.flatMap((frame) => frame.strokes).map((stroke) => stroke.id)).toEqual(
      layers.strokes('a').map((stroke) => stroke.id),
    )
  })

  it('a member reconnecting gets it again, also from a woken object', () => {
    const { t, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.tick(ANNOTATION_FLUSH_MS)
    const token = bob.client.of('welcome')[0].token
    t.host.closed(bob.conn)
    t.tick(1000)
    t.evict()
    t.clients.set('back', bob.client)
    bob.client.received = []
    t.host.opened('back')
    void t.host.message(
      'back',
      JSON.stringify({ t: 'join', name: 'Bob', token, client: null }),
    )
    expect(bob.client.of('annotations')[0]).toMatchObject({
      reset: true,
      done: true,
      strokes: [{ id: 's', by: bob.id }],
    })
  })
})

describe('annotate: the share stopping', () => {
  it('`unshare` clears the layer for everyone and in storage, at once', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.disk.segments.size).toBe(1)
    t.send(alice, { t: 'unshare' })
    expect(t.disk.segments.size).toBe(0)
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    for (const member of [alice, bob, carol]) {
      expect(member.client.of('annotation').at(-1)).toEqual({
        t: 'annotation',
        share: alice.id,
        by: null,
        ops: [{ op: 'clear' }],
      })
    }
    // A share started again starts clean, and so does someone joining
    t.send(alice, { t: 'share' })
    const dave = t.join('Dave')
    expect(dave.client.of('annotations')[0].strokes).toEqual([])
  })

  it('a host stopping it, or the sharer leaving, does the same', () => {
    const { t, alice, bob, carol, annotate } = sharing()
    t.send(bob, { t: 'share' })
    annotate(carol, [{ op: 'add', stroke: pen('on-bob') }], bob.id)
    t.send(alice, { t: 'host', action: 'stopShare', memberId: bob.id })
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    annotate(carol, [{ op: 'add', stroke: pen('on-alice') }], alice.id)
    t.send(alice, { t: 'leave' })
    expect(t.host.annotationsOf(alice.id)).toEqual([])
    expect(carol.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'clear' }])
  })

  it('stays while the sharer reconnects', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.host.closed(alice.conn)
    expect(t.host.annotationsOf(alice.id)).toHaveLength(1)
  })

  it('a drawer leaving leaves their strokes on the share', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.send(bob, { t: 'leave' })
    expect(t.host.annotationsOf(alice.id)).toHaveLength(1)
  })

  it('the meeting ending takes everything along', () => {
    const { t, alice, bob, annotate } = sharing()
    annotate(bob, [{ op: 'add', stroke: pen('s') }])
    t.tick(ANNOTATION_FLUSH_MS)
    t.send(alice, { t: 'host', action: 'endMeeting' })
    expect(t.disk.segments.size).toBe(0)
    expect(t.host.annotationsOf(alice.id)).toEqual([])
  })
})
