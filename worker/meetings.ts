import {
  MEETING_JOIN_EARLY_MS,
  MEETING_RETENTION_MS,
  isMeetingId,
  type MeetingInfo,
  type PublicMeeting,
} from '../shared/meeting.ts'
import { isBlocked, takeIsolateRate, type GuardDeps } from './abuse.ts'
import { AccountDb, type MeetingRow } from './account-db.ts'
import type { Env } from './app.ts'
import { requestClientKey } from './client-key.ts'

// Scheduled meetings (I3, e1-t14). The owner's calls (create, edit, delete) are account calls
// (worker/accounts.ts: signed in, Origin and JSON checked, counted in GuardDO); this file has
// what they share and the one public call:
//
//   GET /api/meetings/<id>   the meeting's public page (/m/<id>): no sign-in
//
// Anyone with the link sees the title, description, time and zone, and the organizer's display
// name; nothing else of the account. The room is named only from MEETING_JOIN_EARLY_MS before the
// start. The id is 16 random bytes: the link is the secret, like a room's.

const noStore = { 'cache-control': 'no-store' }

/** Rows that ended before this are past retention: never read, deleted on the next save */
export const keptAfter = (now: number) => now - MEETING_RETENTION_MS

export function meetingInfo(row: MeetingRow): MeetingInfo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    durationMin: row.duration_min,
    timeZone: row.time_zone,
    roomSlug: row.room_slug,
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function publicMeeting(row: MeetingRow & { organizer: string }, now: number): PublicMeeting {
  const joinFrom = row.starts_at - MEETING_JOIN_EARLY_MS
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    durationMin: row.duration_min,
    timeZone: row.time_zone,
    sequence: row.sequence,
    updatedAt: row.updated_at,
    organizer: row.organizer,
    room: now >= joinFrom ? row.room_slug : null,
    joinFrom,
  }
}

export type MeetingViewDeps = { guard: GuardDeps; now?: () => number }

/** GET /api/meetings/<id> */
export async function handleMeetingView(
  request: Request,
  env: Env,
  url: URL,
  deps: MeetingViewDeps,
): Promise<Response> {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...noStore, ...headers } })
  if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { allow: 'GET' })
  const match = /^\/api\/meetings\/([^/]+)$/.exec(url.pathname)
  if (!match || !isMeetingId(match[1])) return reply(404, { error: 'not_found' })
  if (!env.DB) return reply(503, { error: 'unavailable' })
  const now = (deps.now ?? Date.now)()
  const key = await requestClientKey(request, env)
  if (key && (await isBlocked(key, deps.guard))) return reply(403, { error: 'blocked' })
  if (key && !takeIsolateRate(key, now)) {
    return reply(429, { error: 'rate_limited', retryAfter: 10 }, { 'retry-after': '10' })
  }
  try {
    const row = await new AccountDb(env.DB).publicMeeting(match[1], keptAfter(now))
    if (!row) return reply(404, { error: 'not_found' })
    return reply(200, publicMeeting(row, now))
  } catch (error) {
    console.error('meeting view failed', error)
    return reply(503, { error: 'unavailable' })
  }
}
