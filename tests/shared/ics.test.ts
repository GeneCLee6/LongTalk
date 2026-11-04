// I3 (e1-t14): the .ics file (RFC 5545) pinned by golden files, then read back with a small
// RFC 5545 reader (unfold, split, unescape) to show any calendar gets the same values back.
import { describe, expect, it } from 'vitest'
import { buildIcs, escapeText, foldLine, icsFileName, icsTime, type IcsEvent } from '../../shared/ics.ts'
import basicIcs from './fixtures/meeting-basic.ics?raw'
import longIcs from './fixtures/meeting-long.ics?raw'

const BASIC: IcsEvent = {
  uid: 'Qm9va2VkTWVldGluZzAx@longtalk.example',
  stamp: Date.UTC(2026, 10, 4, 9, 30, 15),
  sequence: 0,
  start: Date.UTC(2026, 10, 10, 3, 0),
  end: Date.UTC(2026, 10, 10, 4, 0),
  summary: 'Weekly sync',
  description: 'Join the meeting: https://longtalk.example/m/Qm9va2VkTWVldGluZzAx',
  url: 'https://longtalk.example/m/Qm9va2VkTWVldGluZzAx',
}

const LONG: IcsEvent = {
  ...BASIC,
  sequence: 3,
  summary: '產品週會; 第 12 次, 請準時 \\ 謝謝',
  description:
    '議程：\n1. 上週進度（每人 3 分鐘）, 2. 本週計畫; 3. 其他\n\n🎉 這段說明故意寫得很長，讓它超過七十五個位元組，好測試摺行不會把一個中文字或表情符號切成兩半。\n\n加入會議：https://longtalk.example/m/Qm9va2VkTWVldGluZzAx',
}

/** RFC 5545 §3.1 in reverse: unfold, then NAME:VALUE per line */
function readIcs(text: string): Array<[string, string]> {
  expect(text.endsWith('\r\n')).toBe(true)
  // Every line ends in CRLF: no bare LF anywhere
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  return text
    .replace(/\r\n /g, '')
    .split('\r\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':')
      return [line.slice(0, at), line.slice(at + 1)] as [string, string]
    })
}

const unescape = (value: string) =>
  value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

describe('.ics', () => {
  it('matches the golden files byte for byte', () => {
    expect(buildIcs(BASIC)).toBe(basicIcs)
    expect(buildIcs(LONG)).toBe(longIcs)
  })

  it('has one VEVENT with UTC times, a UID, DTSTAMP and every value read back unchanged', () => {
    for (const event of [BASIC, LONG]) {
      const props = readIcs(buildIcs(event))
      const get = (name: string) => props.find(([key]) => key === name)?.[1]
      expect(props.map(([key]) => key)).toEqual([
        'BEGIN',
        'VERSION',
        'PRODID',
        'CALSCALE',
        'METHOD',
        'BEGIN',
        'UID',
        'DTSTAMP',
        'SEQUENCE',
        'DTSTART',
        'DTEND',
        'SUMMARY',
        'DESCRIPTION',
        'URL',
        'LOCATION',
        'STATUS',
        'TRANSP',
        'END',
        'END',
      ])
      expect(get('VERSION')).toBe('2.0')
      expect(get('UID')).toBe(event.uid)
      for (const key of ['DTSTAMP', 'DTSTART', 'DTEND']) expect(get(key)).toMatch(/^\d{8}T\d{6}Z$/)
      expect(get('DTSTART')).toBe(icsTime(event.start))
      expect(get('SEQUENCE')).toBe(String(event.sequence))
      expect(unescape(get('SUMMARY')!)).toBe(event.summary)
      expect(unescape(get('DESCRIPTION')!)).toBe(event.description)
      expect(get('URL')).toBe(event.url)
      expect(unescape(get('LOCATION')!)).toBe(event.url)
      // No recurrence: single meetings (shared/meeting.ts)
      expect(get('RRULE')).toBeUndefined()
    }
  })

  it('writes UTC times in the basic format', () => {
    expect(icsTime(Date.UTC(2026, 0, 2, 3, 4, 5, 678))).toBe('20260102T030405Z')
  })

  it('escapes backslash, semicolon, comma and every kind of line end', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng')
  })

  it('folds at 75 octets without splitting a character', () => {
    const line = `DESCRIPTION:${'週'.repeat(40)}🎉${'a'.repeat(100)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(2)
    const encoder = new TextEncoder()
    for (const [i, part] of parts.entries()) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75)
      if (i > 0) expect(part.startsWith(' ')).toBe(true)
      // A broken UTF-8 sequence or surrogate pair would show as U+FFFD here
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(part))).toBe(part)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
    expect(foldLine('SHORT:x')).toBe('SHORT:x')
  })

  it('names the file after the title, safely', () => {
    expect(icsFileName('週會: 11/10 <draft>')).toBe('週會 1110 draft.ics')
    expect(icsFileName('***')).toBe('meeting.ics')
  })
})
