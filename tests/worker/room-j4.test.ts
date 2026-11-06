// @vitest-environment node
// J4 (e7-t08; AC-7.4): a persistent room's whiteboard through R2, on a fake clock: saved at the end of
// a meeting, when the last person leaves and periodically; back in the next meeting; gone with the
// room; never touched by the 24-hour sweep; counted by the ledger. And (e7-t09) a stroke cleared
// while still being drawn stays gone.
import { describe, expect, it, vi } from 'vitest'
import {
  BOARD_SAVE_MS,
  MAX_ANNOTATION_TEXT_CHARS,
  MAX_BOARD_COST,
  MAX_BOARD_FILE_BYTES,
  MAX_BOARD_STROKES,
  MAX_BOARD_STROKE_POINTS,
} from '../../shared/annotation-limits.ts'
import {
  PAST_AUTHOR,
  WHITEBOARD_LAYER,
  strokeCost,
  type NormPoint,
  type Stroke,
} from '../../shared/annotation.ts'
import { BOARD_PREFIX, FILE_TTL_MS, uploadKey } from '../../shared/files.ts'
import { applyPatch } from '../../shared/patch.ts'
import {
  PROTOCOL_VERSION,
  viewAsJson,
  type RoomInfo,
  type RoomView,
  type ServerMessage,
} from '../../shared/protocol.ts'
import {
  BoardStore,
  boardKey,
  decodeBoard,
  encodeBoard,
  parseBoardKey,
} from '../../worker/board-store.ts'
import { FileLedger } from '../../worker/file-ledger.ts'
import { RoomAnnotations, type AnnotationSegment, type AnnotationWrite } from '../../worker/room-annotations.ts'
import {
  RoomHost,
  type BoardState,
  type PersistentRecord,
  type SessionRecord,
} from '../../worker/room-host.ts'
import { runSweep } from '../../worker/scheduled.ts'
import { sweepUploads } from '../../worker/sweep.ts'
import { fakeD1 } from './d1.ts'
import { FakeBucket, asBucket } from './files.fakes.ts'

const V = String(PROTOCOL_VERSION)
const SLUG = 'team-room'
const RECORD: PersistentRecord = { slug: SLUG, owner: 'account-1', createdAt: 5000 }
const KEY = boardKey(RECORD)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

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

  /** What a browser's store would hold of the board: the last snapshot, then the live ops */
  board(): string[] {
    const ids = new Set<string>()
    for (const message of this.received) {
      if (message.t === 'annotations') {
        if (message.reset) ids.clear()
        if (message.share === WHITEBOARD_LAYER) for (const s of message.strokes) ids.add(s.id)
      } else if (message.t === 'annotation' && message.share === WHITEBOARD_LAYER) {
        for (const op of message.ops) {
          if (op.op === 'add') ids.add(op.stroke.id)
          else if (op.op === 'remove') ids.delete(op.id)
          else if (op.op === 'clear') ids.clear()
        }
      }
    }
    return [...ids]
  }
}

const noSleep = () => Promise.resolve()

function ledgerOver(ledger: FileLedger, clock: () => number) {
  return {
    reserve: async (id: string, bytes: number) => ledger.reserve(id, bytes, clock()),
    commit: async (id: string, bytes: number, objects: number) => ledger.commit(id, bytes, objects),
    release: async (id: string) => ledger.release(id),
    forget: async (ids: string[], bytes: number, objects: number) =>
      ledger.forget(ids, bytes, objects),
  }
}

/** A persistent room with a real BoardStore over an in-memory bucket and a real FileLedger */
function setup({ persistent = true, cap }: { persistent?: boolean; cap?: number } = {}) {
  let clock = 1_000_000
  let nextId = 0
  let nextConn = 0
  const clients = new Map<string, FakeClient>()
  const bucket = new FakeBucket()
  const ledger = new FileLedger(null, cap)
  const store = new BoardStore(
    asBucket(bucket),
    ledgerOver(ledger, () => clock),
    () => clock,
    noSleep,
  )
  const disk = {
    info: null as RoomInfo | null,
    rev: 0,
    sessions: [] as SessionRecord[],
    segments: new Map<string, AnnotationSegment>(),
    board: null as BoardState | null,
  }
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
            const key = `${share}:${segment}`
            if (strokes === null) disk.segments.delete(key)
            else disk.segments.set(key, structuredClone({ share, segment, strokes }))
          }
        },
        saveBoardState: (state) => void (disk.board = state),
        clear: () => {
          disk.info = null
          disk.segments.clear()
          disk.board = null
        },
      },
      now: () => clock,
      newMemberId: () => `m${++nextId}`,
      newToken: () => `token-m${nextId}`.padEnd(43, '_'),
      boards: {
        load: (record) => store.load(boardKey(record)),
        save: (record, strokes) => store.save(boardKey(record), strokes),
        merge: (record, strokes) => store.merge(boardKey(record), strokes),
        remove: (record) => store.remove(boardKey(record)),
      },
    })
  let host = makeHost()
  if (persistent) expect(host.createPersistent(RECORD, '週會')).toBe(true)
  else host.create({ id: 'abcdefghij', createdAt: 1000 })
  /** As RoomDO.fetch does: the board first, then the socket */
  async function join(name: string) {
    await host.prepareBoard()
    expect(host.admit(V)).toEqual({ ok: true })
    const conn = `c${++nextConn}`
    const client = new FakeClient()
    clients.set(conn, client)
    host.opened(conn)
    await host.message(conn, JSON.stringify({ t: 'join', name, token: null, client: null }))
    return { conn, client, id: client.of('welcome')[0]?.you ?? '' }
  }
  const send = (who: { conn: string }, message: object) =>
    host.message(who.conn, JSON.stringify(message))
  /** Moves the clock and runs the alarm if it is due */
  const tick = (ms: number) => {
    clock += ms
    for (const conn of clients.keys()) host.heartbeat(conn, clock)
    const next = host.nextAlarm()
    if (next !== null && next <= clock) host.alarm()
  }
  const evict = () => {
    host = makeHost()
    const sockets = [...clients.keys()].map((conn) => ({ conn, openedAt: clock }))
    host.restore(disk.info, disk.rev, disk.sessions, sockets, null, null, [], [], {
      annotations: [...disk.segments.values()],
      persistent: persistent ? RECORD : null,
      board: disk.board,
    })
  }
  return {
    get host() {
      return host
    },
    get now() {
      return clock
    },
    bucket,
    ledger,
    store,
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

const add = (id: string, live = false) => ({
  op: 'add',
  stroke: pen(id),
  ...(live ? { live: true } : {}),
})

/** The host opens the board and draws */
async function draw(t: ReturnType<typeof setup>, who: { conn: string }, ...ids: string[]) {
  await t.send(who, { t: 'whiteboard', open: true })
  await t.send(who, {
    t: 'annotate',
    share: WHITEBOARD_LAYER,
    ops: ids.map((id) => add(id)),
  })
}

const stored = (bucket: FakeBucket, key = KEY) =>
  JSON.parse(new TextDecoder().decode(bucket.objects.get(key)!.bytes)) as {
    strokes: Stroke[]
  }

describe('a persistent room keeps its whiteboard across meetings', () => {
  it('saves when the meeting ends, and the next meeting has it', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a', 'b')
    await t.send(owner, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    expect([...t.bucket.objects.keys()]).toEqual([KEY])
    expect(KEY.startsWith(BOARD_PREFIX)).toBe(true)
    // It lasts as JSON, without who drew it: member ids end with their meeting
    const saved = stored(t.bucket)
    expect(saved.strokes.map((s) => s.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(saved)).not.toContain(owner.id)
    expect(saved.strokes.every((s) => s.by === PAST_AUTHOR)).toBe(true)

    const next = await t.join('Someone')
    expect(next.client.board()).toEqual(['a', 'b'])
    // Closed: whoever may open it opens it, and it is all there
    expect(next.client.view?.room.whiteboard).toBeNull()
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.by)).toEqual([PAST_AUTHOR, PAST_AUTHOR])
  })

  it('saves when an empty room closes, and when the last person leaves before that', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    expect(t.bucket.calls.put).toBe(0)
    t.host.closed(owner.conn)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(1)
    // Nothing changed since: the close that follows writes nothing
    for (let i = 0; i < 80; i += 1) t.tick(15_000)
    await t.store.idle()
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
    expect(t.bucket.calls.put).toBe(1)
    expect(t.bucket.objects.has(KEY)).toBe(true)
  })

  it('saves periodically while the meeting goes on, only what changed', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS - 1)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(0)
    t.tick(1)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(1)
    // A quiet quarter of an hour: nothing written
    t.tick(3 * BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(1)
    await t.send(owner, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('b')] })
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(2)
    expect(stored(t.bucket).strokes.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('the laser pointer is not a change', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await t.send(owner, { t: 'whiteboard', open: true })
    await t.send(owner, {
      t: 'annotate',
      share: WHITEBOARD_LAYER,
      ops: [{ op: 'laser', at: [0, 0], color: 'rose' }],
    })
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.bucket.calls.put).toBe(0)
  })

  it('a board cleared stays cleared: the saved object goes, and the ledger gets it back', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.ledger.record.objects).toBe(1)
    await t.send(owner, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    await t.send(owner, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    expect(t.bucket.objects.size).toBe(0)
    expect(t.ledger.record).toMatchObject({ bytes: 0, objects: 0 })
    const next = await t.join('Someone')
    expect(next.client.board()).toEqual([])
  })

  it('earlier strokes can be cleared by who may clear, without telling a member who is not there', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    await t.send(owner, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    const next = await t.join('Owner')
    await t.send(next, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: PAST_AUTHOR })
    expect(next.client.board()).toEqual([])
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
  })

  it('survives the object being evicted mid-meeting: nothing comes back, nothing is lost', async () => {
    const t = setup()
    const first = await t.join('Owner')
    await draw(t, first, 'a', 'b')
    await t.send(first, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    const owner = await t.join('Owner')
    await t.send(owner, { t: 'whiteboard', open: true })
    await t.send(owner, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    await t.send(owner, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('c')] })
    // Flushed with the last write the room makes before eviction
    t.host.alarm()
    const reads = t.bucket.calls.get
    t.evict()
    await t.host.prepareBoard()
    // Already read this meeting: not again, or the cleared strokes would come back
    expect(t.bucket.calls.get).toBe(reads)
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['c'])
    // And it still knows it has something to save
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(stored(t.bucket).strokes.map((s) => s.id)).toEqual(['c'])
  })

  it('reads once a meeting however many arrive at once', async () => {
    const t = setup()
    await Promise.all([t.join('A'), t.join('B'), t.join('C')])
    expect(t.bucket.calls.get).toBe(1)
  })
})

describe('when R2 is having a bad moment', () => {
  it('a read that fails does not lose what was saved: this meeting ends up on top of it', async () => {
    const t = setup()
    const first = await t.join('Owner')
    await draw(t, first, 'old')
    await t.send(first, { t: 'host', action: 'endMeeting' })
    await t.store.idle()

    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = vi.spyOn(t.bucket, 'get').mockRejectedValue(new Error('R2 down'))
    const owner = await t.join('Owner')
    expect(owner.client.board()).toEqual([])
    await t.send(owner, { t: 'whiteboard', open: true })
    await t.send(owner, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('new')] })
    // Periodic saves do not overwrite it while it is unread
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(stored(t.bucket).strokes.map((s) => s.id)).toEqual(['old'])
    get.mockRestore()
    await t.send(owner, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    log.mockRestore()
    expect(stored(t.bucket).strokes.map((s) => s.id).sort()).toEqual(['new', 'old'])
  })

  it('a read that fails is tried again, and those here get the board then', async () => {
    const t = setup()
    const first = await t.join('Owner')
    await draw(t, first, 'old')
    await t.send(first, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = vi.spyOn(t.bucket, 'get').mockRejectedValue(new Error('R2 down'))
    const early = await t.join('Early')
    expect(early.client.board()).toEqual([])
    get.mockRestore()
    log.mockRestore()
    const late = await t.join('Late')
    expect(late.client.board()).toEqual(['old'])
    expect(early.client.board()).toEqual(['old'])
  })

  it('a failed save is retried a second apart, then tried again at the next job', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const put = vi.spyOn(t.bucket, 'put').mockRejectedValue(new Error('R2 down'))
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(put).toHaveBeenCalledTimes(3)
    expect(t.ledger.status(t.now).reservedBytes).toBe(0)
    put.mockRestore()
    log.mockRestore()
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.bucket.objects.has(KEY)).toBe(true)
  })

  it('the bucket full: not saved, and the meeting does not notice', async () => {
    const t = setup({ cap: 10 })
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    log.mockRestore()
    expect(t.bucket.calls.put).toBe(0)
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toHaveLength(1)
  })
})

describe('gone with the room', () => {
  it('deleting the room (or its owner, which does the same) deletes the board and frees the count', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    expect(t.bucket.objects.has(KEY)).toBe(true)
    t.host.destroy()
    await t.host.boardGone
    expect(t.bucket.objects.size).toBe(0)
    expect(t.ledger.record).toMatchObject({ bytes: 0, objects: 0 })
  })

  it('a save under way when the room is deleted does not outlive it', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS)
    t.host.destroy()
    await t.host.boardGone
    expect(t.bucket.objects.size).toBe(0)
  })

  it('a deletion that fails is logged, and the sweep finishes it once the room is gone from D1', async () => {
    const t = setup()
    const owner = await t.join('Owner')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS)
    await t.store.idle()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remove = vi.spyOn(t.bucket, 'delete').mockRejectedValue(new Error('R2 down'))
    t.host.destroy()
    await t.host.boardGone
    remove.mockRestore()
    log.mockRestore()
    expect(t.bucket.objects.has(KEY)).toBe(true)

    const { db } = fakeD1()
    const reconcile = vi.fn(async () => {})
    await runSweep({ FILES_BUCKET: asBucket(t.bucket), DB: db }, { reconcile }, t.now)
    expect(t.bucket.objects.size).toBe(0)
    expect(reconcile.mock.calls[0]).toEqual([
      { bytes: 0, objects: 0 },
      { bytes: expect.any(Number), objects: 1 },
    ])
  })

  it('a room that is not persistent never touches R2', async () => {
    const t = setup({ persistent: false })
    const owner = await t.join('Someone')
    await draw(t, owner, 'a')
    t.tick(BOARD_SAVE_MS)
    await t.send(owner, { t: 'host', action: 'endMeeting' })
    await t.store.idle()
    expect(t.bucket.calls).toEqual({ put: 0, get: 0, list: 0, delete: 0 })
  })
})

describe('the hourly sweep and the ledger', () => {
  const byte = (bucket: FakeBucket, key: string, size: number) => {
    bucket.objects.set(key, { bytes: new Uint8Array(size) })
  }

  it('the 24 hours do not apply to a board, and it counts', async () => {
    const bucket = new FakeBucket()
    const now = Date.UTC(2026, 10, 5, 12)
    byte(bucket, KEY, 700)
    byte(bucket, uploadKey(now - 3 * DAY, 'old'), 100)
    byte(bucket, uploadKey(now, 'new'), 40)
    const later = now + FILE_TTL_MS * 365
    const result = await sweepUploads(asBucket(bucket), later)
    expect(bucket.objects.has(KEY)).toBe(true)
    expect(result.deleted).toEqual({ objects: 2, bytes: 140 })
    expect(result.live).toEqual({ objects: 1, bytes: 700 })
  })

  it('the count after a sweep has boards in it, so the 2 GB cap does too', async () => {
    const bucket = new FakeBucket()
    const now = Date.UTC(2026, 10, 5, 12)
    byte(bucket, KEY, 700)
    byte(bucket, uploadKey(now, 'new'), 40)
    const ledger = new FileLedger(null, 1000)
    await runSweep(
      { FILES_BUCKET: asBucket(bucket) },
      {
        reconcile: async (live, deleted) => ledger.reconcile(live, deleted, now),
      },
      now,
    )
    expect(ledger.record).toMatchObject({ bytes: 740, objects: 2 })
    expect(ledger.reserve('file', 300, now)).toMatchObject({ ok: false })
    expect(ledger.reserve('file', 200, now)).toMatchObject({ ok: true })
  })

  it('D1 decides which boards still have a room: same slug, same creation', async () => {
    const { db } = fakeD1()
    await db.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').bind('a', 'A', 1).run()
    await db.prepare('INSERT INTO rooms (slug, account_id, created_at) VALUES (?, ?, ?)').bind(SLUG, 'a', 5000).run()
    const bucket = new FakeBucket()
    byte(bucket, KEY, 10)
    // The same slug, deleted and claimed again later: the old board is not the new room's
    byte(bucket, boardKey({ slug: SLUG, createdAt: 1 }), 20)
    byte(bucket, boardKey({ slug: 'gone', createdAt: 5000 }), 30)
    const reconcile = vi.fn(async () => {})
    await runSweep({ FILES_BUCKET: asBucket(bucket), DB: db }, { reconcile }, Date.now())
    expect([...bucket.objects.keys()]).toEqual([KEY])
    expect(reconcile).toHaveBeenCalledWith({ bytes: 10, objects: 1 }, { bytes: 50, objects: 2 })
  })

  it('without an answer from D1 nothing is deleted on a guess', async () => {
    const bucket = new FakeBucket()
    byte(bucket, KEY, 10)
    const db = {
      prepare: () => {
        throw new Error('D1 down')
      },
    } as unknown as D1Database
    const reconcile = vi.fn(async () => {})
    await expect(
      runSweep({ FILES_BUCKET: asBucket(bucket), DB: db }, { reconcile }, Date.now()),
    ).rejects.toThrow('D1 down')
    expect(bucket.objects.has(KEY)).toBe(true)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('every put and head of a save counts through the ledger: growing, shrinking, replacing', async () => {
    const bucket = new FakeBucket()
    const ledger = new FileLedger(null)
    const store = new BoardStore(asBucket(bucket), ledgerOver(ledger, () => 1), () => 1, noSleep)
    const strokes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...pen(`s${i}`), by: 'x' }) as Stroke)
    await store.save(KEY, strokes(5))
    const five = bucket.objects.get(KEY)!.bytes.byteLength
    expect(ledger.record).toMatchObject({ bytes: five, objects: 1 })
    await store.save(KEY, strokes(9))
    const nine = bucket.objects.get(KEY)!.bytes.byteLength
    expect(ledger.record).toMatchObject({ bytes: nine, objects: 1 })
    await store.save(KEY, strokes(2))
    const two = bucket.objects.get(KEY)!.bytes.byteLength
    expect(two).toBeLessThan(nine)
    expect(ledger.record).toMatchObject({ bytes: two, objects: 1 })
    await store.save(KEY, [])
    expect(ledger.record).toMatchObject({ bytes: 0, objects: 0 })
  })

  it('board keys say whose board it is', () => {
    expect(parseBoardKey(KEY)).toEqual({ slug: SLUG, createdAt: 5000 })
    expect(parseBoardKey('uploads/x')).toBeNull()
    expect(parseBoardKey(`${BOARD_PREFIX}nested/deeper/1.json`)).toBeNull()
  })
})

describe('what is stored respects the board\'s limits', () => {
  /** As long as a stroke can be, every point as long as a point can be */
  const longest = (id: string): Stroke => ({
    id,
    by: 'someone',
    tool: 'pen',
    color: 'rose',
    width: 'thick',
    points: Array.from(
      { length: MAX_BOARD_STROKE_POINTS },
      () => [-999.1234, -999.1234] as NormPoint,
    ),
  })

  it('a full board with the longest points fits the largest file', () => {
    const strokes: Stroke[] = []
    let cost = 0
    while (cost + strokeCost(longest('')) <= MAX_BOARD_COST) {
      const stroke = longest(`stroke-${strokes.length}`)
      strokes.push(stroke)
      cost += strokeCost(stroke)
    }
    expect(new TextEncoder().encode(encodeBoard(strokes, 1)).byteLength).toBeLessThan(
      MAX_BOARD_FILE_BYTES,
    )
  })

  it('so does one full of text in three-byte characters', () => {
    const text = '字'.repeat(MAX_ANNOTATION_TEXT_CHARS)
    const note = (id: string): Stroke => ({
      id,
      by: 'someone',
      tool: 'text',
      color: 'rose',
      width: 'thick',
      points: [[-999.1234, -999.1234]],
      text,
    })
    const strokes: Stroke[] = []
    let cost = 0
    while (cost + strokeCost(note('')) <= MAX_BOARD_COST && strokes.length < MAX_BOARD_STROKES) {
      strokes.push(note(`s${strokes.length}`))
      cost += strokeCost(note(''))
    }
    expect(new TextEncoder().encode(encodeBoard(strokes, 1)).byteLength).toBeLessThan(
      MAX_BOARD_FILE_BYTES,
    )
  })

  it('something too large is refused rather than written', async () => {
    const bucket = new FakeBucket()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new BoardStore(
      asBucket(bucket),
      ledgerOver(new FileLedger(null), () => 1),
      () => 1,
      noSleep,
    )
    const huge = Array.from({ length: 400 }, (_, i) => longest(`s${i}`))
    expect(await store.save(KEY, huge)).toBe(false)
    log.mockRestore()
    expect(bucket.calls.put).toBe(0)
  })

  it('reading checks it all again: a damaged or oversized file brings no more than the limits', () => {
    expect(decodeBoard('not json')).toEqual([])
    expect(decodeBoard('{"strokes":3}')).toEqual([])
    const many = Array.from({ length: MAX_BOARD_STROKES + 10 }, (_, i) => ({ ...pen(`s${i}`), by: 'x' }))
    expect(decodeBoard(JSON.stringify({ v: 1, strokes: many }))).toHaveLength(MAX_BOARD_STROKES)
    const mixed = decodeBoard(
      JSON.stringify({ v: 1, strokes: [{ ...pen('ok'), by: 'x' }, { id: 'bad' }, { ...pen('fine'), by: 'x' }] }),
    )
    expect(mixed.map((s) => [s.id, s.by])).toEqual([
      ['ok', PAST_AUTHOR],
      ['fine', PAST_AUTHOR],
    ])
  })
})

describe('a stroke cleared while it is being drawn (the J3 race)', () => {
  it('does not come back when its author finishes it', async () => {
    const t = setup({ persistent: false })
    const host = await t.join('Host')
    const artist = await t.join('Artist')
    await t.send(host, { t: 'whiteboard', open: true })
    await t.send(artist, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('s', true)] })
    expect(host.client.board()).toEqual(['s'])
    await t.send(host, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    expect(host.client.board()).toEqual([])
    // The artist has not heard yet: more of the stroke, then all of it
    await t.send(artist, {
      t: 'annotate',
      share: WHITEBOARD_LAYER,
      ops: [{ op: 'update', id: 's', at: 1, points: [[0.2, 0.2]] }],
    })
    await t.send(artist, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('s')] })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER)).toEqual([])
    expect(host.client.board()).toEqual([])
    // The artist is told to take it away
    const back = artist.client.of('annotation').at(-1)!
    expect(back.ops).toEqual([{ op: 'remove', id: 's' }])
    // The next stroke is an ordinary one
    await t.send(artist, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('next')] })
    expect(host.client.board()).toEqual(['next'])
  })

  it('also on a clear of that one person, and only theirs', async () => {
    const t = setup({ persistent: false })
    const host = await t.join('Host')
    const artist = await t.join('Artist')
    const other = await t.join('Other')
    await t.send(host, { t: 'whiteboard', open: true })
    await t.send(artist, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('mine', true)] })
    await t.send(other, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('theirs', true)] })
    await t.send(host, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: artist.id })
    await t.send(artist, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('mine')] })
    await t.send(other, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('theirs')] })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['theirs'])
  })

  it('a finished stroke cleared and brought back by undo is an ordinary add', async () => {
    const t = setup({ persistent: false })
    const host = await t.join('Host')
    await t.send(host, { t: 'whiteboard', open: true })
    await t.send(host, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('done')] })
    await t.send(host, { t: 'clearAnnotations', share: WHITEBOARD_LAYER, by: null })
    await t.send(host, { t: 'annotate', share: WHITEBOARD_LAYER, ops: [add('done')] })
    expect(t.host.annotationsOf(WHITEBOARD_LAYER).map((s) => s.id)).toEqual(['done'])
  })

  it('RoomAnnotations forgets it once the author drops it', () => {
    const layer = new RoomAnnotations()
    layer.put(WHITEBOARD_LAYER, { ...pen('s'), by: 'm' } as Stroke, true)
    layer.noteClearedWhileDrawn(WHITEBOARD_LAYER, null)
    layer.clearShare(WHITEBOARD_LAYER)
    layer.remove(WHITEBOARD_LAYER, 'm', 's')
    expect(layer.refusedAsCleared(WHITEBOARD_LAYER, 's', false)).toBe(false)
  })
})
