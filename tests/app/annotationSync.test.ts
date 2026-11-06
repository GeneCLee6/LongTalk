// J2 (e7-t03, e7-t04) in the browser, without a browser: the store takes the room's messages, the
// drawer paces what goes out and keeps undo and redo. A fake clock throughout.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_STROKE_MS,
  ANNOTATION_FRAME_CHARS,
  ANNOTATION_SEND_MS,
  LASER_FADE_MS,
  MAX_FRAME_OPS,
  MAX_STROKE_POINTS,
} from '../../shared/annotation-limits.ts'
import type { AnnotationOp, Stroke } from '../../shared/annotation.ts'
import type { ClientMessage } from '../../shared/protocol.ts'
import { AnnotationDrawer, drawerFor, type DrawerClock } from '../../src/annotate/sync.ts'
import { AnnotationStore } from '../../src/room/annotationStore.ts'

const SHARE = 'alice'
const ASPECT = 16 / 9

function setup() {
  let clock = 1_000
  let timers: { at: number; work: () => void; id: number }[] = []
  let nextTimer = 0
  const sent: Extract<ClientMessage, { t: 'annotate' }>[] = []
  const link = { open: true }
  const store = new AnnotationStore({
    send: (message) => void sent.push(message as (typeof sent)[number]),
    isOpen: () => link.open,
    now: () => clock,
  })
  const drawerClock: DrawerClock = {
    now: () => clock,
    setTimeout: (work, ms) => {
      nextTimer += 1
      timers.push({ at: clock + ms, work, id: nextTimer })
      return nextTimer
    },
    clearTimeout: (id) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
  }
  const tick = (ms: number) => {
    const end = clock + ms
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock = due.at
      timers = timers.filter((timer) => timer !== due)
      due.work()
    }
    clock = end
  }
  const drawer = new AnnotationDrawer(store, SHARE, 'me', drawerClock)
  const ops = () => sent.flatMap((message) => message.ops)
  return { store, drawer, sent, ops, tick, link, now: () => clock }
}

const STYLE = { tool: 'pen', color: 'rose', width: 'medium' } as const
const stroke = (id: string, by = 'bob', extra: Partial<Stroke> = {}): Stroke => ({
  id,
  by,
  tool: 'pen',
  color: 'teal',
  width: 'thin',
  points: [[0.1, 0.1]],
  ...extra,
})
const ids = (store: AnnotationStore) => store.strokes(SHARE).map((one) => one.id)

let t: ReturnType<typeof setup>
beforeEach(() => {
  t = setup()
})

describe('pacing what goes out', () => {
  it('the first press goes at once, the moves every ANNOTATION_SEND_MS at most', () => {
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.1 } })
    expect(t.sent).toHaveLength(1)
    expect(t.ops()[0]).toMatchObject({ op: 'add', live: true })
    // A hundred pointer events in 90 ms: nothing goes yet, all of it shows here
    for (let i = 1; i <= 100; i++) {
      t.drawer.move({ x: 0.1 + i / 500, y: 0.1 }, ASPECT)
      t.tick(0.9)
    }
    expect(t.sent).toHaveLength(1)
    expect(t.store.strokes(SHARE)[0].points.length).toBeGreaterThan(50)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.sent).toHaveLength(2)
    const [update] = t.sent[1].ops
    expect(update).toMatchObject({ op: 'update', at: 1 })
    expect((update as Extract<AnnotationOp, { op: 'update' }>).points.length).toBeGreaterThan(50)
  })

  it('never more than one frame per ANNOTATION_SEND_MS, however busy', () => {
    const sentAt: number[] = []
    const store = t.store
    const original = store.send.bind(store)
    store.send = (share, ops) => {
      sentAt.push(t.now())
      original(share, ops)
    }
    for (let i = 0; i < 60; i++) {
      t.drawer.begin({ ...STYLE, at: { x: 0.2, y: 0.2 } })
      t.drawer.move({ x: 0.3, y: 0.2 + i / 200 }, ASPECT)
      t.drawer.end(ASPECT)
      t.tick(16)
    }
    t.tick(1000)
    for (let i = 1; i < sentAt.length; i++) {
      expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(ANNOTATION_SEND_MS)
    }
    // So quick strokes share a frame, and what is queued of a finished one was dropped
    expect(sentAt.length).toBeLessThan(60)
  })

  it('a frame stays within the limits, and the rest follows', () => {
    for (let i = 0; i < MAX_FRAME_OPS + 5; i++) {
      t.drawer.addText({ text: 'x', color: 'rose', width: 'thin', at: { x: 0.1, y: 0.1 } })
    }
    t.tick(ANNOTATION_SEND_MS * 5)
    for (const message of t.sent) {
      expect(message.ops.length).toBeLessThanOrEqual(MAX_FRAME_OPS)
      expect(JSON.stringify(message).length).toBeLessThan(ANNOTATION_FRAME_CHARS + 200)
    }
    expect(t.ops().filter((op) => op.op === 'add')).toHaveLength(MAX_FRAME_OPS + 5)
  })

  it('a stroke at the point cap thins, and all of it goes again', () => {
    t.drawer.begin({ ...STYLE, at: { x: 0, y: 0 } })
    for (let i = 1; i <= MAX_STROKE_POINTS + 5; i++) {
      t.drawer.move({ x: (i % 200) / 200, y: ((i * 7) % 200) / 200 }, ASPECT)
      if (i % 50 === 0) t.tick(ANNOTATION_SEND_MS)
    }
    t.tick(ANNOTATION_SEND_MS)
    const updates = t.ops().filter((op) => op.op === 'update') as Extract<
      AnnotationOp,
      { op: 'update' }
    >[]
    // Replaying what went out gives what is on screen
    expect(updates.some((op) => op.at === 0)).toBe(true)
    let points: readonly (readonly [number, number])[] = (
      t.ops()[0] as Extract<AnnotationOp, { op: 'add' }>
    ).stroke.points
    for (const { at, points: more } of updates) points = [...points.slice(0, at), ...more]
    expect(points).toEqual(t.store.strokes(SHARE)[0].points)
  })

  it('an arrow only moves its head', () => {
    t.drawer.begin({ ...STYLE, tool: 'arrow', at: { x: 0.1, y: 0.1 } })
    t.tick(ANNOTATION_SEND_MS)
    t.drawer.move({ x: 0.2, y: 0.2 }, ASPECT)
    t.tick(ANNOTATION_SEND_MS)
    t.drawer.move({ x: 0.3, y: 0.3 }, ASPECT)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.sent.slice(1).map((message) => message.ops)).toEqual([
      [{ op: 'update', id: expect.any(String), at: 1, points: [[0.2, 0.2]] }],
      [{ op: 'update', id: expect.any(String), at: 1, points: [[0.3, 0.3]] }],
    ])
  })

  it('the end of a stroke sends it whole and simplified, without `live`', () => {
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.5 } })
    for (let i = 1; i <= 50; i++) t.drawer.move({ x: 0.1 + i / 100, y: 0.5 }, ASPECT)
    t.drawer.end(ASPECT)
    t.tick(ANNOTATION_SEND_MS * 2)
    const last = t.ops().at(-1) as Extract<AnnotationOp, { op: 'add' }>
    expect(last).toMatchObject({ op: 'add' })
    expect(last.live).toBeUndefined()
    // A straight line needs two points
    expect(last.stroke.points).toHaveLength(2)
  })

  it('a stroke that came to nothing, or was cancelled, goes away for everyone', () => {
    t.drawer.begin({ ...STYLE, tool: 'arrow', at: { x: 0.1, y: 0.1 } })
    t.drawer.end(ASPECT)
    expect(ids(t.store)).toEqual([])
    t.tick(ANNOTATION_SEND_MS)
    expect(t.ops().at(-1)).toMatchObject({ op: 'remove' })
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.1 } })
    t.drawer.cancel()
    t.tick(ANNOTATION_SEND_MS)
    expect(ids(t.store)).toEqual([])
    expect(t.ops().at(-1)).toMatchObject({ op: 'remove' })
  })
})

describe('undo and redo', () => {
  const draw = () => {
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.1 } })
    t.drawer.move({ x: 0.4, y: 0.4 }, ASPECT)
    t.drawer.end(ASPECT)
    return ids(t.store).at(-1)!
  }

  it('takes back my strokes in turn, and brings them back', () => {
    const a = draw()
    const b = draw()
    expect(t.drawer.canUndo).toBe(true)
    expect(t.drawer.canRedo).toBe(false)
    t.drawer.undo()
    expect(ids(t.store)).toEqual([a])
    t.drawer.undo()
    expect(ids(t.store)).toEqual([])
    expect(t.drawer.canUndo).toBe(false)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.ops().slice(-2)).toEqual([
      { op: 'remove', id: b },
      { op: 'remove', id: a },
    ])
    t.drawer.redo()
    t.drawer.redo()
    expect(ids(t.store)).toEqual([a, b])
    expect(t.drawer.canRedo).toBe(false)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.ops().slice(-2).map((op) => op.op)).toEqual(['add', 'add'])
  })

  it('a new stroke ends what could be redone', () => {
    draw()
    t.drawer.undo()
    expect(t.drawer.canRedo).toBe(true)
    draw()
    expect(t.drawer.canRedo).toBe(false)
  })

  it('never touches someone else\'s', () => {
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [{ op: 'add', stroke: stroke('b') }] })
    expect(t.drawer.canUndo).toBe(false)
    t.drawer.undo()
    expect(ids(t.store)).toEqual(['b'])
  })

  it('undoes the eraser, which only reaches my own', () => {
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'bob',
      ops: [
        {
          op: 'add',
          stroke: stroke('b', 'bob', {
            points: [
              [0.5, 0.1],
              [0.5, 0.9],
            ],
          }),
        },
      ],
    })
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.5 } })
    t.drawer.move({ x: 0.9, y: 0.5 }, ASPECT)
    t.drawer.end(ASPECT)
    const mine = ids(t.store)[1]
    // Where both cross: only mine goes
    expect(t.drawer.eraseAt({ x: 0.5, y: 0.5 }, ASPECT)).toBe(true)
    expect(ids(t.store)).toEqual(['b'])
    // Bob's only, here: nothing happens
    expect(t.drawer.eraseAt({ x: 0.5, y: 0.2 }, ASPECT)).toBe(false)
    expect(ids(t.store)).toEqual(['b'])
    t.drawer.undo()
    expect(ids(t.store)).toEqual(['b', mine])
    t.drawer.redo()
    expect(ids(t.store)).toEqual(['b'])
  })

  it('skips a stroke that fell out meanwhile', () => {
    const a = draw()
    const b = draw()
    t.store.receive({ t: 'annotation', share: SHARE, by: null, ops: [{ op: 'remove', id: b }] })
    t.drawer.undo()
    expect(ids(t.store)).toEqual([])
    expect(t.store.has(SHARE, a)).toBe(false)
  })

  it('clear takes my strokes only, and is not undoable', () => {
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [{ op: 'add', stroke: stroke('b') }] })
    draw()
    draw()
    t.drawer.clearOwn()
    expect(ids(t.store)).toEqual(['b'])
    expect(t.drawer.canUndo).toBe(false)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.ops().at(-1)).toEqual({ op: 'clear' })
  })

  it('the text tool keeps a mark, and only one that has something in it', () => {
    expect(t.drawer.addText({ text: '  ', color: 'rose', width: 'thin', at: { x: 0.5, y: 0.5 } })).toBe(false)
    expect(t.drawer.addText({ text: '看這裡', color: 'rose', width: 'thin', at: { x: 0.5, y: 0.5 } })).toBe(true)
    expect(t.store.strokes(SHARE)[0]).toMatchObject({ tool: 'text', text: '看這裡', by: 'me' })
    t.drawer.undo()
    expect(ids(t.store)).toEqual([])
  })
})

describe('the laser pointer', () => {
  it('sends only the latest position in a frame, and leaves no stroke', () => {
    t.drawer.laser({ x: 0.1, y: 0.1 }, 'amber')
    t.drawer.laser({ x: 0.2, y: 0.2 }, 'amber')
    t.drawer.laser({ x: 0.3, y: 0.3 }, 'amber')
    t.tick(ANNOTATION_SEND_MS)
    expect(t.sent.map((message) => message.ops)).toEqual([
      [{ op: 'laser', at: [0.1, 0.1], color: 'amber' }],
      [{ op: 'laser', at: [0.3, 0.3], color: 'amber' }],
    ])
    expect(t.store.strokes(SHARE)).toEqual([])
  })

  it('someone else\'s fades out LASER_FADE_MS after it was last heard, and is forgotten', () => {
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'bob',
      ops: [{ op: 'laser', at: [0.5, 0.5], color: 'rose' }],
    })
    expect(t.store.lasers(SHARE)).toEqual([
      { by: 'bob', at: [0.5, 0.5], color: 'rose', heardAt: t.now() },
    ])
    expect(t.store.marked(SHARE)).toBe(true)
    t.tick(LASER_FADE_MS - 1)
    expect(t.store.lasers(SHARE)).toHaveLength(1)
    t.tick(1)
    expect(t.store.lasers(SHARE)).toEqual([])
    expect(t.store.marked(SHARE)).toBe(false)
  })

  it('leaving the picture starts its fade from where it was', () => {
    const bobAt = (at: [number, number] | null) =>
      t.store.receive({
        t: 'annotation',
        share: SHARE,
        by: 'bob',
        ops: [{ op: 'laser', at, color: 'rose' }],
      })
    bobAt([0.5, 0.5])
    t.tick(1000)
    bobAt(null)
    expect(t.store.lasers(SHARE)[0]).toMatchObject({ at: [0.5, 0.5], heardAt: t.now() })
    // Gone without ever being seen: nothing
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'carol',
      ops: [{ op: 'laser', at: null, color: 'rose' }],
    })
    expect(t.store.lasers(SHARE)).toHaveLength(1)
  })
})

describe('the store', () => {
  const add = (one: Stroke, live = false): AnnotationOp =>
    live ? { op: 'add', stroke: one, live: true } : { op: 'add', stroke: one }

  it('builds a stroke from add and update, and keeps its place when it finishes', () => {
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [add(stroke('a'), true)] })
    t.store.receive({ t: 'annotation', share: SHARE, by: 'carol', ops: [add(stroke('c', 'carol'))] })
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'bob',
      ops: [{ op: 'update', id: 'a', at: 1, points: [[0.2, 0.2]] }],
    })
    expect(t.store.strokes(SHARE)[0].points).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
    ])
    expect([...t.store.active(SHARE).keys()]).toEqual(['a'])
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [add(stroke('a'))] })
    expect(ids(t.store)).toEqual(['a', 'c'])
    expect(t.store.active(SHARE).size).toBe(0)
  })

  it('a stroke whose member went quiet stops counting as being drawn', () => {
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [add(stroke('a'), true)] })
    t.tick(ACTIVE_STROKE_MS + 1)
    expect(t.store.active(SHARE).size).toBe(0)
    expect(ids(t.store)).toEqual(['a'])
  })

  it('a gap in the points is not applied', () => {
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [add(stroke('a'))] })
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'bob',
      ops: [{ op: 'update', id: 'a', at: 5, points: [[0.2, 0.2]] }],
    })
    expect(t.store.strokes(SHARE)[0].points).toHaveLength(1)
  })

  it('clear: the whole layer, or one member\'s', () => {
    t.store.receive({
      t: 'annotation',
      share: SHARE,
      by: 'bob',
      ops: [add(stroke('a')), add(stroke('c', 'carol'))],
    })
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [{ op: 'clear', by: 'bob' }] })
    expect(ids(t.store)).toEqual(['c'])
    t.store.receive({ t: 'annotation', share: SHARE, by: null, ops: [{ op: 'clear' }] })
    expect(ids(t.store)).toEqual([])
    expect(t.store.marked(SHARE)).toBe(false)
  })

  it('tells only the listeners of that share', () => {
    let here = 0
    let there = 0
    t.store.subscribe(SHARE, () => (here += 1))
    const stop = t.store.subscribe('other', () => (there += 1))
    t.store.receive({ t: 'annotation', share: SHARE, by: 'bob', ops: [add(stroke('a'))] })
    expect([here, there]).toEqual([1, 0])
    stop()
    t.store.receive({ t: 'annotation', share: 'other', by: 'bob', ops: [add(stroke('b'))] })
    expect(there).toBe(0)
  })

  it('a snapshot replaces everything, on every share', () => {
    t.store.receive({ t: 'annotation', share: 'other', by: 'bob', ops: [add(stroke('old'))] })
    t.store.receive({ t: 'annotations', share: SHARE, strokes: [stroke('x')], reset: true })
    t.store.receive({ t: 'annotations', share: SHARE, strokes: [stroke('y')], done: true })
    expect(ids(t.store)).toEqual(['x', 'y'])
    expect(t.store.strokes('other')).toEqual([])
    t.store.receive({ t: 'annotations', share: null, strokes: [], reset: true, done: true })
    expect(ids(t.store)).toEqual([])
  })

  it('drawerFor gives the same drawer back: undo outlives a tile', () => {
    expect(drawerFor(t.store, SHARE, 'me')).toBe(drawerFor(t.store, SHARE, 'me'))
    expect(drawerFor(t.store, 'other', 'me')).not.toBe(drawerFor(t.store, SHARE, 'me'))
  })
})

describe('the socket going away', () => {
  it('finished strokes wait, and go after the room\'s snapshot', () => {
    t.link.open = false
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.1 } })
    t.drawer.move({ x: 0.3, y: 0.3 }, ASPECT)
    t.drawer.end(ASPECT)
    t.tick(ANNOTATION_SEND_MS)
    t.drawer.laser({ x: 0.5, y: 0.5 }, 'rose')
    t.tick(ANNOTATION_SEND_MS)
    expect(t.sent).toEqual([])
    const [mine] = ids(t.store)
    t.link.open = true
    t.store.receive({ t: 'annotations', share: SHARE, strokes: [stroke('theirs')], reset: true, done: true })
    expect(ids(t.store)).toEqual(['theirs', mine])
    t.tick(ANNOTATION_SEND_MS)
    // The stroke, not the half of it nor the pointer
    expect(t.ops().map((op) => op.op)).toEqual(['add'])
  })

  it('a stroke still being drawn goes whole again', () => {
    t.drawer.begin({ ...STYLE, at: { x: 0.1, y: 0.1 } })
    t.tick(ANNOTATION_SEND_MS)
    t.drawer.move({ x: 0.2, y: 0.2 }, ASPECT)
    t.link.open = false
    t.tick(ANNOTATION_SEND_MS)
    t.drawer.move({ x: 0.3, y: 0.3 }, ASPECT)
    t.tick(ANNOTATION_SEND_MS)
    t.link.open = true
    t.store.receive({ t: 'annotations', share: null, strokes: [], reset: true, done: true })
    t.tick(ANNOTATION_SEND_MS)
    const last = t.ops().at(-1) as Extract<AnnotationOp, { op: 'add' }>
    expect(last).toMatchObject({ op: 'add', live: true })
    expect(last.stroke.points).toHaveLength(3)
    expect(t.store.strokes(SHARE)[0].points).toHaveLength(3)
    // And it carries on from there
    t.drawer.move({ x: 0.4, y: 0.4 }, ASPECT)
    t.tick(ANNOTATION_SEND_MS)
    expect(t.ops().at(-1)).toMatchObject({ op: 'update', at: 3 })
  })
})
