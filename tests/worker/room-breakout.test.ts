// L3 (e10-t04): the breakout rooms as RoomBreakout keeps them, without the room around them. Who
// may, isolation and the chat are RoomHost's (tests/worker/room-l3.test.ts).
import { describe, expect, it } from 'vitest'
import { BREAKOUT_RECALL_MS } from '../../shared/breakout.ts'
import { RoomBreakout } from '../../worker/room-breakout.ts'

const NOW = 1_000_000

function opened(minutes: number | null = 10) {
  const breakout = new RoomBreakout()
  breakout.open(['甲', '乙'], { m1: 0, m2: 1, m3: 1 }, minutes, NOW)
  return breakout
}

describe('RoomBreakout', () => {
  it('is off until opened', () => {
    const breakout = new RoomBreakout()
    expect(breakout.on).toBe(false)
    expect(breakout.view).toBeNull()
    expect(breakout.stored).toBeNull()
    expect(breakout.due()).toBeNull()
    expect(breakout.groupOf('m1')).toBeNull()
    expect(breakout.move('m1', 'g1')).toBe(false)
    expect(breakout.close(NOW)).toBeNull()
    expect(breakout.tick(NOW)).toBeNull()
  })

  it('opens rooms g1… in the order given, with who is where and the clock', () => {
    const breakout = opened()
    expect(breakout.on).toBe(true)
    expect(breakout.view).toEqual({
      groups: [
        { id: 'g1', name: '甲' },
        { id: 'g2', name: '乙' },
      ],
      openedAt: NOW,
      endsAt: NOW + 10 * 60_000,
      closesAt: null,
      broadcast: null,
    })
    expect(breakout.groupOf('m1')).toBe('g1')
    expect(breakout.groupOf('m3')).toBe('g2')
    expect(breakout.groupOf('m4')).toBeNull()
    expect(breakout.assigned.sort()).toEqual(['m1', 'm2', 'm3'])
    // The view never says who is where: that is on each member
    expect(JSON.stringify(breakout.view)).not.toContain('m1')
  })

  it('without a time limit runs until recalled', () => {
    const breakout = opened(null)
    expect(breakout.view!.endsAt).toBeNull()
    expect(breakout.due()).toBeNull()
    expect(breakout.tick(NOW + 10 * 60 * 60_000)).toBeNull()
  })

  it('moves a member between rooms and back to the main room; never to a room that is not there', () => {
    const breakout = opened()
    expect(breakout.move('m1', 'g2')).toBe(true)
    expect(breakout.groupOf('m1')).toBe('g2')
    expect(breakout.move('m4', 'g1')).toBe(true)
    expect(breakout.groupOf('m4')).toBe('g1')
    expect(breakout.move('m1', null)).toBe(true)
    expect(breakout.groupOf('m1')).toBeNull()
    expect(breakout.move('m2', 'g3')).toBe(false)
    expect(breakout.groupOf('m2')).toBe('g2')
  })

  it('forgets a member who left, saying whether there was anything to forget', () => {
    const breakout = opened()
    expect(breakout.forget('m2')).toBe(true)
    expect(breakout.groupOf('m2')).toBeNull()
    expect(breakout.forget('m2')).toBe(false)
    expect(breakout.forget('nobody')).toBe(false)
  })

  it('keeps the last broadcast', () => {
    const breakout = opened()
    breakout.broadcast({ text: '還有五分鐘', by: 'Alice', at: NOW + 1 })
    breakout.broadcast({ text: '還有一分鐘', by: 'Bob', at: NOW + 2 })
    expect(breakout.view!.broadcast).toEqual({ text: '還有一分鐘', by: 'Bob', at: NOW + 2 })
  })

  it('a recall gives everyone BREAKOUT_RECALL_MS; another leaves it alone, an immediate one ends it', () => {
    const breakout = opened()
    expect(breakout.close(NOW + 5)).toBe('closing')
    expect(breakout.view!.closesAt).toBe(NOW + 5 + BREAKOUT_RECALL_MS)
    expect(breakout.due()).toBe(NOW + 5 + BREAKOUT_RECALL_MS)
    // Still in their rooms during the grace, and a second recall does not shorten it
    expect(breakout.groupOf('m1')).toBe('g1')
    expect(breakout.close(NOW + 6)).toBeNull()
    expect(breakout.view!.closesAt).toBe(NOW + 5 + BREAKOUT_RECALL_MS)
    expect(breakout.close(NOW + 6, true)).toBe('ended')
    expect(breakout.on).toBe(false)
    expect(breakout.groupOf('m1')).toBeNull()
    expect(breakout.assigned).toEqual([])
  })

  it('the clock: the time running out starts the recall, the grace running out ends it', () => {
    const breakout = opened(1)
    const endsAt = NOW + 60_000
    expect(breakout.due()).toBe(endsAt)
    expect(breakout.tick(endsAt - 1)).toBeNull()
    // A late alarm still gives the full grace
    expect(breakout.tick(endsAt + 500)).toBe('closing')
    expect(breakout.view!.closesAt).toBe(endsAt + 500 + BREAKOUT_RECALL_MS)
    expect(breakout.tick(endsAt + 500 + BREAKOUT_RECALL_MS - 1)).toBeNull()
    expect(breakout.tick(endsAt + 500 + BREAKOUT_RECALL_MS)).toBe('ended')
    expect(breakout.on).toBe(false)
  })

  it('comes back from what it stored, and does not share it', () => {
    const breakout = opened()
    breakout.move('m4', 'g1')
    breakout.broadcast({ text: '回來囉', by: 'Alice', at: NOW })
    breakout.close(NOW + 1)
    const stored = structuredClone(breakout.stored)
    const restored = new RoomBreakout(stored)
    expect(restored.stored).toEqual(breakout.stored)
    expect(restored.view).toEqual(breakout.view)
    expect(restored.groupOf('m4')).toBe('g1')
    restored.move('m4', null)
    expect(stored!.assign.m4).toBe('g1')
  })

  it('an immediate recall needs no grace first', () => {
    const breakout = opened()
    expect(breakout.close(NOW, true)).toBe('ended')
    expect(breakout.on).toBe(false)
  })

  it('reset drops everything', () => {
    const breakout = opened()
    breakout.reset()
    expect(breakout.on).toBe(false)
    expect(breakout.stored).toBeNull()
  })
})
