import { googleCalendarUrl, outlookCalendarUrl, type CalendarEvent } from '../../shared/calendar-links.ts'
import { buildIcs, icsFileName } from '../../shared/ics.ts'
import { meetingEnd, meetingPageUrl } from '../../shared/meeting.ts'
import { formatMeetingClock, formatMeetingDate, formatZone, strings } from '../strings.ts'

// What /me's 「預定會議」 and the public /m/<id> page both build from a meeting (I3, e1-t14): the
// time as text in a zone, the invitation to copy, the .ics file and the calendar links. All of it
// in the browser, in the current language; nothing here talks to the server.

/** The part of a meeting these need (MeetingInfo and PublicMeeting both have it) */
export type MeetingTime = {
  id: string
  title: string
  description: string | null
  startsAt: number
  durationMin: number
  timeZone: string
  sequence: number
  updatedAt: number
}

/**
 * 2026年11月10日 週二 14:00–15:00 in `timeZone` (the browser's when left out); an end on another
 * day carries its own date. `zone` adds the zone's name and offset
 */
export function meetingWhen(meeting: MeetingTime, timeZone?: string, zone = true): string {
  const end = meetingEnd(meeting)
  const startDate = formatMeetingDate(meeting.startsAt, timeZone)
  const endDate = formatMeetingDate(end, timeZone)
  const endText =
    endDate === startDate ? formatMeetingClock(end, timeZone) : `${endDate} ${formatMeetingClock(end, timeZone)}`
  const when = strings.meetings.when(startDate, formatMeetingClock(meeting.startsAt, timeZone), endText)
  if (!zone) return when
  const { name, offset } = formatZone(meeting.startsAt, timeZone)
  return `${when} ${strings.meetings.zone(name, offset)}`
}

/** The zone as the form shows it: 澳洲東部時間（GMT+11）· Australia/Sydney */
export function zoneLabel(at: number, timeZone?: string): string {
  const { name, offset } = formatZone(at, timeZone)
  return strings.meetings.zone(name, offset)
}

/**
 * The text 「複製邀請」 copies: who invites, the title, the time in the organizer's zone, the
 * link; the room password only when the owner chose to add it this time; the description last
 */
export function invitationText(
  meeting: MeetingTime,
  organizer: string,
  origin: string,
  password: string | null = null,
): string {
  const text = strings.meetings.invite
  const lines = [
    text.heading(organizer),
    '',
    text.title(meeting.title),
    text.time(meetingWhen(meeting, meeting.timeZone)),
    text.link(meetingPageUrl(origin, meeting.id)),
  ]
  if (password) lines.push(text.password(password))
  if (meeting.description) lines.push('', meeting.description)
  return lines.join('\n')
}

/** The description calendars get: the meeting's own, then how to join */
function calendarDetails(meeting: MeetingTime, url: string): string {
  const join = strings.meetings.calendarJoin(url)
  return meeting.description ? `${meeting.description}\n\n${join}` : join
}

/** The .ics file's text (shared/ics.ts) */
export function meetingIcs(meeting: MeetingTime, origin: string): string {
  const url = meetingPageUrl(origin, meeting.id)
  return buildIcs({
    uid: `${meeting.id}@${new URL(origin).host}`,
    stamp: meeting.updatedAt,
    sequence: meeting.sequence,
    start: meeting.startsAt,
    end: meetingEnd(meeting),
    summary: meeting.title,
    description: calendarDetails(meeting, url),
    url,
  })
}

/** Saves the .ics file (a download made in the page: nothing to fetch) */
export function downloadIcs(meeting: MeetingTime, origin: string): void {
  const blob = new Blob([meetingIcs(meeting, origin)], { type: 'text/calendar;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = icsFileName(meeting.title)
  document.body.append(link)
  link.click()
  link.remove()
  // The download has started by now; the object URL is not needed after it
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

/** Google and both Outlooks: each opens its own new-event form, filled in */
export function calendarLinks(meeting: MeetingTime, origin: string) {
  const url = meetingPageUrl(origin, meeting.id)
  const event: CalendarEvent = {
    title: meeting.title,
    details: calendarDetails(meeting, url),
    location: url,
    start: meeting.startsAt,
    end: meetingEnd(meeting),
    timeZone: meeting.timeZone,
  }
  return [
    { key: 'google', name: strings.meetings.google, href: googleCalendarUrl(event) },
    { key: 'outlook', name: strings.meetings.outlook, href: outlookCalendarUrl(event, 'personal') },
    { key: 'outlookWork', name: strings.meetings.outlookWork, href: outlookCalendarUrl(event, 'work') },
  ] as const
}

/** How long until `at`, in words: 2 天 3 小時; 12 分 30 秒 */
export function countdownText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return strings.meetings.countdown(
    Math.floor(seconds / 86_400),
    Math.floor((seconds % 86_400) / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  )
}

/** The browser's local date and time inputs for an instant: 2026-11-10 and 14:00 */
export function toLocalInputs(at: number): { date: string; time: string } {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** The instant the date and time inputs name in the browser's zone; null when either is incomplete */
export function fromLocalInputs(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const clock = /^(\d{2}):(\d{2})/.exec(time)
  if (!day || !clock) return null
  const at = new Date(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    Number(clock[1]),
    Number(clock[2]),
  ).getTime()
  return Number.isFinite(at) ? at : null
}
