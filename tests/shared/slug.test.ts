// I2 (e1-t13): persistent rooms' slugs, beside random room ids
import { describe, expect, it } from 'vitest'
import { newRoomId } from '../../shared/room-id.ts'
import {
  RESERVED_SLUGS,
  isRoomKey,
  isSlug,
  normalizeSlug,
  parseRoomAddress,
  slugProblem,
} from '../../shared/slug.ts'

describe('slugs', () => {
  it('takes lower-case words with single hyphens', () => {
    for (const slug of ['gene', 'gene-weekly', 'team-2026', 'a1b']) expect(slugProblem(slug), slug).toBeNull()
    expect(slugProblem('ab')).toBe('length')
    expect(slugProblem('a'.repeat(33))).toBe('length')
    for (const slug of ['Gene', '1abc', 'abc-', 'a--b', 'ab_c', '週會xx', 'a b c']) {
      expect(slugProblem(slug), slug).toBe('chars')
    }
    for (const slug of RESERVED_SLUGS) expect(slugProblem(slug)).toBe(slug.length < 3 ? 'length' : 'reserved')
  })

  it('never looks like a random room id, so the two never share a Durable Object', () => {
    expect(slugProblem('abcdefghij')).toBe('roomId')
    expect(slugProblem('abcdefghil')).toBeNull() // l is not in the id alphabet
    for (let i = 0; i < 200; i++) expect(isSlug(newRoomId())).toBe(false)
    expect(isRoomKey(newRoomId())).toBe(true)
    expect(isRoomKey('gene-weekly')).toBe(true)
    expect(isRoomKey('Gene')).toBe(false)
  })

  it('folds what people type, and finds the room in a pasted link', () => {
    expect(normalizeSlug('  Ｇｅｎｅ-Weekly ')).toBe('gene-weekly')
    expect(parseRoomAddress('Gene-Weekly')).toBe('gene-weekly')
    expect(parseRoomAddress('https://longtalk.example/r/gene-weekly?x=1')).toBe('gene-weekly')
    expect(parseRoomAddress('https://longtalk.example/r/Abc23DEF45')).toBe('Abc23DEF45')
    expect(parseRoomAddress('https://longtalk.example/r/admin')).toBeNull()
    expect(parseRoomAddress('hello world')).toBeNull()
  })
})
