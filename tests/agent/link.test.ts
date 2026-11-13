// The desktop agent's join form (e9-t02, f-remote-control-security.md §5.8, T-19 unit part): only
// rooms on the agent's own origin; a link to another host is refused, never followed. And what a
// closed socket means for the form.
import { describe, expect, it } from 'vitest'
import { closeProblem, parseJoinTarget } from '../../agent/ui/src/link.ts'
import { defaultDevice } from '../../agent/ui/src/deviceName.ts'
import { dictionaries, pickLocale } from '../../agent/ui/src/i18n.ts'

const ORIGIN = 'https://longtalk.genelee-pro.workers.dev'

describe('parseJoinTarget', () => {
  it('takes a bare room id or slug', () => {
    expect(parseJoinTarget('Ab3dEf7hJk', ORIGIN)).toEqual({ ok: true, room: 'Ab3dEf7hJk' })
    expect(parseJoinTarget('  Ab3dEf7hJk  ', ORIGIN)).toEqual({ ok: true, room: 'Ab3dEf7hJk' })
    expect(parseJoinTarget('book-club', ORIGIN)).toEqual({ ok: true, room: 'book-club' })
  })

  it('takes a link to a room on its own origin, with or without the scheme', () => {
    expect(parseJoinTarget(`${ORIGIN}/r/Ab3dEf7hJk`, ORIGIN)).toEqual({
      ok: true,
      room: 'Ab3dEf7hJk',
    })
    expect(parseJoinTarget(`${ORIGIN}/r/Ab3dEf7hJk?x=1#y`, ORIGIN)).toEqual({
      ok: true,
      room: 'Ab3dEf7hJk',
    })
    expect(parseJoinTarget('longtalk.genelee-pro.workers.dev/r/book-club', ORIGIN)).toEqual({
      ok: true,
      room: 'book-club',
    })
  })

  it('refuses a link to any other host: 「這不是 LongTalk 的連結」', () => {
    for (const link of [
      'https://evil.example/r/Ab3dEf7hJk',
      'evil.example/r/Ab3dEf7hJk',
      'https://longtalk.genelee-pro.workers.dev.evil.example/r/Ab3dEf7hJk',
      'https://other.genelee-pro.workers.dev/r/Ab3dEf7hJk',
      'https://longtalk.genelee-pro.workers.dev:8443/r/Ab3dEf7hJk',
      'ftp://longtalk.genelee-pro.workers.dev/r/Ab3dEf7hJk',
      'javascript:alert(1)',
      'longtalk-agent://join?room=Ab3dEf7hJk',
    ]) {
      expect(parseJoinTarget(link, ORIGIN), link).toEqual({ ok: false, problem: 'foreignLink' })
    }
    expect(dictionaries['zh-TW'].problems.foreignLink).toBe('這不是 LongTalk 的連結')
  })

  it('refuses links on its origin that are not a room, and nonsense', () => {
    expect(parseJoinTarget(`${ORIGIN}/admin`, ORIGIN)).toEqual({ ok: false, problem: 'badRoom' })
    expect(parseJoinTarget(`${ORIGIN}/m/abc`, ORIGIN)).toEqual({ ok: false, problem: 'badRoom' })
    expect(parseJoinTarget('', ORIGIN)).toEqual({ ok: false, problem: 'badRoom' })
    expect(parseJoinTarget('not a room!', ORIGIN)).toEqual({ ok: false, problem: 'badRoom' })
  })

  it('follows a preview build’s origin', () => {
    const preview = 'https://longtalk-pr-60.genelee-pro.workers.dev'
    expect(parseJoinTarget(`${preview}/r/Ab3dEf7hJk`, preview)).toEqual({
      ok: true,
      room: 'Ab3dEf7hJk',
    })
    expect(parseJoinTarget(`${ORIGIN}/r/Ab3dEf7hJk`, preview)).toEqual({
      ok: false,
      problem: 'foreignLink',
    })
  })
})

describe('closeProblem', () => {
  it('names what the room said', () => {
    expect(closeProblem(4400, true)).toBe('versionMismatch')
    expect(closeProblem(4404, false)).toBe('roomNotFound')
    expect(closeProblem(4409, false)).toBe('roomFull')
    expect(closeProblem(4420, false)).toBe('rateLimited')
    expect(closeProblem(4403, true)).toBe('removed')
    expect(closeProblem(4411, true)).toBe('ended')
  })

  it('reads the agent socket’s own closes (shared/control.ts)', () => {
    expect(closeProblem(4402, false)).toBe('pairingFailed')
    expect(closeProblem(4401, true)).toBe('expired')
    expect(closeProblem(4410, true)).toBe('replaced')
  })

  it('takes any other refusal before the welcome as the pairing code', () => {
    expect(closeProblem(4499, false)).toBe('pairingFailed')
    expect(closeProblem(4499, true)).toBe('failed')
    expect(closeProblem(1006, false)).toBe('failed')
  })
})

describe('the agent’s text', () => {
  it('has every key in both languages and no Chinese in English', () => {
    const keys = (value: object, prefix = ''): string[] =>
      Object.entries(value).flatMap(([key, item]) =>
        typeof item === 'object' && item !== null
          ? keys(item, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )
    expect(keys(dictionaries.en)).toEqual(keys(dictionaries['zh-TW']))
    expect(JSON.stringify(dictionaries.en)).not.toMatch(/[㐀-鿿]/)
    expect(dictionaries.en.confirm.question('Alice', 'Book club')).not.toMatch(/[㐀-鿿]/)
  })

  it('names an unnamed room as the web app does', () => {
    expect(dictionaries['zh-TW'].roomName('讀書會', 'Bob')).toBe('讀書會')
    expect(dictionaries['zh-TW'].roomName(null, 'Bob')).toBe('Bob 的房間')
    expect(dictionaries.en.roomName(null, 'Bob')).toBe('Bob’s room')
  })

  it('asks before publishing, naming who issued the code and the room (T-01a)', () => {
    expect(dictionaries['zh-TW'].confirm.question('Alice', '週五讀書會')).toBe(
      'Alice 發的配對碼，要加入『週五讀書會』嗎？房間裡的人都會看到你的螢幕。',
    )
  })

  it('follows the system language', () => {
    expect(pickLocale('zh-TW')).toBe('zh-TW')
    expect(pickLocale('zh-Hant-HK')).toBe('zh-TW')
    expect(pickLocale('en-AU')).toBe('en')
    expect(pickLocale('ja')).toBe('en')
  })

  it('suggests the computer’s name as the device name, cut to what the room keeps', () => {
    expect(defaultDevice('DESKTOP-ABC123')).toBe('DESKTOP-ABC123')
    expect([...defaultDevice('x'.repeat(80))]).toHaveLength(40)
    expect(defaultDevice('')).toBe('')
  })
})
