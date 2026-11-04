// @vitest-environment node
// I3 (e1-t14): scheduled meetings through the account API on the real migrations (SQLite):
// validation, ownership on every change, the public view (organizer's name only, the room from
// the join window), GuardDO's count, cascades (room, account), retention, and 0002 applied on top
// of a database that already has I2's rows.
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeResponse } from '../../shared/account.ts'
import {
  MAX_MEETINGS,
  MEETING_JOIN_EARLY_MS,
  MEETING_RETENTION_MS,
  type MeetingInfo,
} from '../../shared/meeting.ts'
import { resetAbuseState } from '../../worker/abuse.ts'
import accounts from '../../migrations/0001_accounts.sql?raw'
import meetings from '../../migrations/0002_meetings.sql?raw'
import { setup } from './accountHarness.ts'
import { fakeD1 } from './d1.ts'

beforeEach(() => resetAbuseState())

const HOUR = 60 * 60_000
/** A network address: GuardDO counts per network, and only when there is one */
const IP = { 'CF-Connecting-IP': '203.0.113.9' }

async function owner(t: ReturnType<typeof setup>, name = 'Alice', slug = 'alice-room') {
  const browser = new t.Browser()
  await browser.signUp(name)
  expect((await browser.call('POST', '/rooms', { slug })).status).toBe(201)
  return browser
}

const input = (t: ReturnType<typeof setup>, change: Record<string, unknown> = {}) => ({
  title: 'Weekly sync',
  description: 'Agenda:\r\n1. Status; 2. Plans, next',
  startsAt: t.now() + 2 * 24 * HOUR,
  durationMin: 45,
  timeZone: 'Australia/Sydney',
  roomSlug: 'alice-room',
  ...change,
})

describe('scheduling', () => {
  it('saves a meeting with every value checked, and lists it on /me', async () => {
    const t = setup()
    const alice = await owner(t)
    const res = await alice.call('POST', '/meetings', input(t, { title: '  Weekly   sync ' }), IP)
    expect(res.status).toBe(201)
    const meeting = res.json.meeting as MeetingInfo
    expect(meeting).toMatchObject({
      title: 'Weekly sync',
      description: 'Agenda:\n1. Status; 2. Plans, next',
      durationMin: 45,
      timeZone: 'Australia/Sydney',
      roomSlug: 'alice-room',
      sequence: 0,
    })
    expect(meeting.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect((await alice.me()).meetings).toEqual([meeting])
    expect(t.limits).toContain('meeting')
  })

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(101) }, 'title'],
    [{ description: 'x'.repeat(1001) }, 'description'],
    [{ description: 42 }, 'description'],
    [{ startsAt: 'tomorrow' }, 'start'],
    [{ startsAt: 1.5 }, 'start'],
    [{ startsAt: -1 }, 'start'],
    [{ durationMin: 4 }, 'duration'],
    [{ durationMin: 24 * 60 + 1 }, 'duration'],
    [{ durationMin: 30.5 }, 'duration'],
    [{ timeZone: 'Mars/Olympus' }, 'timeZone'],
    [{ timeZone: '' }, 'timeZone'],
    [{ roomSlug: 'Not A Slug' }, 'room'],
  ])('refuses %j (%s)', async (change, problem) => {
    const t = setup()
    const alice = await owner(t)
    const res = await alice.call('POST', '/meetings', input(t, change))
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: 'meeting_invalid', problem })
    expect(t.count('meetings')).toBe(0)
  })

  it('refuses a start in the past or too far ahead, and a room that is not yours', async () => {
    const t = setup()
    const alice = await owner(t)
    await owner(t, 'Bob', 'bob-room')
    const past = await alice.call('POST', '/meetings', input(t, { startsAt: t.now() - HOUR }))
    expect(past.json.problem).toBe('past')
    // The form's clock a few minutes behind is fine
    expect((await alice.call('POST', '/meetings', input(t, { startsAt: t.now() - 60_000 }))).status).toBe(201)
    const far = await alice.call('POST', '/meetings', input(t, { startsAt: t.now() + 3 * 366 * 24 * HOUR }))
    expect(far.json.problem).toBe('ahead')
    for (const roomSlug of ['bob-room', 'nobody-room']) {
      const res = await alice.call('POST', '/meetings', input(t, { roomSlug }))
      expect(res.json).toEqual({ error: 'meeting_invalid', problem: 'room' })
    }
  })

  it('needs a signed-in browser, this origin and a JSON body', async () => {
    const t = setup()
    const alice = await owner(t)
    const stranger = new t.Browser()
    expect((await stranger.call('POST', '/meetings', input(t))).status).toBe(401)
    expect((await alice.call('POST', '/meetings', input(t), { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await alice.call('POST', '/meetings', 'x', { 'Content-Type': 'text/plain' })).status).toBe(415)
  })

  it('counts saves per network in GuardDO, and caps meetings per account', async () => {
    const t = setup()
    const alice = await owner(t)
    t.refuseLimit('meeting')
    const refused = await alice.call('POST', '/meetings', input(t), IP)
    expect(refused.status).toBe(429)
    expect(refused.json.error).toBe('rate_limited')
    t.refuseLimit(null)
    for (let i = 0; i < MAX_MEETINGS; i++) {
      expect((await alice.call('POST', '/meetings', input(t, { title: `M${i}` }))).status).toBe(201)
      // A fresh isolate rate now and then: this is one person saving 50 meetings
      if (i % 20 === 19) resetAbuseState()
    }
    expect((await alice.call('POST', '/meetings', input(t))).json.error).toBe('too_many_meetings')
  })
})

describe('only the owner changes a meeting', () => {
  it('edits (sequence + 1), keeps a start that already passed, deletes; others get 404', async () => {
    const t = setup()
    const alice = await owner(t)
    const bob = await owner(t, 'Bob', 'bob-room')
    const created = (await alice.call('POST', '/meetings', input(t, { startsAt: t.now() + HOUR })))
      .json.meeting as MeetingInfo
    const path = `/meetings/${created.id}`
    // Bob can neither edit nor delete it, nor learn that it exists
    expect((await bob.call('PUT', path, input(t, { roomSlug: 'bob-room' }))).status).toBe(404)
    expect((await bob.call('DELETE', path)).status).toBe(404)
    expect((await alice.call('PUT', '/meetings/not-an-id', input(t))).status).toBe(404)

    t.tick(2 * HOUR)
    // The meeting started: an edit may keep its start, not move it into the past
    const kept = await alice.call('PUT', path, input(t, { startsAt: created.startsAt, title: 'Renamed' }))
    expect(kept.status).toBe(200)
    expect(kept.json.meeting).toMatchObject({ title: 'Renamed', sequence: 1, startsAt: created.startsAt })
    expect((kept.json.meeting as MeetingInfo).updatedAt).toBe(t.now())
    const moved = await alice.call('PUT', path, input(t, { startsAt: created.startsAt - HOUR }))
    expect(moved.json.problem).toBe('past')
    expect((await alice.call('DELETE', path)).status).toBe(204)
    expect((await alice.call('DELETE', path)).status).toBe(404)
    expect(t.count('meetings')).toBe(0)
  })
})

describe('the public page', () => {
  it('shows the meeting and only the organizer’s name; the room from the join window', async () => {
    const t = setup()
    const alice = await owner(t)
    const created = (await alice.call('POST', '/meetings', input(t))).json.meeting as MeetingInfo
    const early = await t.view(created.id)
    expect(early.status).toBe(200)
    expect(early.json).toEqual({
      id: created.id,
      title: 'Weekly sync',
      description: 'Agenda:\n1. Status; 2. Plans, next',
      startsAt: created.startsAt,
      durationMin: 45,
      timeZone: 'Australia/Sydney',
      sequence: 0,
      updatedAt: created.updatedAt,
      organizer: 'Alice',
      room: null,
      joinFrom: created.startsAt - MEETING_JOIN_EARLY_MS,
    })
    t.tick(created.startsAt - MEETING_JOIN_EARLY_MS - t.now())
    expect((await t.view(created.id)).json.room).toBe('alice-room')
    // After it ended the room is still there (a persistent room)
    t.tick(MEETING_JOIN_EARLY_MS + 45 * 60_000 + HOUR)
    expect((await t.view(created.id)).json.room).toBe('alice-room')
  })

  it('answers 404 for an unknown or malformed id', async () => {
    const t = setup()
    expect((await t.view('AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)
    expect((await t.view('short')).status).toBe(404)
  })
})

describe('retention and cascades', () => {
  it('drops a meeting MEETING_RETENTION_MS after it ended (gone from /me and the page, then deleted)', async () => {
    const t = setup()
    const alice = await owner(t)
    const old = (await alice.call('POST', '/meetings', input(t, { startsAt: t.now() + HOUR, durationMin: 60 })))
      .json.meeting as MeetingInfo
    t.tick(2 * HOUR + MEETING_RETENTION_MS - 1)
    // Months later: the session has ended, the passkey signs in again
    await alice.signIn()
    expect((await alice.me()).meetings).toHaveLength(1)
    t.tick(1)
    expect((await alice.me()).meetings).toEqual([])
    expect((await t.view(old.id)).status).toBe(404)
    expect((await alice.call('PUT', `/meetings/${old.id}`, input(t))).status).toBe(404)
    // Still a row until the next save (anyone's) clears it
    expect(t.count('meetings')).toBe(1)
    await alice.call('POST', '/meetings', input(t))
    expect(t.count('meetings')).toBe(1)
    expect(t.sqlite.prepare('SELECT id FROM meetings').get()).not.toEqual({ id: old.id })
  })

  it('deletes a room’s meetings with the room, and everything with the account', async () => {
    const t = setup()
    const alice = await owner(t)
    expect((await alice.call('POST', '/rooms', { slug: 'alice-two' })).status).toBe(201)
    const bob = await owner(t, 'Bob', 'bob-room')
    await alice.call('POST', '/meetings', input(t))
    const second = (await alice.call('POST', '/meetings', input(t, { roomSlug: 'alice-two' })))
      .json.meeting as MeetingInfo
    await bob.call('POST', '/meetings', input(t, { roomSlug: 'bob-room' }))
    expect((await alice.call('DELETE', '/rooms/alice-room')).status).toBe(204)
    const me: MeResponse = await alice.me()
    expect(me.meetings.map((m) => m.id)).toEqual([second.id])
    expect((await alice.call('DELETE', '')).status).toBe(204)
    expect(t.count('meetings')).toBe(1)
    expect((await t.view(second.id)).status).toBe(404)
  })
})

describe('migration 0002', () => {
  it('before it is applied, /me still answers (no meetings) and saving one is 503', async () => {
    const t = setup([accounts])
    const alice = await owner(t)
    expect((await alice.me()).meetings).toEqual([])
    expect((await alice.call('POST', '/meetings', input(t))).status).toBe(503)
  })

  it('applies on top of 0001 with rows in it, and the foreign keys hold', () => {
    const { sqlite } = fakeD1([accounts])
    sqlite.exec("INSERT INTO accounts (id, name, created_at) VALUES ('acc', 'Alice', 1)")
    sqlite.exec("INSERT INTO rooms (slug, account_id, created_at) VALUES ('alice-room', 'acc', 1)")
    sqlite.exec(meetings)
    const insert = (id: string, account: string, room: string) =>
      sqlite
        .prepare(
          'INSERT INTO meetings (id, account_id, room_slug, title, starts_at, duration_min, ends_at, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 30, 1800000, ?, 0, 0)',
        )
        .run(id, account, room, 'T', 'UTC')
    insert('m1', 'acc', 'alice-room')
    expect(() => insert('m2', 'nobody', 'alice-room')).toThrow(/FOREIGN KEY/)
    expect(() => insert('m3', 'acc', 'no-room')).toThrow(/FOREIGN KEY/)
    const columns = sqlite.prepare("SELECT name FROM pragma_table_info('meetings')").all()
    expect(columns.map((c) => (c as { name: string }).name)).toEqual([
      'id',
      'account_id',
      'room_slug',
      'title',
      'description',
      'starts_at',
      'duration_min',
      'ends_at',
      'time_zone',
      'sequence',
      'created_at',
      'updated_at',
    ])
    // The cascades in the schema too (the Worker also deletes in order)
    sqlite.exec("DELETE FROM rooms WHERE slug = 'alice-room'")
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 0 })
  })
})
