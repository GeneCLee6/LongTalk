import { describe, expect, it } from 'vitest'
import { applyPatch, diff, jsonEqual, type JsonValue } from '../../shared/patch.ts'

describe('diff and applyPatch', () => {
  const cases: [string, JsonValue, JsonValue][] = [
    ['nothing changed', { a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }],
    ['a key added', { a: 1 }, { a: 1, b: { c: 2 } }],
    ['a key removed', { a: 1, b: 2 }, { a: 1 }],
    ['a nested value changed', { m: { x: { n: 1 } } }, { m: { x: { n: 2 } } }],
    ['an array replaced', { a: [1, 2] }, { a: [1, 3] }],
    ['an object replaced by a value', { a: { b: 1 } }, { a: null }],
    ['the root replaced', [1], { a: 1 }],
    ['many changes at once', { m: { a: 1, b: 2, c: 3 } }, { m: { b: 2, c: 4, d: 5 }, n: true }],
  ]
  it.each(cases)('round-trips: %s', (_, before, after) => {
    expect(applyPatch(before, diff(before, after))).toEqual(after)
  })

  it('sends nothing when nothing changed', () => {
    expect(diff({ a: { b: [1] } }, { a: { b: [1] } })).toEqual([])
  })

  it('sends only what changed', () => {
    const before = { members: { a: { id: 'a' }, b: { id: 'b' } } }
    const after = { members: { a: { id: 'a' }, c: { id: 'c' } } }
    expect(diff(before, after)).toEqual([
      { op: 'del', path: ['members', 'b'] },
      { op: 'set', path: ['members', 'c'], value: { id: 'c' } },
    ])
  })

  it('does not change the old state and shares what did not change', () => {
    const before = { a: { x: 1 }, b: { y: 1 } }
    const after = applyPatch(before, [{ op: 'set', path: ['b', 'y'], value: 2 }])
    expect(before.b.y).toBe(1)
    expect(after.a).toBe(before.a)
    expect(after.b).not.toBe(before.b)
  })

  it('refuses to touch an object prototype', () => {
    expect(() => applyPatch({}, [{ op: 'set', path: ['__proto__', 'x'], value: 1 }])).toThrow()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('compares JSON values by content', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false)
    expect(jsonEqual([1], { 0: 1 })).toBe(false)
  })
})
