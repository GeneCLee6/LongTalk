import { describe, expect, it } from 'vitest'
import {
  MAX_BREAKOUT_GROUPS,
  MAX_BREAKOUT_MINUTES,
  MAX_BREAKOUT_NAME_CHARS,
  MAX_BROADCAST_CHARS,
  autoAssign,
  breakoutRemaining,
  chatVisible,
  groupId,
  groupOf,
  isGroupOf,
  scopeView,
  type BreakoutView,
} from '../../shared/breakout.ts'
import type { ChatMessage } from '../../shared/chat.ts'
import {
  parseBreakoutOpen,
  parseClientMessage,
  type Member,
  type RoomView,
} from '../../shared/protocol.ts'

// L3 (e10-t04, AC-10.4): the breakout rooms' pure helpers both ends share, and the four messages
// that drive them.

/** A seeded generator (mulberry32), so a shuffle is the same every run */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const member = (id: string, group?: string | null): Member => ({
  id,
  name: id,
  role: 'participant',
  joinedAt: 1,
  reconnecting: false,
  tracks: [{ sessionId: `s-${id}`, trackName: `mic-${id}`, kind: 'mic', muted: false }],
  hand: null,
  signal: null,
  mayRecord: false,
  ...(group === undefined ? {} : { group }),
})

const breakout: BreakoutView = {
  groups: [
    { id: 'g1', name: '第一組' },
    { id: 'g2', name: '第二組' },
  ],
  openedAt: 1000,
  endsAt: null,
  closesAt: null,
  broadcast: null,
}

function view(members: Member[], extra: Partial<RoomView> = {}): RoomView {
  return {
    room: {
      id: 'abcdefghij',
      createdAt: 1,
      name: null,
      createdBy: null,
      startedAt: null,
      shares: {},
      locked: false,
      waitingRoom: false,
      passwordSetAt: null,
      spotlight: null,
      recordings: {},
      annotationPolicy: 'everyone',
      whiteboard: null,
    },
    members: Object.fromEntries(members.map((m) => [m.id, m])),
    waiting: {},
    usage: 'normal',
    ...extra,
  }
}

const sizes = (assigned: number[], groups: number) =>
  Array.from({ length: groups }, (_, g) => assigned.filter((index) => index === g).length)

describe('autoAssign', () => {
  const ids = Array.from({ length: 23 }, (_, i) => `m${i}`)

  it('puts everyone in a room, the rooms differing in size by at most one', () => {
    for (const groups of [1, 2, 3, 4, 5, 7, 12]) {
      const assigned = autoAssign(ids, groups, seeded(groups))
      expect(assigned).toHaveLength(ids.length)
      for (const index of assigned) {
        expect(Number.isInteger(index)).toBe(true)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(groups)
      }
      const counts = sizes(assigned, groups)
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
    }
  })

  it('is the same for the same random numbers, and shuffles for others', () => {
    expect(autoAssign(ids, 4, seeded(42))).toEqual(autoAssign(ids, 4, seeded(42)))
    expect(autoAssign(ids, 4, seeded(42))).not.toEqual(autoAssign(ids, 4, seeded(7)))
  })

  it('with one room, or none, puts everyone in the first', () => {
    expect(autoAssign(ids, 1, seeded(1))).toEqual(ids.map(() => 0))
    expect(autoAssign(ids, 0)).toEqual(ids.map(() => 0))
  })

  it('handles fewer members than rooms, and nobody at all', () => {
    const assigned = autoAssign(['a', 'b'], 5, seeded(3))
    expect(new Set(assigned).size).toBe(2)
    expect(autoAssign([], 3)).toEqual([])
  })
})

describe('groupId, isGroupOf, groupOf', () => {
  it('names the rooms g1 … in order and knows which are open', () => {
    expect(groupId(0)).toBe('g1')
    expect(groupId(11)).toBe('g12')
    expect(isGroupOf(breakout, 'g2')).toBe(true)
    expect(isGroupOf(breakout, 'g3')).toBe(false)
    expect(isGroupOf(null, 'g1')).toBe(false)
  })

  it('says which room a member is in, null for the main room or nobody', () => {
    const v = view([member('a', 'g1'), member('b', null), member('c')], { breakout })
    expect(groupOf(v, 'a')).toBe('g1')
    expect(groupOf(v, 'b')).toBeNull()
    expect(groupOf(v, 'c')).toBeNull()
    expect(groupOf(v, 'zz')).toBeNull()
    expect(groupOf(v, null)).toBeNull()
    expect(groupOf(null, 'a')).toBeNull()
  })
})

describe('scopeView', () => {
  it('returns the same object without breakout rooms', () => {
    const v = view([member('a'), member('b', null)])
    expect(scopeView(v, 'a')).toBe(v)
  })

  it('keeps only the own room’s members, their shares and their spotlight', () => {
    const v = view([member('a', 'g1'), member('b', 'g1'), member('c', 'g2'), member('d', null)], {
      breakout,
    })
    v.room.shares = {
      b: { memberId: 'b', since: 5 },
      c: { memberId: 'c', since: 6 },
    }
    v.room.spotlight = 'b'
    const a = scopeView(v, 'a')
    expect(Object.keys(a.members).sort()).toEqual(['a', 'b'])
    expect(Object.keys(a.room.shares)).toEqual(['b'])
    expect(a.room.spotlight).toBe('b')
    expect(a.breakout).toBe(breakout)
    // The whole view is left as it was
    expect(Object.keys(v.members)).toHaveLength(4)

    const c = scopeView(v, 'c')
    expect(Object.keys(c.members)).toEqual(['c'])
    expect(Object.keys(c.room.shares)).toEqual(['c'])
    expect(c.room.spotlight).toBeNull()
  })

  it('shows someone in the main room only the main room', () => {
    const v = view([member('a', 'g1'), member('b', null), member('c')], { breakout })
    expect(Object.keys(scopeView(v, 'b').members).sort()).toEqual(['b', 'c'])
    expect(Object.keys(scopeView(v, 'c').members).sort()).toEqual(['b', 'c'])
  })

  it('scopes while anyone is still in a room, even once `breakout` is gone', () => {
    const v = view([member('a', 'g1'), member('b')])
    expect(Object.keys(scopeView(v, 'b').members)).toEqual(['b'])
  })
})

describe('chatVisible', () => {
  const message = (group?: string): ChatMessage => ({
    id: 1,
    from: 'a',
    name: 'A',
    text: 'hi',
    at: 1,
    ...(group === undefined ? {} : { group }),
  })

  it('shows a message only in the room it was sent from', () => {
    expect(chatVisible(message(), null)).toBe(true)
    expect(chatVisible(message(), 'g1')).toBe(false)
    expect(chatVisible(message('g1'), 'g1')).toBe(true)
    expect(chatVisible(message('g1'), 'g2')).toBe(false)
    expect(chatVisible(message('g1'), null)).toBe(false)
  })
})

describe('breakoutRemaining', () => {
  it('is open with the time left, or no limit', () => {
    expect(breakoutRemaining({ ...breakout, endsAt: 61_000 }, 1_000)).toEqual({
      phase: 'open',
      ms: 60_000,
    })
    expect(breakoutRemaining(breakout, 5_000)).toEqual({ phase: 'open', ms: null })
  })

  it('is closing once a recall started, whatever the limit', () => {
    expect(breakoutRemaining({ ...breakout, endsAt: 99_000, closesAt: 31_000 }, 1_000)).toEqual({
      phase: 'closing',
      ms: 30_000,
    })
  })

  it('never goes below zero', () => {
    expect(breakoutRemaining({ ...breakout, endsAt: 1_000 }, 5_000)).toEqual({
      phase: 'open',
      ms: 0,
    })
    expect(breakoutRemaining({ ...breakout, closesAt: 1_000 }, 5_000)).toEqual({
      phase: 'closing',
      ms: 0,
    })
  })
})

describe('protocol v23: breakout messages', () => {
  const parse = (value: object) => parseClientMessage(JSON.stringify(value))

  it('parses breakoutOpen, normalizing the names', () => {
    expect(
      parseBreakoutOpen({ groups: [' 第一組 ', 'B'], assign: { a: 0, b: 1 }, minutes: 15 }),
    ).toEqual({ t: 'breakoutOpen', groups: ['第一組', 'B'], assign: { a: 0, b: 1 }, minutes: 15 })
    expect(parse({ t: 'breakoutOpen', groups: ['A'], assign: {}, minutes: null })).toEqual({
      t: 'breakoutOpen',
      groups: ['A'],
      assign: {},
      minutes: null,
    })
    const most = Array.from({ length: MAX_BREAKOUT_GROUPS }, (_, i) => `R${i}`)
    expect(parse({ t: 'breakoutOpen', groups: most, assign: {}, minutes: null })).not.toBeNull()
  })

  it('refuses a breakoutOpen with no rooms, too many, or bad names', () => {
    const open = (fields: object) =>
      parse({ t: 'breakoutOpen', groups: ['A', 'B'], assign: {}, minutes: null, ...fields })
    expect(open({ groups: [] })).toBeNull()
    expect(open({ groups: 'A' })).toBeNull()
    expect(
      open({ groups: Array.from({ length: MAX_BREAKOUT_GROUPS + 1 }, (_, i) => `R${i}`) }),
    ).toBeNull()
    expect(open({ groups: ['A', '   '] })).toBeNull()
    expect(open({ groups: ['x'.repeat(MAX_BREAKOUT_NAME_CHARS + 1)] })).toBeNull()
    expect(open({ groups: ['x'.repeat(MAX_BREAKOUT_NAME_CHARS)] })).not.toBeNull()
  })

  it('refuses a breakoutOpen that sends someone to a room that is not there', () => {
    const open = (assign: unknown) =>
      parse({ t: 'breakoutOpen', groups: ['A', 'B'], assign, minutes: null })
    expect(open({ a: 2 })).toBeNull()
    expect(open({ a: -1 })).toBeNull()
    expect(open({ a: 0.5 })).toBeNull()
    expect(open({ a: '0' })).toBeNull()
    expect(open({ 'bad id!': 0 })).toBeNull()
    expect(open([0, 1])).toBeNull()
    expect(open(null)).toBeNull()
  })

  it('refuses a breakoutOpen with a bad length', () => {
    const open = (minutes: unknown) =>
      parse({ t: 'breakoutOpen', groups: ['A'], assign: {}, minutes })
    expect(open(0)).toBeNull()
    expect(open(MAX_BREAKOUT_MINUTES + 1)).toBeNull()
    expect(open(2.5)).toBeNull()
    expect(open('10')).toBeNull()
    expect(open(undefined)).toBeNull()
    expect(open(1)).not.toBeNull()
    expect(open(MAX_BREAKOUT_MINUTES)).not.toBeNull()
  })

  it('parses breakoutMove to a room or back to the main room, and refuses bad ids', () => {
    expect(parse({ t: 'breakoutMove', memberId: 'a', group: 'g3' })).toEqual({
      t: 'breakoutMove',
      memberId: 'a',
      group: 'g3',
    })
    expect(parse({ t: 'breakoutMove', memberId: 'a', group: null })).toEqual({
      t: 'breakoutMove',
      memberId: 'a',
      group: null,
    })
    expect(parse({ t: 'breakoutMove', memberId: 'a', group: 'g12' })).not.toBeNull()
    for (const group of ['g0', 'g', 'x1', 'g100', 'G1', 1, undefined]) {
      expect(parse({ t: 'breakoutMove', memberId: 'a', group })).toBeNull()
    }
    expect(parse({ t: 'breakoutMove', memberId: 'no spaces', group: 'g1' })).toBeNull()
    expect(parse({ t: 'breakoutMove', group: 'g1' })).toBeNull()
  })

  it('parses breakoutBroadcast up to its length, and breakoutClose', () => {
    expect(parse({ t: 'breakoutBroadcast', text: '  還有 5 分鐘  ' })).toEqual({
      t: 'breakoutBroadcast',
      text: '還有 5 分鐘',
    })
    expect(parse({ t: 'breakoutBroadcast', text: 'x'.repeat(MAX_BROADCAST_CHARS) })).not.toBeNull()
    expect(parse({ t: 'breakoutBroadcast', text: 'x'.repeat(MAX_BROADCAST_CHARS + 1) })).toBeNull()
    expect(parse({ t: 'breakoutBroadcast', text: '   ' })).toBeNull()
    expect(parse({ t: 'breakoutBroadcast' })).toBeNull()
    expect(parse({ t: 'breakoutClose', now: false })).toEqual({ t: 'breakoutClose', now: false })
    expect(parse({ t: 'breakoutClose', now: true })).toEqual({ t: 'breakoutClose', now: true })
    expect(parse({ t: 'breakoutClose' })).toBeNull()
  })
})
