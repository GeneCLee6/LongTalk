// Accounts and personal persistent rooms (I2, e1-t12, e1-t13): the /api/account API as the
// Worker (worker/accounts.ts) and the /me page (src/pages/MePage.tsx) both see it. Signing in is
// passkeys only (WebAuthn, the owner's decision in e1): no e-mail, no password. Accounts are
// optional: everything else works the same without one.

import type { MeetingInfo } from './meeting.ts'

/** Every account endpoint is under this */
export const ACCOUNT_API = '/api/account'

/** Passkeys one account may have (one per device or password manager is plenty) */
export const MAX_PASSKEYS = 10
/** Browsers signed in to one account at once; signing in once more signs the oldest out */
export const MAX_SESSIONS = 20
/** Persistent rooms one account may have */
export const MAX_PERSISTENT_ROOMS = 5

/** The one cookie LongTalk sets (worker/session.ts has its attributes; /privacy names it) */
export const SESSION_COOKIE = '__Host-lt_session'

/** A session nobody used for this long ends */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60_000
/** And every session ends this long after signing in, used or not: then sign in again */
export const SESSION_MAX_MS = 90 * 24 * 60 * 60_000
/** A session's token is replaced when it is this old (the cookie with it) */
export const SESSION_ROTATE_MS = 24 * 60 * 60_000
/** The token before the last rotation still works this long (requests already on their way) */
export const SESSION_ROTATE_GRACE_MS = 2 * 60_000
/** A WebAuthn challenge must be answered within this */
export const CHALLENGE_TTL_MS = 5 * 60_000

/** The account's own data, all of it (e11 「帳號資料」) */
export type AccountInfo = { id: string; name: string; createdAt: number }

/** Password managers and platforms named by their passkeys' AAGUID (public, not personal) */
export type PasskeyProvider =
  | 'google'
  | 'icloud'
  | 'windows'
  | 'chromeMac'
  | 'onePassword'
  | 'bitwarden'
  | 'samsung'
  | 'dashlane'

/**
 * AAGUIDs the authenticators publish (github.com/passkeydeveloper/passkey-authenticator-aaguids):
 * only to label the list on /me. Unknown ones are just 「通行密鑰」.
 */
export const PASSKEY_PROVIDERS: Readonly<Record<string, PasskeyProvider>> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'google',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'icloud',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'icloud',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'windows',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'windows',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'windows',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'chromeMac',
  'bada5566-a7aa-401f-bd96-45619a55120d': 'onePassword',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'bitwarden',
  '53414d53-554e-4700-0000-000000000000': 'samsung',
  '531126d6-e717-415c-9320-3d9aa6981239': 'dashlane',
}

export type PasskeyInfo = {
  id: string
  createdAt: number
  lastUsedAt: number | null
  provider: PasskeyProvider | null
  /** Synced to the person's other devices (the authenticator's backup state) */
  backedUp: boolean
}

export type SessionInfo = {
  id: string
  createdAt: number
  lastSeenAt: number
  /** The browser asking */
  current: boolean
}

/** A persistent room as /me lists it: its settings live in the room (RoomDO) */
export type PersistentRoomInfo = {
  slug: string
  createdAt: number
  name: string | null
  waitingRoom: boolean
  locked: boolean
  /** Whether it has a password (the password itself never leaves the room) */
  password: boolean
  /** Who is in it now (0 between meetings) */
  memberCount: number
}

/** GET /api/account: everything /me shows */
export type MeResponse = {
  account: AccountInfo
  passkeys: PasskeyInfo[]
  sessions: SessionInfo[]
  rooms: PersistentRoomInfo[]
  /** Scheduled meetings (I3), soonest first; past ones until MEETING_RETENTION_MS */
  meetings: MeetingInfo[]
}

/** PATCH /api/account/rooms/<slug>: what to change; `password` null clears it */
export type RoomSettingsChange = {
  name?: string | null
  waitingRoom?: boolean
  locked?: boolean
  password?: string | null
}

/** What GET /api/rooms/<id> adds for a signed-in browser: its name, and whether it owns the room */
export type RoomViewer = { name: string; owner: boolean }

/**
 * Why an account call failed (the `error` of the JSON answer; the /me page's text for each is in
 * the dictionaries). `slug_invalid` comes with `problem` (shared/slug.ts SlugProblem), and so does
 * `meeting_invalid` (shared/meeting.ts MeetingProblem);
 * `rate_limited` with `retryAfter` seconds; `turnstile_required` with `siteKey`.
 */
export type AccountError =
  | 'signed_out'
  | 'forbidden_origin'
  | 'bad_request'
  | 'rate_limited'
  | 'blocked'
  | 'turnstile_required'
  | 'turnstile_failed'
  | 'challenge_expired'
  | 'verification_failed'
  | 'unknown_passkey'
  | 'passkey_exists'
  | 'too_many_passkeys'
  | 'last_passkey'
  | 'slug_invalid'
  | 'slug_taken'
  | 'too_many_rooms'
  | 'meeting_invalid'
  | 'too_many_meetings'
  | 'not_found'
  | 'unavailable'

