import { describe, expect, it } from 'vitest'
import {
  CameraSight,
  cameraWanted,
  GRACE_BATCH_MS,
  HIDDEN_GRACE_MS,
  MAX_SUBSCRIBE_BATCH,
  SIGHT_SETTLE_MS,
  subscribeBatches,
  UNSEEN_GRACE_MS,
} from '../../../src/media/subscriptions.ts'

// L1 (e2-t18, e10-t01): which cameras to receive, with the clock passed in.

describe('cameraWanted', () => {
  const no = { seen: false, kept: false, needed: false, hidden: false }

  it('receives what is seen, kept or recorded, and nothing else', () => {
    expect(cameraWanted(no)).toBe(false)
    expect(cameraWanted({ ...no, seen: true })).toBe(true)
    expect(cameraWanted({ ...no, kept: true })).toBe(true)
    expect(cameraWanted({ ...no, needed: true })).toBe(true)
  })

  it('in a background tab keeps only what a recording draws', () => {
    expect(cameraWanted({ ...no, kept: true, hidden: true })).toBe(false)
    expect(cameraWanted({ ...no, needed: true, hidden: true })).toBe(true)
  })
})

describe('CameraSight', () => {
  it('wants nothing it has never seen', () => {
    expect(new CameraSight().wanted('a', 0, false)).toBe(false)
    expect(new CameraSight().nextChange(0)).toBeNull()
  })

  it('wants a camera once it has stayed in sight', () => {
    const sight = new CameraSight()
    expect(sight.update(new Set(['a']), 1000)).toBe(true)
    expect(sight.update(new Set(['a']), 1050)).toBe(false)
    expect(sight.wanted('a', 1000 + SIGHT_SETTLE_MS - 1, false)).toBe(false)
    expect(sight.wanted('a', 1000 + SIGHT_SETTLE_MS, false)).toBe(true)
    expect(sight.nextChange(1000)).toBe(1000 + SIGHT_SETTLE_MS)
  })

  it('does not want a page passed on the way to another', () => {
    const sight = new CameraSight()
    sight.update(new Set(['passed']), 0)
    sight.update(new Set(['target']), SIGHT_SETTLE_MS - 10)
    expect(sight.wanted('passed', SIGHT_SETTLE_MS * 2, false)).toBe(false)
    expect(sight.wanted('target', SIGHT_SETTLE_MS * 2, false)).toBe(true)
  })

  it('keeps a received camera through its grace, and not past it', () => {
    const sight = new CameraSight()
    sight.update(new Set(['a']), 0)
    sight.update(new Set(), 1000)
    expect(sight.wanted('a', 1000 + UNSEEN_GRACE_MS - 1, true)).toBe(true)
    expect(sight.wanted('a', 1000 + UNSEEN_GRACE_MS, true)).toBe(false)
    expect(sight.nextChange(2000)).toBe(1000 + UNSEEN_GRACE_MS + GRACE_BATCH_MS)
    expect(sight.nextChange(1000 + UNSEEN_GRACE_MS + GRACE_BATCH_MS)).toBeNull()
    // With the tab in the background the grace is longer
    expect(sight.wanted('a', 1000 + UNSEEN_GRACE_MS, true, HIDDEN_GRACE_MS)).toBe(true)
  })

  it('gives no grace to a camera that was not received', () => {
    const sight = new CameraSight()
    sight.update(new Set(['a']), 0)
    sight.update(new Set(), 1000)
    expect(sight.wanted('a', 1001, false)).toBe(false)
  })

  it('a camera held and back in sight needs no settling', () => {
    const sight = new CameraSight()
    sight.update(new Set(['a']), 0)
    sight.update(new Set(), 1000)
    sight.update(new Set(['a']), 2000)
    expect(sight.wanted('a', 2000, true)).toBe(true)
  })
})

describe('subscribeBatches', () => {
  const tracks = (n: number, muted = false) =>
    Array.from({ length: n }, (_, i) => ({ id: `${muted ? 'm' : 'u'}${i}`, muted }))

  it('keeps to the size the proxy allows', () => {
    const batches = subscribeBatches(tracks(MAX_SUBSCRIBE_BATCH * 2 + 1))
    expect(batches.map((b) => b.length)).toEqual([MAX_SUBSCRIBE_BATCH, MAX_SUBSCRIBE_BATCH, 1])
    expect(subscribeBatches([])).toEqual([])
  })

  it('puts muted tracks last', () => {
    const [first, second] = subscribeBatches([...tracks(1, true), ...tracks(2)], 2)
    expect(first.map((t) => t.id)).toEqual(['u0', 'u1'])
    expect(second.map((t) => t.id)).toEqual(['m0'])
  })
})
