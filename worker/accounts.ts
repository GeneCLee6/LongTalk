import {
  ACCOUNT_API,
  CHALLENGE_TTL_MS,
  MAX_PASSKEYS,
  MAX_PERSISTENT_ROOMS,
  PASSKEY_PROVIDERS,
  type AccountError,
  type AccountInfo,
  type MeResponse,
  type PasskeyInfo,
  type PersistentRoomInfo,
  type RoomSettingsChange,
} from '../shared/account.ts'
import { TURNSTILE_HEADER, type LimitKind } from '../shared/abuse.ts'
import { MAX_MEETINGS, isMeetingId, parseMeetingInput, type MeetingInput } from '../shared/meeting.ts'
import { normalizePassword } from '../shared/password.ts'
import { MAX_ROOM_NAME_CHARS, normalizeName } from '../shared/protocol.ts'
import { normalizeSlug, slugProblem } from '../shared/slug.ts'
import { isBlocked, takeIsolateRate, type GuardDeps } from './abuse.ts'
import { AccountDb, type AccountRow, type CredentialRow, type MeetingValues } from './account-db.ts'
import type { Env } from './app.ts'
import { requestClientKey } from './client-key.ts'
import { keptAfter, meetingInfo } from './meetings.ts'
import type { RoomDO } from './room.ts'
import {
  authenticate,
  clearSessionCookie,
  newId,
  sessionCookie,
  startSession,
  type Authenticated,
} from './session.ts'
import { turnstileSiteKey, verifyTurnstile } from './turnstile.ts'
import {
  answeredChallenge,
  creationOptions,
  newChallenge,
  parseAuthentication,
  parseRegistration,
  requestOptions,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from './webauthn.ts'

// /api/account/* (I2, e1-t12, e1-t13): passkey sign-up and sign-in, the /me page's data and
// actions, personal persistent rooms. Every rule is here, on the server (CLAUDE.md rule 1); the
// /me page only shows what this answers.
//
//   GET    /api/account                    everything /me shows (401 signed_out)
//   PATCH  /api/account                    { name }
//   DELETE /api/account                    the account and everything it has, rooms included
//   POST   /api/account/register/options   { name } → creation options (Turnstile when it is on)
//   POST   /api/account/register           { credential } → a new account, signed in
//   POST   /api/account/login/options      → request options (discoverable: no user name)
//   POST   /api/account/login              { credential } → signed in
//   POST   /api/account/logout
//   POST   /api/account/passkeys/options   → creation options for one more passkey
//   POST   /api/account/passkeys           { credential }
//   DELETE /api/account/passkeys/<id>      (never the last one)
//   DELETE /api/account/sessions/<id>      signs one browser out
//   DELETE /api/account/sessions           signs every other browser out
//   POST   /api/account/rooms              { slug, name? } → a persistent room
//   PATCH  /api/account/rooms/<slug>       RoomSettingsChange
//   DELETE /api/account/rooms/<slug>      (its scheduled meetings with it)
//   POST   /api/account/meetings          MeetingInput → a scheduled meeting (I3, e1-t14)
//   PUT    /api/account/meetings/<id>     MeetingInput: the whole meeting again
//   DELETE /api/account/meetings/<id>
//   (the public page's GET /api/meetings/<id> is worker/meetings.ts)
//
// CSRF: the session cookie is SameSite=Lax, and every call but GET must come with an Origin
// header equal to this site's (a page elsewhere, even a preview on the same workers.dev site,
// gets 403 forbidden_origin) and a JSON body type, which a cross-site form cannot send. Abuse:
// blocked networks get 403; every call counts against the per-isolate rate; account creation and
// sign-in are counted per network in GuardDO (shared/abuse.ts LIMITS), and so are meetings saved.

/** What the account API needs besides the bindings (fakes in tests) */
export interface AccountDeps {
  guard: GuardDeps
  /** A persistent room's Durable Object, by slug */
  room(slug: string): Pick<
    DurableObjectStub<RoomDO>,
    'createPersistent' | 'settings' | 'updateSettings' | 'destroy'
  >
  now?: () => number
  /** siteverify goes through this (tests pass a fake) */
  fetch?: typeof fetch
}

/** JSON bodies are small: a passkey answer is a few kilobytes */
const MAX_BODY_BYTES = 16_384

const noStore = { 'cache-control': 'no-store' }

class Reply {
  readonly status: number
  readonly body: unknown
  readonly cookie: string | null
  readonly headers: Record<string, string>

  constructor(status: number, body: unknown, cookie: string | null = null, headers = {}) {
    this.status = status
    this.body = body
    this.cookie = cookie
    this.headers = headers
  }
}

const fail = (status: number, error: AccountError, extra: Record<string, unknown> = {}) =>
  new Reply(status, { error, ...extra })

type Context = {
  request: Request
  env: Env
  url: URL
  deps: AccountDeps
  db: AccountDb
  now: number
  key: string | null
  /** The signed-in account, once `signedIn` found it */
  auth: Authenticated | null
}

export async function handleAccount(
  request: Request,
  env: Env,
  url: URL,
  deps: AccountDeps,
): Promise<Response> {
  if (!env.DB) return toResponse(fail(503, 'unavailable'))
  const now = (deps.now ?? Date.now)()
  const key = await requestClientKey(request, env)
  if (key && (await isBlocked(key, deps.guard))) return toResponse(fail(403, 'blocked'))
  if (key && !takeIsolateRate(key, now)) {
    return toResponse(new Reply(429, { error: 'rate_limited', retryAfter: 10 }, null, { 'retry-after': '10' }))
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin')
    if (origin === null || origin !== url.origin) return toResponse(fail(403, 'forbidden_origin'))
    const type = request.headers.get('Content-Type') ?? ''
    if (request.method !== 'DELETE' && !/^application\/json\b/i.test(type)) {
      return toResponse(fail(415, 'bad_request'))
    }
  }
  const context: Context = { request, env, url, deps, db: new AccountDb(env.DB), now, key, auth: null }
  let reply: Reply
  try {
    reply = await route(context)
  } catch (error) {
    console.error('account API failed', error)
    reply = fail(503, 'unavailable')
  }
  // A session rotated on the way (worker/session.ts): the new cookie goes with whatever answer
  const cookie = reply.cookie ?? context.auth?.setCookie ?? null
  return toResponse(cookie === reply.cookie ? reply : new Reply(reply.status, reply.body, cookie, reply.headers))
}

function toResponse(reply: Reply): Response {
  const headers = new Headers({ ...noStore, ...reply.headers })
  if (reply.cookie) headers.append('set-cookie', reply.cookie)
  if (reply.status === 204) return new Response(null, { status: 204, headers })
  return Response.json(reply.body, { status: reply.status, headers })
}

async function route(c: Context): Promise<Reply> {
  const path = c.url.pathname.slice(ACCOUNT_API.length)
  const method = c.request.method
  const sub = path === '/passkeys/options' ? null : /^\/(passkeys|sessions|rooms|meetings)\/([^/]+)$/.exec(path)
  switch (`${method} ${sub ? `/${sub[1]}/:id` : path}`) {
    case 'GET ':
      return withAccount(c, () => me(c))
    case 'PATCH ':
      return withAccount(c, () => rename(c))
    case 'DELETE ':
      return withAccount(c, () => deleteAccount(c))
    case 'POST /register/options':
      return registerOptions(c)
    case 'POST /register':
      return register(c)
    case 'POST /login/options':
      return loginOptions(c)
    case 'POST /login':
      return login(c)
    case 'POST /logout':
      return logout(c)
    case 'POST /passkeys/options':
      return withAccount(c, () => passkeyOptions(c))
    case 'POST /passkeys':
      return withAccount(c, () => addPasskey(c))
    case 'DELETE /passkeys/:id':
      return withAccount(c, () => removePasskey(c, decodeURIComponent(sub![2])))
    case 'DELETE /sessions/:id':
      return withAccount(c, () => removeSession(c, decodeURIComponent(sub![2])))
    case 'DELETE /sessions':
      return withAccount(c, () => removeOtherSessions(c))
    case 'POST /rooms':
      return withAccount(c, () => createRoom(c))
    case 'PATCH /rooms/:id':
      return withAccount(c, () => updateRoom(c, sub![2]))
    case 'DELETE /rooms/:id':
      return withAccount(c, () => deleteRoom(c, sub![2]))
    case 'POST /meetings':
      return withAccount(c, () => createMeeting(c))
    case 'PUT /meetings/:id':
      return withAccount(c, () => updateMeeting(c, sub![2]))
    case 'DELETE /meetings/:id':
      return withAccount(c, () => deleteMeeting(c, sub![2]))
    default:
      return fail(404, 'not_found')
  }
}

/** Runs `action` for a signed-in browser; 401 signed_out otherwise */
async function withAccount(c: Context, action: () => Promise<Reply>): Promise<Reply> {
  c.auth = await authenticate(c.db, c.request, c.now, { rotate: true })
  if (!c.auth) return new Reply(401, { error: 'signed_out' }, clearSessionCookie())
  return action()
}

const account = (c: Context): AccountRow => c.auth!.account

async function body(c: Context): Promise<Record<string, unknown> | null> {
  const length = Number(c.request.headers.get('Content-Length') ?? '0')
  if (length > MAX_BODY_BYTES) return null
  try {
    const text = await c.request.text()
    if (text.length > MAX_BODY_BYTES) return null
    const value: unknown = text === '' ? {} : JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The relying party is this site: its host name and origin (each preview is its own) */
function expected(c: Context, challenge: string): Expected {
  return { challenge, origin: c.url.origin, rpId: c.url.hostname }
}

/** GuardDO's count for `kind` from this network; a refusal, or null to go on */
async function limited(c: Context, kind: LimitKind): Promise<Reply | null> {
  if (!c.key) return null
  // GuardDO out of reach lets the call through: the isolate rate still stands
  const decision = await c.deps.guard.limit(kind, c.key).catch((error: unknown) => {
    console.error('guard limit failed', error)
    return { ok: true } as const
  })
  if (decision.ok) return null
  const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
  return new Reply(429, { error: 'rate_limited', retryAfter }, null, {
    'retry-after': String(retryAfter),
  })
}

function accountInfo(row: AccountRow): AccountInfo {
  return { id: row.id, name: row.name, createdAt: row.created_at }
}

function passkeyInfo(row: CredentialRow): PasskeyInfo {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    provider: (row.aaguid && PASSKEY_PROVIDERS[row.aaguid]) || null,
    backedUp: row.backed_up === 1,
  }
}

function transports(row: CredentialRow): string[] {
  try {
    const value: unknown = JSON.parse(row.transports ?? '[]')
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// Sign-up

async function registerOptions(c: Context): Promise<Reply> {
  const input = await body(c)
  const name = normalizeName(input?.name)
  if (!name) return fail(400, 'bad_request')
  // Turnstile when it is on (I1): making an account is as open as making a room
  const siteKey = turnstileSiteKey(c.env)
  if (siteKey) {
    const token = c.request.headers.get(TURNSTILE_HEADER)
    if (!token) return fail(403, 'turnstile_required', { siteKey })
    const ip = c.request.headers.get('CF-Connecting-IP')
    if (!(await verifyTurnstile(c.env, token, ip, c.deps.fetch))) {
      return fail(403, 'turnstile_failed')
    }
  }
  const refused = await limited(c, 'register')
  if (refused) return refused
  const challenge = newChallenge()
  const accountId = newId()
  await c.db.putChallenge(
    { challenge, kind: 'register', account_id: accountId, name, expires_at: c.now + CHALLENGE_TTL_MS },
    c.now,
  )
  const options = creationOptions({
    rpId: c.url.hostname,
    challenge,
    user: { id: accountId, name },
    exclude: [],
  })
  return new Reply(200, { options })
}

async function register(c: Context): Promise<Reply> {
  const input = await body(c)
  const credential = parseRegistration(input?.credential)
  if (!credential) return fail(400, 'bad_request')
  const challenge = answeredChallenge(credential.response.clientDataJSON)
  const issued = challenge && (await c.db.takeChallenge(challenge, 'register', c.now))
  if (!challenge || !issued || !issued.account_id || !issued.name) {
    return fail(400, 'challenge_expired')
  }
  let verified
  try {
    verified = await verifyRegistration(credential, expected(c, challenge))
  } catch (error) {
    return refusedCredential(error)
  }
  if (await c.db.credential(verified.id)) return fail(409, 'passkey_exists')
  const row: AccountRow = { id: issued.account_id, name: issued.name, created_at: c.now }
  const { token, session } = await startSession(c.now)
  await c.db.createAccount(row, verified, session)
  return new Reply(201, { account: accountInfo(row) }, sessionCookie(token, session.expiresAt, c.now))
}

function refusedCredential(error: unknown): Reply {
  if (!(error instanceof WebAuthnError)) throw error
  console.warn('passkey refused:', error.message)
  return fail(400, 'verification_failed')
}

// Sign-in

async function loginOptions(c: Context): Promise<Reply> {
  const refused = await limited(c, 'signin')
  if (refused) return refused
  const challenge = newChallenge()
  await c.db.putChallenge(
    { challenge, kind: 'login', account_id: null, name: null, expires_at: c.now + CHALLENGE_TTL_MS },
    c.now,
  )
  return new Reply(200, { options: requestOptions({ rpId: c.url.hostname, challenge }) })
}

async function login(c: Context): Promise<Reply> {
  const input = await body(c)
  const credential = parseAuthentication(input?.credential)
  if (!credential) return fail(400, 'bad_request')
  const challenge = answeredChallenge(credential.response.clientDataJSON)
  const issued = challenge && (await c.db.takeChallenge(challenge, 'login', c.now))
  if (!challenge || !issued) return fail(400, 'challenge_expired')
  const stored = await c.db.credential(credential.id)
  // A passkey this site no longer knows (deleted here, still in the password manager)
  if (!stored) return fail(400, 'unknown_passkey', { credentialId: credential.id })
  const handle = credential.response.userHandle
  if (handle !== null && handle !== stored.account_id) return fail(400, 'verification_failed')
  let result
  try {
    result = await verifyAuthentication(credential, expected(c, challenge), {
      publicKey: stored.public_key,
      alg: stored.alg,
      signCount: stored.sign_count,
    })
  } catch (error) {
    return refusedCredential(error)
  }
  const row = await c.db.account(stored.account_id)
  if (!row) return fail(400, 'unknown_passkey', { credentialId: credential.id })
  await c.db.useCredential(stored.id, result.signCount, result.backedUp, c.now)
  // Always a new session (never the one a cookie may already name: no session fixation)
  const { token, session } = await startSession(c.now)
  await c.db.createSession(row.id, session, c.now)
  return new Reply(200, { account: accountInfo(row) }, sessionCookie(token, session.expiresAt, c.now))
}

async function logout(c: Context): Promise<Reply> {
  const auth = await authenticate(c.db, c.request, c.now, { rotate: false })
  if (auth) await c.db.deleteSession(auth.account.id, auth.session.id)
  return new Reply(204, null, clearSessionCookie())
}

// The account

async function me(c: Context): Promise<Reply> {
  const { id } = account(c)
  const [credentials, sessions, rooms, meetings] = await Promise.all([
    c.db.credentials(id),
    c.db.sessions(id, c.now),
    c.db.rooms(id),
    // A database 0002 was not applied to yet (DEPLOY.md §4) still shows the rest of /me
    c.db.meetings(id, keptAfter(c.now)).catch((error: unknown) => {
      console.error('meetings unavailable', error)
      return []
    }),
  ])
  const roomInfos = await Promise.all(
    rooms.map(async (room): Promise<PersistentRoomInfo> => {
      const settings = await c.deps
        .room(room.slug)
        .settings()
        .catch(() => null)
      return {
        slug: room.slug,
        createdAt: room.created_at,
        name: settings?.name ?? null,
        waitingRoom: settings?.waitingRoom ?? false,
        locked: settings?.locked ?? false,
        password: settings?.password ?? false,
        memberCount: settings?.memberCount ?? 0,
      }
    }),
  )
  const response: MeResponse = {
    account: accountInfo(account(c)),
    passkeys: credentials.map(passkeyInfo),
    sessions: sessions.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      current: row.id === c.auth!.session.id,
    })),
    rooms: roomInfos,
    meetings: meetings.map(meetingInfo),
  }
  return new Reply(200, response)
}

async function rename(c: Context): Promise<Reply> {
  const name = normalizeName((await body(c))?.name)
  if (!name) return fail(400, 'bad_request')
  await c.db.renameAccount(account(c).id, name)
  return new Reply(200, { account: accountInfo({ ...account(c), name }) })
}

/**
 * Deletes everything the account has (e11 「帳號資料」): its rooms first (their own storage, and
 * anyone in one is sent away), then every row; the browser is signed out
 */
async function deleteAccount(c: Context): Promise<Reply> {
  const { id } = account(c)
  for (const room of await c.db.rooms(id)) await c.deps.room(room.slug).destroy()
  await c.db.deleteAccount(id)
  return new Reply(204, null, clearSessionCookie())
}

// Passkeys

async function passkeyOptions(c: Context): Promise<Reply> {
  const row = account(c)
  const existing = await c.db.credentials(row.id)
  if (existing.length >= MAX_PASSKEYS) return fail(409, 'too_many_passkeys')
  const challenge = newChallenge()
  await c.db.putChallenge(
    { challenge, kind: 'add', account_id: row.id, name: null, expires_at: c.now + CHALLENGE_TTL_MS },
    c.now,
  )
  const options = creationOptions({
    rpId: c.url.hostname,
    challenge,
    user: { id: row.id, name: row.name },
    // The authenticator says so when it already holds one of these: no second passkey there
    exclude: existing.map((credential) => ({ id: credential.id, transports: transports(credential) })),
  })
  return new Reply(200, { options })
}

async function addPasskey(c: Context): Promise<Reply> {
  const row = account(c)
  const credential = parseRegistration((await body(c))?.credential)
  if (!credential) return fail(400, 'bad_request')
  const challenge = answeredChallenge(credential.response.clientDataJSON)
  const issued = challenge && (await c.db.takeChallenge(challenge, 'add', c.now))
  // The challenge was this account's own
  if (!challenge || !issued || issued.account_id !== row.id) return fail(400, 'challenge_expired')
  let verified
  try {
    verified = await verifyRegistration(credential, expected(c, challenge))
  } catch (error) {
    return refusedCredential(error)
  }
  if (await c.db.credential(verified.id)) return fail(409, 'passkey_exists')
  if ((await c.db.credentials(row.id)).length >= MAX_PASSKEYS) return fail(409, 'too_many_passkeys')
  await c.db.addCredential(row.id, verified, c.now)
  return new Reply(201, { passkey: passkeyInfo((await c.db.credential(verified.id))!) })
}

async function removePasskey(c: Context, id: string): Promise<Reply> {
  const row = account(c)
  const credentials = await c.db.credentials(row.id)
  if (!credentials.some((credential) => credential.id === id)) return fail(404, 'not_found')
  // The last passkey is the only way in: delete the account instead
  if (credentials.length <= 1) return fail(409, 'last_passkey')
  await c.db.deleteCredential(row.id, id)
  return new Reply(204, null)
}

// Sessions

async function removeSession(c: Context, id: string): Promise<Reply> {
  const current = c.auth!.session.id === id
  if (!(await c.db.deleteSession(account(c).id, id))) return fail(404, 'not_found')
  return new Reply(204, null, current ? clearSessionCookie() : null)
}

async function removeOtherSessions(c: Context): Promise<Reply> {
  const count = await c.db.deleteOtherSessions(account(c).id, c.auth!.session.id)
  return new Reply(200, { signedOut: count })
}

// Persistent rooms (e1-t13)

async function ownRoom(c: Context, raw: string): Promise<string | null> {
  const slug = normalizeSlug(decodeURIComponent(raw))
  if (slugProblem(slug) !== null) return null
  const row = await c.db.room(slug)
  return row && row.account_id === account(c).id ? slug : null
}

async function createRoom(c: Context): Promise<Reply> {
  const input = await body(c)
  if (!input || typeof input.slug !== 'string') return fail(400, 'bad_request')
  const slug = normalizeSlug(input.slug)
  const problem = slugProblem(slug)
  if (problem) return fail(400, 'slug_invalid', { problem })
  let name: string | null = null
  if (input.name !== undefined && input.name !== null && input.name !== '') {
    name = normalizeName(input.name, MAX_ROOM_NAME_CHARS)
    if (!name) return fail(400, 'bad_request')
  }
  const row = account(c)
  if ((await c.db.rooms(row.id)).length >= MAX_PERSISTENT_ROOMS) return fail(409, 'too_many_rooms')
  if (await c.db.room(slug)) return fail(409, 'slug_taken')
  // A persistent room counts as a room made (I1's limit per network)
  const refused = await limited(c, 'create')
  if (refused) return refused
  if (!(await c.db.addRoom(slug, row.id, c.now))) return fail(409, 'slug_taken')
  const created = await c.deps
    .room(slug)
    .createPersistent({ slug, owner: row.id, createdAt: c.now }, name)
    .catch((error: unknown) => {
      console.error('createPersistent failed', error)
      return null
    })
  if (created !== true) {
    await c.db.deleteRoom(slug, row.id)
    return created === false ? fail(409, 'slug_taken') : fail(503, 'unavailable')
  }
  const room: PersistentRoomInfo = {
    slug,
    createdAt: c.now,
    name,
    waitingRoom: false,
    locked: false,
    password: false,
    memberCount: 0,
  }
  return new Reply(201, { room })
}

/** The change in a PATCH body, every value checked; null when anything is wrong */
function settingsChange(input: Record<string, unknown> | null): RoomSettingsChange | null {
  if (!input) return null
  const change: RoomSettingsChange = {}
  if ('name' in input) {
    if (input.name === null || input.name === '') change.name = null
    else {
      const name = normalizeName(input.name, MAX_ROOM_NAME_CHARS)
      if (!name) return null
      change.name = name
    }
  }
  for (const key of ['waitingRoom', 'locked'] as const) {
    if (!(key in input)) continue
    if (typeof input[key] !== 'boolean') return null
    change[key] = input[key]
  }
  if ('password' in input) {
    if (input.password === null) change.password = null
    else {
      const password = normalizePassword(input.password)
      if (!password) return null
      change.password = password
    }
  }
  return Object.keys(change).length > 0 ? change : null
}

async function updateRoom(c: Context, raw: string): Promise<Reply> {
  const slug = await ownRoom(c, raw)
  if (!slug) return fail(404, 'not_found')
  const change = settingsChange(await body(c))
  if (!change) return fail(400, 'bad_request')
  const settings = await c.deps.room(slug).updateSettings(change)
  if (!settings) return fail(404, 'not_found')
  const row = await c.db.room(slug)
  const room: PersistentRoomInfo = { slug, createdAt: row?.created_at ?? c.now, ...settings }
  return new Reply(200, { room })
}

async function deleteRoom(c: Context, raw: string): Promise<Reply> {
  const slug = await ownRoom(c, raw)
  if (!slug) return fail(404, 'not_found')
  // The room's own storage first: if the row went first and this failed, the settings would stay
  // behind under a slug anyone could take. Its scheduled meetings go with the row
  await c.deps.room(slug).destroy()
  await c.db.deleteRoom(slug, account(c).id)
  return new Reply(204, null)
}

// Scheduled meetings (I3, e1-t14)

/**
 * The meeting in the body, checked (shared/meeting.ts), in one of this account's persistent
 * rooms; a refusal otherwise
 */
async function meetingInput(c: Context, keepStart: number | null): Promise<MeetingInput | Reply> {
  const parsed = parseMeetingInput(await body(c), c.now, keepStart)
  if ('problem' in parsed) return fail(400, 'meeting_invalid', { problem: parsed.problem })
  const room = await c.db.room(parsed.input.roomSlug)
  if (!room || room.account_id !== account(c).id) {
    return fail(400, 'meeting_invalid', { problem: 'room' })
  }
  return parsed.input
}

const meetingValues = (input: MeetingInput): MeetingValues => ({
  room_slug: input.roomSlug,
  title: input.title,
  description: input.description,
  starts_at: input.startsAt,
  duration_min: input.durationMin,
  time_zone: input.timeZone,
})

async function createMeeting(c: Context): Promise<Reply> {
  const input = await meetingInput(c, null)
  if (input instanceof Reply) return input
  const { id: accountId } = account(c)
  if ((await c.db.meetingCount(accountId, keptAfter(c.now))) >= MAX_MEETINGS) {
    return fail(409, 'too_many_meetings')
  }
  const refused = await limited(c, 'meeting')
  if (refused) return refused
  const values = meetingValues(input)
  const row = {
    id: newId(),
    account_id: accountId,
    ...values,
    ends_at: values.starts_at + values.duration_min * 60_000,
    sequence: 0,
    created_at: c.now,
    updated_at: c.now,
  }
  await c.db.addMeeting(row, keptAfter(c.now))
  return new Reply(201, { meeting: meetingInfo(row) })
}

/** The account's own meeting by the id in the path; null for anyone else's, or none */
async function ownMeeting(c: Context, raw: string) {
  const id = decodeURIComponent(raw)
  if (!isMeetingId(id)) return null
  const row = await c.db.meeting(id, keptAfter(c.now))
  return row && row.account_id === account(c).id ? row : null
}

async function updateMeeting(c: Context, raw: string): Promise<Reply> {
  // Someone else's meeting is as missing as one that never was (404, never 403)
  const row = await ownMeeting(c, raw)
  if (!row) return fail(404, 'not_found')
  const input = await meetingInput(c, row.starts_at)
  if (input instanceof Reply) return input
  const refused = await limited(c, 'meeting')
  if (refused) return refused
  if (!(await c.db.updateMeeting(row.id, row.account_id, meetingValues(input), c.now))) {
    return fail(404, 'not_found')
  }
  const saved = await c.db.meeting(row.id, keptAfter(c.now))
  return saved ? new Reply(200, { meeting: meetingInfo(saved) }) : fail(404, 'not_found')
}

async function deleteMeeting(c: Context, raw: string): Promise<Reply> {
  const row = await ownMeeting(c, raw)
  if (!row || !(await c.db.deleteMeeting(row.id, row.account_id))) return fail(404, 'not_found')
  return new Reply(204, null)
}
