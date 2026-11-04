import { normalizeName } from './protocol.ts'
import { isSlug } from './slug.ts'

// Scheduled meetings (I3, e1-t14): what the Worker (worker/meetings.ts) and the pages (/me's
// 「預定會議」, the public /m/<id>) share. A meeting is single (no recurrence: AC-1.7 does not
// ask for it) and happens in one of the owner's persistent rooms, which exists before the
// meeting starts; its password and waiting room are that room's settings. The checks here are
// the server's (the form uses the same ones to say what is wrong before sending).

/** Owner calls are /api/account/meetings[/<id>]; the public page reads /api/meetings/<id> */
export const MEETINGS_API = '/api/meetings'

/** A title's length in characters (code points), after normalizeName */
export const MAX_MEETING_TITLE_CHARS = 100
/** A description's length in characters (code points), after normalizeDescription */
export const MAX_MEETING_DESCRIPTION_CHARS = 1000
/** Shortest and longest meeting, in minutes */
export const MIN_MEETING_MINUTES = 5
export const MAX_MEETING_MINUTES = 24 * 60
/** The durations the form offers (any whole minute in range is accepted) */
export const MEETING_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const
/** How far ahead a meeting may be scheduled */
export const MAX_MEETING_AHEAD_MS = 2 * 366 * 24 * 60 * 60_000
/** A new start may be this far in the past (the form's clock and the server's differ a little) */
export const MEETING_START_SLACK_MS = 10 * 60_000
/** The public page's join button turns on this long before the start */
export const MEETING_JOIN_EARLY_MS = 15 * 60_000
/** A meeting is deleted this long after it ended (e11 「帳號資料」) */
export const MEETING_RETENTION_MS = 90 * 24 * 60 * 60_000
/** Meetings one account may have at once, past ones (until retention) included */
export const MAX_MEETINGS = 50

/** 16 random bytes, base64url: an unguessable meeting id */
const MEETING_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export function isMeetingId(value: unknown): value is string {
  return typeof value === 'string' && MEETING_ID_PATTERN.test(value)
}

/** A meeting as its owner sees it on /me */
export type MeetingInfo = {
  id: string
  title: string
  description: string | null
  /** Epoch milliseconds, UTC */
  startsAt: number
  durationMin: number
  /** The organizer's IANA time zone when they saved it */
  timeZone: string
  /** The persistent room it happens in (/r/<slug>) */
  roomSlug: string
  /** Edits so far (the .ics SEQUENCE) */
  sequence: number
  createdAt: number
  updatedAt: number
}

/**
 * GET /api/meetings/<id>: what anyone with the link sees. Only the organizer's display name; the
 * room is named only from MEETING_JOIN_EARLY_MS before the start (null until then)
 */
export type PublicMeeting = Omit<MeetingInfo, 'roomSlug' | 'createdAt'> & {
  organizer: string
  room: string | null
  /** When the join button turns on */
  joinFrom: number
}

/** POST /api/account/meetings and PUT /api/account/meetings/<id>: the whole meeting */
export type MeetingInput = {
  title: string
  description: string | null
  startsAt: number
  durationMin: number
  timeZone: string
  roomSlug: string
}

/** What is wrong with a meeting the form or the API was given */
export type MeetingProblem = 'title' | 'description' | 'start' | 'past' | 'ahead' | 'duration' | 'timeZone' | 'room'

/** Control characters but newline and tab, and the bidirectional overrides */
const UNSAFE_TEXT_CHARS = /(?![\n\t])[\p{Cc}‪-‮⁦-⁩]/gu

/**
 * A description as it is kept: unsafe characters out (newlines and tabs stay), line ends as \n,
 * trailing spaces and blank lines trimmed. Null when empty; `false` when too long or not text
 */
export function normalizeDescription(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_TEXT_CHARS, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  if (text === '') return null
  return [...text].length > MAX_MEETING_DESCRIPTION_CHARS ? false : text
}

/** The IANA zone's canonical name when the runtime knows it (Intl), else null */
export function canonicalTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null
  if (!/^[A-Za-z0-9_+\-/]+$/.test(raw)) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/**
 * The meeting in a request body, every value checked; `problem` names the first thing wrong.
 * `keepStart` is the start already saved (an edit may leave a meeting that started as it is).
 * The room is only checked to look like a slug here: whose it is, the Worker checks.
 */
export function parseMeetingInput(
  raw: unknown,
  now: number,
  keepStart: number | null = null,
): { input: MeetingInput } | { problem: MeetingProblem } {
  const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const title = normalizeName(body.title, MAX_MEETING_TITLE_CHARS)
  if (!title) return { problem: 'title' }
  const description = normalizeDescription(body.description)
  if (description === false) return { problem: 'description' }
  const startsAt = body.startsAt
  if (typeof startsAt !== 'number' || !Number.isSafeInteger(startsAt) || startsAt < 0) {
    return { problem: 'start' }
  }
  if (startsAt !== keepStart) {
    if (startsAt < now - MEETING_START_SLACK_MS) return { problem: 'past' }
    if (startsAt > now + MAX_MEETING_AHEAD_MS) return { problem: 'ahead' }
  }
  const durationMin = body.durationMin
  if (
    typeof durationMin !== 'number' ||
    !Number.isInteger(durationMin) ||
    durationMin < MIN_MEETING_MINUTES ||
    durationMin > MAX_MEETING_MINUTES
  ) {
    return { problem: 'duration' }
  }
  const timeZone = canonicalTimeZone(body.timeZone)
  if (!timeZone) return { problem: 'timeZone' }
  const roomSlug = body.roomSlug
  if (!isSlug(roomSlug)) return { problem: 'room' }
  return { input: { title, description, startsAt, durationMin, timeZone, roomSlug } }
}

/** When the meeting ends, epoch milliseconds */
export const meetingEnd = (meeting: { startsAt: number; durationMin: number }) =>
  meeting.startsAt + meeting.durationMin * 60_000

/** Where a meeting stands at `now`: before its join window, joinable before the start, on, over */
export type MeetingPhase = 'later' | 'soon' | 'live' | 'over'

export function meetingPhase(meeting: { startsAt: number; durationMin: number }, now: number): MeetingPhase {
  if (now >= meetingEnd(meeting)) return 'over'
  if (now >= meeting.startsAt) return 'live'
  if (now >= meeting.startsAt - MEETING_JOIN_EARLY_MS) return 'soon'
  return 'later'
}

/** The public page of a meeting on this site */
export const meetingPageUrl = (origin: string, id: string) => `${origin}/m/${id}`
