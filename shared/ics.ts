// An iCalendar file for one meeting (I3, e1-t14; RFC 5545): what 「下載 .ics」 saves. Pure, so the
// golden files in tests/shared/fixtures pin it byte for byte. Times are UTC (`Z`), so no
// VTIMEZONE is needed and every calendar shows the meeting in its own zone. Single meetings
// only: no RRULE (shared/meeting.ts says why).

export type IcsEvent = {
  /** Globally unique and stable across edits: the same UID updates the event instead of adding one */
  uid: string
  /** The last change (DTSTAMP) */
  stamp: number
  /** Edits so far (SEQUENCE): a calendar takes the higher one as the newer */
  sequence: number
  start: number
  end: number
  summary: string
  description: string
  /** The meeting's public page: URL and LOCATION */
  url: string
}

const CRLF = '\r\n'

/** 20261110T030000Z: a UTC DATE-TIME (RFC 5545 §3.3.5, form 2) */
export function icsTime(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** A TEXT value (§3.3.11): backslash, semicolon, comma and line ends escaped */
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

const encoder = new TextEncoder()

/**
 * A content line folded (§3.1): no line longer than 75 octets, each continuation starting with
 * one space. Splits only between characters, never inside a UTF-8 sequence (or a surrogate pair)
 */
export function foldLine(line: string): string {
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const char of line) {
    const bytes = encoder.encode(char).length
    // The first line has 75 octets; each continuation 74 after its leading space
    const limit = parts.length === 0 ? 75 : 74
    if (size + bytes > limit) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += char
    size += bytes
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

/** The whole file: one VEVENT in a VCALENDAR, CRLF line ends, every line folded */
export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LongTalk//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${icsTime(event.stamp)}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `URL:${event.url}`,
    `LOCATION:${escapeText(event.url)}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join(CRLF) + CRLF
}

/** A file name for the download: the title's safe characters, else `meeting` */
export function icsFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return `${safe || 'meeting'}.ics`
}
