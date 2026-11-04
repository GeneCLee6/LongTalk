// I3 (e1-t14): the meeting checks the Worker and the form share, and the calendar links
import { describe, expect, it } from 'vitest'
import { googleCalendarUrl, outlookCalendarUrl } from '../../shared/calendar-links.ts'
import {
  MEETING_JOIN_EARLY_MS,
  MEETING_START_SLACK_MS,
  canonicalTimeZone,
  isMeetingId,
  meetingPhase,
  normalizeDescription,
  parseMeetingInput,
} from '../../shared/meeting.ts'

const NOW = Date.UTC(2026, 10, 4, 0, 0)
const START = Date.UTC(2026, 10, 10, 3, 0)

const valid = {
  title: 'Weekly sync',
  description: null,
  startsAt: START,
  durationMin: 60,
  timeZone: 'Asia/Taipei',
  roomSlug: 'gene-weekly',
}

describe('meeting input', () => {
  it('takes a whole meeting and cleans the text', () => {
    expect(parseMeetingInput({ ...valid, title: ' Weekly \n sync ' }, NOW)).toEqual({
      input: { ...valid, title: 'Weekly sync' },
    })
  })

  it('keeps line breaks in a description, drops control and bidi characters, caps the length', () => {
    expect(normalizeDescription('  a\r\nb  \r\n\r\n\tc\u0007‮ ')).toBe('a\nb\n\n\tc')
    expect(normalizeDescription('   ')).toBeNull()
    expect(normalizeDescription(undefined)).toBeNull()
    expect(normalizeDescription('週'.repeat(1000))).toBe('週'.repeat(1000))
    expect(normalizeDescription('週'.repeat(1001))).toBe(false)
    expect(normalizeDescription(['x'])).toBe(false)
  })

  it('knows IANA zones and gives their canonical names', () => {
    expect(canonicalTimeZone('Asia/Taipei')).toBe('Asia/Taipei')
    expect(canonicalTimeZone('UTC')).toBe('UTC')
    expect(canonicalTimeZone('Australia/Sydney')).toBe('Australia/Sydney')
    for (const bad of ['Mars/Olympus', '', 'Asia/Taipei; DROP', 'x'.repeat(65), 7]) {
      expect(canonicalTimeZone(bad)).toBeNull()
    }
  })

  it('allows a start a little in the past, never far; the start already saved may stay', () => {
    expect('input' in parseMeetingInput({ ...valid, startsAt: NOW - MEETING_START_SLACK_MS }, NOW)).toBe(true)
    expect(parseMeetingInput({ ...valid, startsAt: NOW - MEETING_START_SLACK_MS - 1 }, NOW)).toEqual({
      problem: 'past',
    })
    expect('input' in parseMeetingInput({ ...valid, startsAt: NOW - 1e7 }, NOW, NOW - 1e7)).toBe(true)
  })

  it('recognises meeting ids: 22 base64url characters', () => {
    expect(isMeetingId('Qm9va2VkTWVldGluZzAx_-')).toBe(true)
    for (const bad of ['short', 'Qm9va2VkTWVldGluZzAx_-x', 'Qm9va2VkTWVldGluZzAx/=', 1]) {
      expect(isMeetingId(bad)).toBe(false)
    }
  })

  it('opens the join window MEETING_JOIN_EARLY_MS before the start', () => {
    const meeting = { startsAt: START, durationMin: 30 }
    expect(meetingPhase(meeting, START - MEETING_JOIN_EARLY_MS - 1)).toBe('later')
    expect(meetingPhase(meeting, START - MEETING_JOIN_EARLY_MS)).toBe('soon')
    expect(meetingPhase(meeting, START)).toBe('live')
    expect(meetingPhase(meeting, START + 30 * 60_000)).toBe('over')
  })
})

describe('calendar links', () => {
  const event = {
    title: '產品週會 & retro',
    details: '議程\n加入會議：https://longtalk.example/m/abc',
    location: 'https://longtalk.example/m/abc',
    start: START,
    end: START + 90 * 60_000,
    timeZone: 'Asia/Taipei',
  }

  it('fills in Google Calendar’s new-event form with UTC times and the organizer’s zone', () => {
    const url = new URL(googleCalendarUrl(event))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'TEMPLATE',
      text: event.title,
      dates: '20261110T030000Z/20261110T043000Z',
      details: event.details,
      location: event.location,
      ctz: 'Asia/Taipei',
    })
  })

  it('fills in Outlook’s, personal and work', () => {
    const personal = new URL(outlookCalendarUrl(event))
    expect(personal.origin + personal.pathname).toBe('https://outlook.live.com/calendar/0/deeplink/compose')
    expect(Object.fromEntries(personal.searchParams)).toEqual({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: event.title,
      startdt: '2026-11-10T03:00:00Z',
      enddt: '2026-11-10T04:30:00Z',
      body: event.details,
      location: event.location,
    })
    expect(new URL(outlookCalendarUrl(event, 'work')).host).toBe('outlook.office.com')
  })
})
