import { describe, expect, it } from 'vitest'
import {
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  isRoomId,
  newRoomId,
  parseRoomInput,
} from '../../shared/room-id.ts'

describe('room ids', () => {
  it('are 10 characters from a 58-character alphabet (about 59 bits)', () => {
    expect(ROOM_ID_ALPHABET).toHaveLength(58)
    expect(new Set(ROOM_ID_ALPHABET).size).toBe(58)
    expect(ROOM_ID_LENGTH * Math.log2(ROOM_ID_ALPHABET.length)).toBeGreaterThan(58)
  })

  it('leave out characters that are easy to misread', () => {
    for (const c of '0OIl') expect(ROOM_ID_ALPHABET).not.toContain(c)
  })

  it('are valid and URL-safe', () => {
    for (let i = 0; i < 200; i++) {
      const id = newRoomId()
      expect(isRoomId(id)).toBe(true)
      expect(encodeURIComponent(id)).toBe(id)
    }
  })

  it('do not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRoomId()))
    expect(ids.size).toBe(1000)
  })

  it('throw away bytes that would bias the alphabet', () => {
    // 232 and above are rejected; 0 → '1', 57 → 'z', 58 → '1' again
    const bytes = [255, 232, 0, 57, 58, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const id = newRoomId((buffer) => {
      buffer.fill(255)
      buffer.set(bytes.slice(0, buffer.length))
    })
    expect(id).toBe('1z12345678')
  })

  it('reject anything else', () => {
    for (const value of [
      '',
      'abc',
      'abcdefghij1',
      'abcdefghi0',
      'abcdefghI1',
      'abc/efghij',
      'abcdefghi ',
      42,
      null,
      undefined,
    ]) {
      expect(isRoomId(value)).toBe(false)
    }
    expect(isRoomId('abcdefghij')).toBe(true)
  })

  it('are found in what people paste into the join box', () => {
    for (const input of [
      'k7pq2x9m4a',
      '  k7pq2x9m4a\n',
      'https://longtalk.app/r/k7pq2x9m4a',
      'https://pr-12.longtalk.workers.dev/r/k7pq2x9m4a?x=1#y',
      'longtalk.app/r/k7pq2x9m4a/',
      '/r/k7pq2x9m4a',
      'r/k7pq2x9m4a',
    ]) {
      expect(parseRoomInput(input), input).toBe('k7pq2x9m4a')
    }
    for (const input of [
      '',
      'hello',
      'k7pq2x9m4',
      'k7pq2x9m40',
      'https://x/room/k7pq2x9m4a',
      'xr/k7pq2x9m4a',
    ]) {
      expect(parseRoomInput(input), input).toBeNull()
    }
  })
})
