// 「加入 Google 日曆」 and 「加入 Outlook」 (I3, e1-t14): links that open the calendar's own
// new-event form, filled in. Nothing is sent anywhere until the person saves it there. Times are
// UTC; Google also gets the organizer's zone (ctz) for its form.

export type CalendarEvent = {
  title: string
  details: string
  location: string
  start: number
  end: number
  /** IANA zone the form is shown in (Google only) */
  timeZone?: string
}

/** 20261110T030000Z */
const compact = (at: number) =>
  new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
/** 2026-11-10T03:00:00Z */
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${compact(event.start)}/${compact(event.end)}`,
    details: event.details,
    location: event.location,
  })
  if (event.timeZone) params.set('ctz', event.timeZone)
  return `https://calendar.google.com/calendar/render?${params}`
}

/** Outlook on the web: `personal` is outlook.live.com (Outlook.com), `work` outlook.office.com (Microsoft 365) */
export function outlookCalendarUrl(event: CalendarEvent, kind: 'personal' | 'work' = 'personal'): string {
  const host = kind === 'work' ? 'outlook.office.com' : 'outlook.live.com'
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: iso(event.start),
    enddt: iso(event.end),
    body: event.details,
    location: event.location,
  })
  return `https://${host}/calendar/0/deeplink/compose?${params}`
}
