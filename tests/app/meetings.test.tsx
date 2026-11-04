// I3 (e1-t14): scheduled meetings in the browser: times in a zone (Intl), the invitation text,
// the .ics and calendar links built from a meeting, /me's 「預定會議」 against a stand-in API, and
// the public /m/<id> page (countdown, the join button, not found)
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../../shared/account.ts'
import type { MeetingInfo, PublicMeeting } from '../../shared/meeting.ts'
import {
  calendarLinks,
  countdownText,
  fromLocalInputs,
  invitationText,
  meetingIcs,
  meetingWhen,
  toLocalInputs,
} from '../../src/meeting/invite.ts'
import MePage from '../../src/pages/MePage.tsx'
import MeetingPage from '../../src/pages/MeetingPage.tsx'
import { zhTW as text } from '../../src/i18n/zh-TW.ts'
import { en } from '../../src/i18n/en.ts'
import { browserTimeZone, formatZone, setLocale } from '../../src/strings.ts'

const ORIGIN = 'https://longtalk.example'
const START = Date.UTC(2026, 10, 10, 3, 0) // 11:00 in Taipei, 14:00 in Sydney (daylight time)

const MEETING: MeetingInfo = {
  id: 'Qm9va2VkTWVldGluZzAx_-',
  title: '產品週會',
  description: '議程：\n1. 進度',
  startsAt: START,
  durationMin: 60,
  timeZone: 'Asia/Taipei',
  roomSlug: 'gene-weekly',
  sequence: 2,
  createdAt: START - 86_400_000,
  updatedAt: START - 3_600_000,
}

describe('times and zones (Intl)', () => {
  it('writes the meeting in a zone with the zone’s name and offset', () => {
    const taipei = meetingWhen(MEETING, 'Asia/Taipei')
    expect(taipei).toContain('2026年11月10日')
    expect(taipei).toContain('11:00–12:00')
    expect(taipei).toContain('GMT+8')
    const sydney = meetingWhen(MEETING, 'Australia/Sydney')
    expect(sydney).toContain('14:00–15:00')
    expect(sydney).toContain('GMT+11')
    expect(formatZone(START, 'Australia/Sydney').offset).toBe('GMT+11')
    // Winter in Sydney: the offset follows daylight saving
    expect(formatZone(Date.UTC(2026, 5, 1), 'Australia/Sydney').offset).toBe('GMT+10')
    expect(formatZone(START, 'UTC').offset).toMatch(/^GMT(\+0)?$/)
  })

  it('carries the end’s own date when it is another day', () => {
    const late = { ...MEETING, startsAt: Date.UTC(2026, 10, 10, 15, 30), durationMin: 60 }
    const when = meetingWhen(late, 'Asia/Taipei', false)
    expect(when).toMatch(/^2026年11月10日\s?週二 23:30–2026年11月11日\s?週三 00:30$/)
  })

  it('writes English in the English locale', () => {
    setLocale('en', false)
    const when = meetingWhen(MEETING, 'Australia/Sydney')
    expect(when).toMatch(/Tue,? 10 Nov 2026/)
    expect(when).toMatch(/2:00\s?pm–3:00\s?pm/i)
    expect(countdownText(90_061_000)).toBe('1 day 1 hour')
    expect(invitationText(MEETING, 'Gene', ORIGIN)).toContain(en.meetings.invite.heading('Gene'))
  })

  it('counts down in days, hours, minutes and seconds', () => {
    expect(countdownText(2 * 86_400_000 + 3 * 3_600_000 + 5_000)).toBe('2 天 3 小時')
    expect(countdownText(3 * 3_600_000 + 4 * 60_000)).toBe('3 小時 4 分鐘')
    expect(countdownText(12 * 60_000 + 30_000)).toBe('12 分 30 秒')
    expect(countdownText(-5)).toBe('0 分 0 秒')
  })

  it('turns the date and time inputs into an instant in the browser’s zone and back', () => {
    const at = fromLocalInputs('2026-11-10', '14:05')!
    expect(new Date(at).getHours()).toBe(14)
    expect(new Date(at).getMinutes()).toBe(5)
    expect(toLocalInputs(at)).toEqual({ date: '2026-11-10', time: '14:05' })
    expect(fromLocalInputs('', '14:05')).toBeNull()
    expect(fromLocalInputs('2026-11-10', '')).toBeNull()
  })
})

describe('invitation, .ics and calendar links', () => {
  it('has the link and the organizer’s time; the password only when the owner adds it', () => {
    const plain = invitationText(MEETING, 'Gene', ORIGIN)
    expect(plain.split('\n').slice(0, 5)).toEqual([
      text.meetings.invite.heading('Gene'),
      '',
      text.meetings.invite.title('產品週會'),
      text.meetings.invite.time(meetingWhen(MEETING, 'Asia/Taipei')),
      text.meetings.invite.link(`${ORIGIN}/m/${MEETING.id}`),
    ])
    expect(plain).toContain('議程：\n1. 進度')
    expect(plain).not.toContain(text.meetings.invite.password(''))
    expect(invitationText(MEETING, 'Gene', ORIGIN, '1234')).toContain(text.meetings.invite.password('1234'))
  })

  it('builds the .ics with a stable UID, the edit count and the page as URL and LOCATION', () => {
    const ics = meetingIcs(MEETING, ORIGIN)
    expect(ics).toContain(`UID:${MEETING.id}@longtalk.example\r\n`)
    expect(ics).toContain('SEQUENCE:2\r\n')
    expect(ics).toContain('DTSTART:20261110T030000Z\r\n')
    expect(ics).toContain('DTEND:20261110T040000Z\r\n')
    expect(ics).toContain('DTSTAMP:20261110T020000Z\r\n')
    expect(ics.replace(/\r\n /g, '')).toContain(`URL:${ORIGIN}/m/${MEETING.id}\r\n`)
    expect(ics.replace(/\r\n /g, '')).toContain(
      `DESCRIPTION:議程：\\n1. 進度\\n\\n${text.meetings.calendarJoin(`${ORIGIN}/m/${MEETING.id}`)}`,
    )
  })

  it('links Google and both Outlooks to the page', () => {
    const links = calendarLinks(MEETING, ORIGIN)
    expect(links.map((l) => l.key)).toEqual(['google', 'outlook', 'outlookWork'])
    for (const link of links) expect(new URL(link.href).searchParams.toString()).toContain(MEETING.id)
  })
})

// /me's section and the public page

const ROOM = {
  slug: 'gene-weekly',
  createdAt: 1,
  name: '週會',
  waitingRoom: true,
  locked: false,
  password: true,
  memberCount: 0,
}

function me(meetings: MeetingInfo[]): MeResponse {
  return {
    account: { id: 'acc', name: 'Gene', createdAt: 1 },
    passkeys: [{ id: 'p', createdAt: 1, lastUsedAt: null, provider: null, backedUp: false }],
    sessions: [{ id: 's', createdAt: 1, lastSeenAt: 1, current: true }],
    rooms: [ROOM],
    meetings,
  }
}

type Call = { method: string; path: string; body: unknown }

function stubApi(state: { meetings: MeetingInfo[] }, publicMeeting: PublicMeeting | null = null) {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ method, path: input, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (input.startsWith('/api/meetings/')) return publicMeeting ? json(publicMeeting) : json({ error: 'not_found' }, 404)
      if (method === 'GET' && input === '/api/account') return json(me(state.meetings))
      if (method === 'POST' && input === '/api/account/meetings') {
        const meeting = { ...MEETING, ...(JSON.parse(String(init.body)) as object), id: 'NewMeetingId0000000000' }
        state.meetings = [...state.meetings, meeting]
        return json({ meeting }, 201)
      }
      if (method === 'DELETE' && input.startsWith('/api/account/meetings/')) {
        state.meetings = []
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 204 })
    }),
  )
  return calls
}

const visitMe = () =>
  render(
    <MemoryRouter>
      <MePage />
    </MemoryRouter>,
  )

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('/me 「預定會議」', () => {
  it('schedules a meeting in one of your rooms, in this browser’s zone', async () => {
    const state = { meetings: [] as MeetingInfo[] }
    const calls = stubApi(state)
    visitMe()
    const section = await screen.findByRole('region', { name: text.meetings.title })
    expect(within(section).getByText(text.meetings.none)).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: text.meetings.create }))
    const form = within(section).getByRole('form', { name: text.meetings.newTitle })
    expect(within(form).getByText(new RegExp(browserTimeZone().replace('/', '\\/')))).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: text.meetings.save }))
    // Nothing is sent while the title is empty
    expect(within(form).getByRole('alert')).toHaveTextContent(text.meetings.problems.title)
    fireEvent.change(within(form).getByRole('textbox', { name: text.meetings.titleLabel }), {
      target: { value: '產品週會' },
    })
    fireEvent.change(within(form).getByLabelText(text.meetings.dateLabel), { target: { value: '2027-03-02' } })
    fireEvent.change(within(form).getByLabelText(text.meetings.timeLabel), { target: { value: '09:30' } })
    fireEvent.change(within(form).getByRole('combobox', { name: text.meetings.durationLabel }), {
      target: { value: '90' },
    })
    fireEvent.click(within(form).getByRole('button', { name: text.meetings.save }))
    expect(await screen.findByText(text.meetings.saved)).toBeInTheDocument()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({
      title: '產品週會',
      description: null,
      startsAt: fromLocalInputs('2027-03-02', '09:30'),
      durationMin: 90,
      timeZone: browserTimeZone(),
      roomSlug: 'gene-weekly',
    })
  })

  it('copies the invitation, with the password only when chosen, and deletes after asking', async () => {
    const future = { ...MEETING, startsAt: Date.now() + 86_400_000 }
    stubApi({ meetings: [future] })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    visitMe()
    const copy = await screen.findByRole('button', { name: text.meetings.copyInviteLabel('產品週會') })
    // The room has a password: the owner chooses first
    fireEvent.click(copy)
    const panel = screen.getByRole('form', { name: text.meetings.copyInvite })
    fireEvent.click(within(panel).getByRole('button', { name: text.meetings.copyNow }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]).toEqual([invitationText(future, 'Gene', location.origin)])
    fireEvent.click(copy)
    const again = screen.getByRole('form', { name: text.meetings.copyInvite })
    fireEvent.click(within(again).getByRole('checkbox', { name: text.meetings.invitePassword }))
    fireEvent.change(within(again).getByLabelText(text.meetings.invitePasswordLabel), { target: { value: '4321' } })
    fireEvent.click(within(again).getByRole('button', { name: text.meetings.copyNow }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect((writeText.mock.calls[1] as unknown as [string])[0]).toContain(text.meetings.invite.password('4321'))

    const google = screen.getByRole('link', { name: text.meetings.newTab(text.meetings.google) })
    expect(google).toHaveAttribute('target', '_blank')
    expect(google).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: text.meetings.openPage })).toHaveAttribute('href', `/m/${MEETING.id}`)

    fireEvent.click(screen.getByRole('button', { name: text.meetings.deleteLabel('產品週會') }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: text.meetings.delete }))
    expect(await screen.findByText(text.meetings.none)).toBeInTheDocument()
  })

  it('needs a persistent room first', async () => {
    stubApi({ meetings: [] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...me([]), rooms: [] }), { status: 200 })),
    )
    visitMe()
    expect(await screen.findByText(text.meetings.needRoom)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: text.meetings.create })).toBeNull()
  })
})

function publicOf(meeting: MeetingInfo, room: string | null): PublicMeeting {
  const { roomSlug: _room, createdAt: _created, ...rest } = meeting
  return { ...rest, organizer: 'Gene', room, joinFrom: meeting.startsAt - 15 * 60_000 }
}

const visitPage = (id: string) =>
  render(
    <MemoryRouter initialEntries={[`/m/${id}`]}>
      <Routes>
        <Route path="/m/:meetingId" element={<MeetingPage />} />
        <Route path="/r/:roomId" element={<p>room page</p>} />
      </Routes>
    </MemoryRouter>,
  )

describe('/m/<id>', () => {
  it('shows the meeting, the organizer’s name only, a countdown and a join button that waits', async () => {
    const meeting = { ...MEETING, startsAt: Date.now() + 2 * 3_600_000 }
    stubApi({ meetings: [] }, publicOf(meeting, null))
    visitPage(MEETING.id)
    expect(await screen.findByRole('heading', { level: 1, name: '產品週會' })).toBeInTheDocument()
    expect(screen.getByText(text.meetings.page.organizer('Gene'))).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: text.meetings.yourTime(meetingWhen(meeting)) })).toBeInTheDocument()
    expect(screen.getByText(/後開始$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: text.meetings.page.join })).toBeDisabled()
    expect(screen.getByRole('button', { name: text.meetings.downloadIcs })).toBeInTheDocument()
    if (browserTimeZone() !== 'Asia/Taipei') {
      expect(screen.getByText(text.meetings.organizerTime(meetingWhen(meeting, 'Asia/Taipei')))).toBeInTheDocument()
    }
  })

  it('downloads the .ics in the page', async () => {
    stubApi({ meetings: [] }, publicOf({ ...MEETING, startsAt: Date.now() + 3_600_000 }, null))
    const createObjectURL = vi.fn((blob: Blob) => (blob ? 'blob:x' : ''))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    visitPage(MEETING.id)
    fireEvent.click(await screen.findByRole('button', { name: text.meetings.downloadIcs }))
    expect(click).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('text/calendar;charset=utf-8')
    expect(await blob.text()).toContain('BEGIN:VCALENDAR\r\n')
    click.mockRestore()
  })

  it('joins once the Worker names the room', async () => {
    const meeting = { ...MEETING, startsAt: Date.now() + 5 * 60_000 }
    stubApi({ meetings: [] }, publicOf(meeting, 'gene-weekly'))
    visitPage(MEETING.id)
    const join = await screen.findByRole('link', { name: text.meetings.page.join })
    expect(join).toHaveAttribute('href', '/r/gene-weekly')
    await act(async () => fireEvent.click(join))
    expect(screen.getByText('room page')).toBeInTheDocument() // literal-ok: test route
  })

  it('says so when there is no such meeting', async () => {
    stubApi({ meetings: [] }, null)
    visitPage(MEETING.id)
    expect(await screen.findByText(text.meetings.page.notFound)).toBeInTheDocument()
    visitPage('bad')
    expect((await screen.findAllByText(text.meetings.page.notFound)).length).toBe(2)
  })
})
