// J3 (e7-t05, e7-t06; AC-7.3, AC-7.4): who may annotate, clearing other people's marks, and the
// whiteboard as one more layer: world coordinates, its own limits, batched storage, replay, and a
// restore (hibernation, eviction) bringing it back whether it is open or closed.
import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_FLUSH_MS,
  MAX_BOARD_COST,
  MAX_BOARD_MEMBER_COST,
  MAX_BOARD_MEMBER_STROKES,
  MAX_BOARD_STROKES,
  MAX_BOARD_STROKE_POINTS,
} from '../../shared/annotation-limits.ts'
import { WHITEBOARD_LAYER, type NormPoint, type Stroke } from '../../shared/annotation.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  MAX_CLIENT_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  parseClientMessage,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import { RoomAnnotations } from '../../worker/room-annotations.ts'
import type { AnnotationSegment, AnnotationWrite } from '../../worker/room-annotations.ts'
import { RoomHost, type SessionRecord } from '../../worker/room-host.ts'

const V = String(PROTOCOL_VERSION)
const ROOM = { id: 'abcdefghij', createdAt: 1000 }

class FakeClient {
  received: ServerMessage[] = []
  view: RoomView | null = null

  receive(message: ServerMessage) {
    this.received.push(message)
    if (message.t === 'welcome' || message.t === 'snapshot') this.view = message.state
    else if (message.t === 'patch') {
      this.view = applyPatch(viewAsJson(this.view!), message.ops) as RoomView
    }
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t)
  }

  get errors(): string[] {
    return this.of('error').map((message) => message.code)
  }
}

function setup() {
  let clock = 10_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    segments: new Map<string, AnnotationSegment>(),
    writes: 0,
  }
  let timers: { at: number; work: () => void }[] = []
  const makeHost = () =>
    new RoomHost({
      sockets: {
        send: (conn, message) => clients.get(conn)?.receive(message),
        close: () => {},
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
    join,
    send,
    tick,
    evict,
  }
}

const pen = (id: string, points: NormPoint[] = [[0.1, 0.1]]): Omit<Stroke, 'by'> => ({
  id,
  tool: 'pen',
  color: 'rose',
  width: 'medium',
  points,
})

const add = (id: string, points?: NormPoint[]) => ({ op: 'add', stroke: pen(id, points) })
const laser = { op: 'laser', at: [0.5, 0.5], color: 'blue' }

/** Alice (host) is joined by Bob (a sharer), Carol (a co-host) and Dave */
function room() {
  const t = setup()
  const alice = t.join('Alice')
  const bob = t.join('Bob')
  const carol = t.join('Carol')
  const dave = t.join('Dave')
  t.send(alice, { t: 'host', action: 'setCohost', memberId: carol.id, on: true })
  t.send(bob, { t: 'share' })
  const annotate = (who: { conn: string }, ops: object[], share = bob.id) =>
    t.send(who, { t: 'annotate', share, ops })
  const policy = (who: { conn: string }, value: string) =>
    t.send(who, { t: 'host', action: 'annotationPolicy', policy: value })
  return { t, alice, bob, carol, dave, annotate, policy }
}

describe('the annotation policy: who may set it', () => {
  it('starts with everyone, and the host or a co-host changes it for everyone to see', () => {
    const { alice, carol, dave, policy } = room()
    expect(dave.client.view?.room.annotationPolicy).toBe('everyone')
    policy(alice, 'sharer')
    expect(dave.client.view?.room.annotationPolicy).toBe('sharer')
    policy(carol, 'off')
    expect(dave.client.view?.room.annotationPolicy).toBe('off')
  })

  it('refuses a participant, and a sharer: sharing is not running the room', () => {
    const { bob, dave, policy } = room()
    policy(dave, 'off')
    policy(bob, 'off')
    expect(dave.client.errors).toEqual(['forbidden'])
    expect(bob.client.errors).toEqual(['forbidden'])
    expect(dave.client.view?.room.annotationPolicy).toBe('everyone')
  })

  it('refuses a state that does not exist, as a bad message', () => {
    expect(
      parseClientMessage(JSON.stringify({ t: 'host', action: 'annotationPolicy', policy: 'all' })),
    ).toBeNull()
  })

  it('tells everyone else who changed it, once, and nobody when nothing changed', () => {
    const { alice, bob, dave, policy } = room()
    policy(alice, 'off')
    policy(alice, 'off')
    expect(dave.client.of('notice')).toEqual([
      { t: 'notice', notice: 'annotationPolicy', by: alice.id, policy: 'off' },
    ])
    expect(bob.client.of('notice')).toHaveLength(1)
    expect(alice.client.of('notice').filter((n) => n.notice === 'annotationPolicy')).toEqual([])
  })

  it('survives an eviction', () => {
    const { t, alice, policy } = room()
    policy(alice, 'sharer')
    expect(t.disk.info?.annotationPolicy).toBe('sharer')
    t.evict()
    expect(t.disk.info?.annotationPolicy).toBe('sharer')
  })

  it('reads as everyone in a room stored before it existed', () => {
    const { t } = room()
    const { annotationPolicy: _policy, whiteboard: _board, ...old } = t.disk.info!
    t.disk.info = old as RoomInfo
    t.evict()
    const late = t.join('Late')
    expect(late.client.view?.room.annotationPolicy).toBe('everyone')
    expect(late.client.view?.room.whiteboard).toBeNull()
  })
})

describe('the annotation policy: who may draw', () => {
  it('everyone: anyone in the meeting', () => {
    const { t, bob, dave, annotate } = room()
    annotate(dave, [add('d1')])
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['d1'])
    expect(dave.client.errors).toEqual([])
  })

  it('sharer: the host, a co-host and who shares; nobody else', () => {
    const { t, alice, bob, carol, dave, annotate, policy } = room()
    policy(alice, 'sharer')
    annotate(alice, [add('a1')])
    annotate(bob, [add('b1')])
    annotate(carol, [add('c1')])
    annotate(dave, [add('d1')])
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['a1', 'b1', 'c1'])
    expect(dave.client.errors).toEqual(['forbidden'])
    // Its own browser takes it back
    expect(dave.client.of('annotation').at(-1)).toMatchObject({
      ops: [{ op: 'remove', id: 'd1' }],
    })
  })

  it('sharer: someone sharing is no one on another person\'s share', () => {
    const { t, alice, dave, annotate, policy } = room()
    policy(alice, 'sharer')
    t.send(dave, { t: 'share' })
    annotate(dave, [add('mine')], dave.id)
    expect(t.host.annotationsOf(dave.id).map((s) => s.id)).toEqual(['mine'])
    annotate(dave, [add('theirs')])
    expect(dave.client.errors).toEqual(['forbidden'])
  })

  it('off: nobody, the host included; what was drawn stays', () => {
    const { t, alice, bob, carol, dave, annotate, policy } = room()
    annotate(dave, [add('before')])
    policy(alice, 'off')
    for (const who of [alice, bob, carol, dave]) annotate(who, [add(`x${who.id}`)])
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['before'])
    for (const who of [alice, bob, carol, dave]) expect(who.client.errors).toEqual(['forbidden'])
  })

  it('off: a forged frame reaches nobody, whatever is in it', () => {
    const { bob, dave, annotate, alice, policy } = room()
    policy(alice, 'off')
    const seen = bob.client.of('annotation').length
    annotate(dave, [add('forged'), { op: 'update', id: 'forged', at: 1, points: [[0.2, 0.2]] }, laser])
    expect(bob.client.of('annotation')).toHaveLength(seen)
    expect(dave.client.errors).toEqual(['forbidden'])
  })

  it('off: taking back one\'s own marks still works, so a stroke interrupted leaves nothing', () => {
    const { t, bob, alice, dave, annotate, policy } = room()
    annotate(dave, [{ ...add('live'), live: true }, add('kept')])
    policy(alice, 'off')
    annotate(dave, [{ op: 'remove', id: 'live' }])
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['kept'])
    annotate(dave, [{ op: 'clear' }])
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    expect(dave.client.errors).toEqual([])
    expect(bob.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'clear', by: dave.id }])
  })

  it('a stroke the room refused to finish goes for everyone, not only its author', () => {
    const { t, alice, bob, dave, annotate, policy } = room()
    annotate(dave, [{ ...add('half'), live: true }])
    policy(alice, 'off')
    annotate(dave, [add('half')])
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    expect(alice.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'remove', id: 'half' }])
  })

  it('takes effect again when it is turned back on', () => {
    const { t, alice, bob, dave, annotate, policy } = room()
    policy(alice, 'off')
    policy(alice, 'everyone')
    annotate(dave, [add('d1')])
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['d1'])
  })
})

describe('clearing other people\'s marks', () => {
  const clear = (t: ReturnType<typeof setup>, who: { conn: string }, share: string, by: string | null) =>
    t.send(who, { t: 'clearAnnotations', share, by })

  function marked() {
    const r = room()
    r.annotate(r.alice, [add('a1')])
    r.annotate(r.dave, [add('d1'), add('d2')])
    return r
  }

  it('the host clears everything, for everyone and from storage at once', () => {
    const { t, alice, bob, carol, dave } = marked()
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.disk.segments.size).toBe(1)
    clear(t, alice, bob.id, null)
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    expect(t.disk.segments.size).toBe(0)
    for (const who of [alice, bob, carol, dave]) {
      expect(who.client.of('annotation').at(-1)).toEqual({
        t: 'annotation',
        share: bob.id,
        by: alice.id,
        ops: [{ op: 'clear' }],
      })
    }
  })

  it('a co-host clears one person\'s, leaving the others\'', () => {
    const { t, alice, bob, carol, dave } = marked()
    clear(t, carol, bob.id, dave.id)
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['a1'])
    expect(alice.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'clear', by: dave.id }])
  })

  it('the sharer clears on their own share, the host\'s marks too', () => {
    const { t, bob, alice } = marked()
    clear(t, bob, bob.id, alice.id)
    expect(t.host.annotationsOf(bob.id).map((s) => s.id)).toEqual(['d1', 'd2'])
    clear(t, bob, bob.id, null)
    expect(t.host.annotationsOf(bob.id)).toEqual([])
    expect(bob.client.errors).toEqual([])
  })

  it('refuses a participant, even for their own: their own has its op', () => {
    const { t, bob, dave } = marked()
    clear(t, dave, bob.id, null)
    clear(t, dave, bob.id, dave.id)
    expect(dave.client.errors).toEqual(['forbidden', 'forbidden'])
    expect(t.host.annotationsOf(bob.id)).toHaveLength(3)
  })

  it('refuses a sharer on someone else\'s share', () => {
    const { t, bob, dave } = marked()
    t.send(dave, { t: 'share' })
    clear(t, dave, bob.id, null)
    expect(dave.client.errors).toEqual(['forbidden'])
  })

  it('works with the policy off: that is when it is still needed', () => {
    const { t, alice, bob, policy } = marked()
    policy(alice, 'off')
    clear(t, alice, bob.id, null)
    expect(t.host.annotationsOf(bob.id)).toEqual([])
  })

  it('tells who lost something and the sharer, not the one who did it, nor anyone else', () => {
    const { t, alice, bob, carol, dave } = marked()
    clear(t, alice, bob.id, dave.id)
    const told = { t: 'notice', notice: 'annotationsCleared', by: alice.id, layer: bob.id }
    expect(dave.client.of('notice').at(-1)).toEqual(told)
    expect(bob.client.of('notice').at(-1)).toEqual(told)
    expect(alice.client.of('notice').filter((n) => n.notice === 'annotationsCleared')).toEqual([])
    expect(carol.client.of('notice').filter((n) => n.notice === 'annotationsCleared')).toEqual([])
  })

  it('says it was everything when it was', () => {
    const { t, alice, bob, dave } = marked()
    clear(t, alice, bob.id, null)
    expect(dave.client.of('notice').at(-1)).toMatchObject({ all: true, layer: bob.id })
  })

  it('tells nobody when there was nothing of theirs', () => {
    const { t, alice, bob, carol } = marked()
    const before = bob.client.of('notice').length
    clear(t, alice, bob.id, carol.id)
    expect(bob.client.of('notice')).toHaveLength(before)
  })

  it('a cleared share stays clear after an eviction', () => {
    const { t, alice, bob } = marked()
    t.tick(ANNOTATION_FLUSH_MS)
    clear(t, alice, bob.id, null)
    t.evict()
    expect(t.host.annotationsOf(bob.id)).toEqual([])
  })

  it('a share that ended has nothing to clear', () => {
    const { t, alice, dave } = marked()
    clear(t, alice, dave.id, null)
    expect(alice.client.errors).toEqual(['forbidden'])
  })
})

describe('the whiteboard: open and closed', () => {
  const board = (who: { conn: string }, ops: object[], t: ReturnType<typeof setup>) =>
    t.send(who, { t: 'annotate', share: WHITEBOARD_LAYER, ops })

  it('is closed at first, and anyone may open it while anyone may draw', () => {
    const { t, alice, dave } = room()
    expect(alice.client.view?.room.whiteboard).toBeNull()
    t.send(dave, { t: 'whiteboard', open: true })
    expect(alice.client.view?.room.whiteboard).toMatchObject({ by: dave.id })
  })

  it('with the policy narrowed, only a host or co-host opens it', () => {
    const { t, alice, carol, dave, policy } = room()
    policy(alice, 'sharer')
    t.send(dave, { t: 'whiteboard', open: true })
    expect(dave.client.errors).toEqual(['forbidden'])
    expect(alice.client.view?.room.whiteboard).toBeNull()
    t.send(carol, { t: 'whiteboard', open: true })
    expect(alice.client.view?.room.whiteboard).toMatchObject({ by: carol.id })
  })

  it('whoever opened it, a host or a co-host closes it; nobody else does', () => {
    const { t, alice, bob, carol, dave } = room()
    t.send(dave, { t: 'whiteboard', open: true })
    t.send(bob, { t: 'whiteboard', open: false })
    expect(bob.client.errors).toEqual(['forbidden'])
    t.send(dave, { t: 'whiteboard', open: false })
    expect(alice.client.view?.room.whiteboard).toBeNull()
    t.send(dave, { t: 'whiteboard', open: true })
    t.send(carol, { t: 'whiteboard', open: false })
    expect(alice.client.view?.room.whiteboard).toBeNull()
  })

  it('opening it twice keeps who opened it first', () => {
    const { t, alice, dave } = room()
    t.send(dave, { t: 'whiteboard', open: true })
    t.send(alice, { t: 'whiteboard', open: true })
    expect(alice.client.view?.room.whiteboard).toMatchObject({ by: dave.id })
  })

  it('someone waiting neither opens it nor draws on it', () => {
    const { t, alice } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    t.send(alice, { t: 'host', action: 'waitingRoom', on: true })
    const waiter = t.join('Waiter')
    const conn = { conn: waiter.conn }
    t.send(conn, { t: 'whiteboard', open: true })
    board(conn, [add('w1')], t)
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
  })

  it('closed, it refuses strokes, without saying the layer is gone', () => {
    const { t, alice, dave } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    board(dave, [add('kept')], t)
    t.send(alice, { t: 'whiteboard', open: false })
    board(dave, [add('late')], t)
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['kept'])
    expect(dave.client.errors).toEqual(['forbidden'])
    expect(dave.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'remove', id: 'late' }])
  })

  it('closing keeps the strokes, opening brings them back', () => {
    const { t, alice, dave } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    board(dave, [add('kept')], t)
    t.send(alice, { t: 'whiteboard', open: false })
    t.send(dave, { t: 'whiteboard', open: true })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['kept'])
  })

  it('its strokes do not depend on anyone sharing or staying', () => {
    const { t, alice, bob, dave } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    board(dave, [add('kept')], t)
    t.send(bob, { t: 'unshare' })
    t.send(dave, { t: 'leave' })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['kept'])
  })

  it('goes when the meeting ends, in a room that stays too (keeping it is J4)', () => {
    const { t, alice } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    board(alice, [add('a1')], t)
    t.tick(ANNOTATION_FLUSH_MS)
    t.send(alice, { t: 'host', action: 'endMeeting' })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
    expect(t.disk.segments.size).toBe(0)
  })
})

describe('the whiteboard: who may draw and clear', () => {
  function open() {
    const r = room()
    r.t.send(r.dave, { t: 'whiteboard', open: true })
    const board = (who: { conn: string }, ops: object[]) =>
      r.t.send(who, { t: 'annotate', share: WHITEBOARD_LAYER, ops })
    return { ...r, board }
  }

  it('everyone: anyone', () => {
    const { t, bob, board } = open()
    board(bob, [add('b1', [[-3.5, 12.25]])])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)[0].points).toEqual([[-3.5, 12.25]])
  })

  it('sharer: the host, a co-host and who opened it, not who shares something else', () => {
    const { t, alice, bob, carol, dave, board, policy } = open()
    policy(alice, 'sharer')
    board(alice, [add('a1')])
    board(carol, [add('c1')])
    board(dave, [add('d1')])
    board(bob, [add('b1')])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['a1', 'c1', 'd1'])
    expect(bob.client.errors).toEqual(['forbidden'])
  })

  it('off: nobody', () => {
    const { t, alice, dave, board, policy } = open()
    policy(alice, 'off')
    board(alice, [add('a1')])
    board(dave, [add('d1')])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
  })

  it('who opened it may clear it; another participant may not', () => {
    const { t, bob, dave, board } = open()
    board(bob, [add('b1')])
    t.send(bob, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    expect(bob.client.errors).toEqual(['forbidden'])
    t.send(dave, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: bob.id })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
    expect(bob.client.of('notice').at(-1)).toEqual({
      t: 'notice',
      notice: 'annotationsCleared',
      by: dave.id,
      layer: WHITEBOARD_LAYER,
    })
  })
})

describe('the whiteboard: world coordinates on the wire', () => {
  const frame = (points: unknown[]) =>
    JSON.stringify({
      t: 'annotate',
      share: WHITEBOARD_LAYER,
      ops: [{ op: 'add', stroke: { ...pen('s'), points } }],
    })

  it('takes points far outside 0–1, inside the world', () => {
    expect(parseClientMessage(frame([[-999.5, 1000]]))).toMatchObject({
      ops: [{ stroke: { points: [[-999.5, 1000]] } }],
    })
  })

  it('refuses points past the world\'s edge', () => {
    expect(parseClientMessage(frame([[1000.5, 0]]))).toBeNull()
  })

  it('still holds a share to 0–1', () => {
    const message = JSON.stringify({
      t: 'annotate',
      share: 'someone',
      ops: [{ op: 'add', stroke: { ...pen('s'), points: [[1.5, 0.5]] } }],
    })
    expect(parseClientMessage(message)).toBeNull()
  })

  it('a whole stroke at the limit, as far out as can be, fits one message', () => {
    const points = Array.from(
      { length: MAX_BOARD_STROKE_POINTS },
      (): [number, number] => [-999.1234, -999.1234],
    )
    const message = frame(points)
    expect(message.length).toBeLessThan(MAX_CLIENT_MESSAGE_CHARS)
    expect(parseClientMessage(message)).not.toBeNull()
    expect(parseClientMessage(frame([...points, [0, 0]]))).toBeNull()
  })
})

describe('the whiteboard: its limits', () => {
  const stroke = (id: string, by: string, count = 1): Stroke => ({
    ...pen(id, Array.from({ length: count }, (_, i): NormPoint => [i / 100, 0])),
    by,
  })
  const fill = (layers: RoomAnnotations, count: number, by: (i: number) => string, points = 1) => {
    for (let i = 0; i < count; i++) {
      const next = stroke(`s${i}`, by(i), points)
      expect(layers.overflows(WHITEBOARD_LAYER, next)).toBe(false)
      expect(layers.put(WHITEBOARD_LAYER, next)?.evicted).toEqual([])
    }
  }

  it('nothing falls out; one member past their share is refused, the others not', () => {
    const layers = new RoomAnnotations()
    fill(layers, MAX_BOARD_MEMBER_STROKES, () => 'bob')
    expect(layers.overflows(WHITEBOARD_LAYER, stroke('next', 'bob'))).toBe(true)
    expect(layers.overflows(WHITEBOARD_LAYER, stroke('next', 'carol'))).toBe(false)
    expect(layers.strokes(WHITEBOARD_LAYER)).toHaveLength(MAX_BOARD_MEMBER_STROKES)
  })

  it('the board as a whole has a limit', () => {
    const layers = new RoomAnnotations()
    fill(layers, MAX_BOARD_STROKES, (i) => `m${i % 10}`)
    expect(layers.overflows(WHITEBOARD_LAYER, stroke('next', 'new'))).toBe(true)
  })

  it('a member\'s cost has a limit, and so does the whole board\'s', () => {
    const member = new RoomAnnotations()
    const each = 600
    const fits = Math.floor(MAX_BOARD_MEMBER_COST / (80 + each * 16))
    fill(member, fits, () => 'bob', each)
    expect(member.overflows(WHITEBOARD_LAYER, stroke('next', 'bob', each))).toBe(true)

    const whole = new RoomAnnotations()
    const total = Math.floor(MAX_BOARD_COST / (80 + each * 16))
    fill(whole, total, (i) => `m${i % 20}`, each)
    expect(whole.overflows(WHITEBOARD_LAYER, stroke('next', 'new', each))).toBe(true)
  })

  it('a stroke that shrinks always fits: finishing one is never what goes over', () => {
    const layers = new RoomAnnotations()
    fill(layers, MAX_BOARD_MEMBER_STROKES, () => 'bob', 10)
    expect(layers.overflows(WHITEBOARD_LAYER, stroke('s0', 'bob', 5))).toBe(false)
  })

  it('a share keeps its J2 behaviour: never full, the oldest fall out', () => {
    const layers = new RoomAnnotations()
    expect(layers.overflows('a-share', stroke('x', 'bob', 800))).toBe(false)
  })

  it('in the room: refused with annotation_limit, and the sender takes it back', () => {
    const { t, alice, dave } = room()
    t.send(alice, { t: 'whiteboard', open: true })
    // Within the rate limits: many strokes over a long time
    for (let i = 0; i < MAX_BOARD_MEMBER_STROKES; i += 50) {
      const ops = Array.from({ length: 30 }, (_, j) => add(`s${i}-${j}`))
      t.send(dave, { t: 'annotate', share: WHITEBOARD_LAYER, ops })
      const more = Array.from({ length: 20 }, (_, j) => add(`t${i}-${j}`))
      t.send(dave, { t: 'annotate', share: WHITEBOARD_LAYER, ops: more })
      t.tick(11_000)
    }
    expect(dave.client.errors).toEqual([])
    t.send(dave, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('one-too-many')] })
    expect(dave.client.errors).toEqual(['annotation_limit'])
    expect(dave.client.of('annotation').at(-1)?.ops).toEqual([{ op: 'remove', id: 'one-too-many' }])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toHaveLength(MAX_BOARD_MEMBER_STROKES)
  })
})

describe('the whiteboard: storage and replay', () => {
  function drawn() {
    const r = room()
    r.t.send(r.alice, { t: 'whiteboard', open: true })
    r.t.send(r.dave, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('d1', [[-2, 3]])] })
    return r
  }

  it('writes in batches, not on every op', () => {
    const { t, dave } = drawn()
    const writes = t.disk.writes
    for (let i = 0; i < 20; i++) {
      t.send(dave, {
        t: 'annotate',
        share: WHITEBOARD_LAYER,
        ops: [{ op: 'update', id: 'd1', at: 1, points: [[i, i]] }],
      })
    }
    expect(t.disk.writes).toBe(writes)
    t.tick(ANNOTATION_FLUSH_MS)
    expect(t.disk.writes).toBe(writes + 1)
  })

  it('a late joiner gets the replay, in world coordinates', () => {
    const { t } = drawn()
    const late = t.join('Late')
    expect(late.client.of('annotations')).toEqual([
      {
        t: 'annotations',
        share: WHITEBOARD_LAYER,
        strokes: [{ ...pen('d1', [[-2, 3]]), by: expect.any(String) }],
        reset: true,
        done: true,
      },
    ])
  })

  it('survives an eviction, open', () => {
    const { t, alice } = drawn()
    t.tick(ANNOTATION_FLUSH_MS)
    t.evict()
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.points)).toEqual([[[-2, 3]]])
    expect(t.disk.info?.whiteboard).toMatchObject({ by: alice.id })
  })

  it('survives an eviction, closed: a closed board is not a share that ended', () => {
    const { t, alice } = drawn()
    t.send(alice, { t: 'whiteboard', open: false })
    t.tick(ANNOTATION_FLUSH_MS)
    t.evict()
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toHaveLength(1)
    expect(t.disk.segments.size).toBe(1)
  })
})
