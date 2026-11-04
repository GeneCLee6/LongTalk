import { TURNSTILE_HEADER, type CreateRoomRefusal } from '../shared/abuse.ts'
import type { RoomViewer } from '../shared/account.ts'
import { isRoomId, newRoomId } from '../shared/room-id.ts'
import { isRoomKey } from '../shared/slug.ts'
import type { CreateRoomResponse } from '../shared/protocol.ts'
import { AccountDb } from './account-db.ts'
import { isBlocked, takeIsolateRate, type GuardDeps } from './abuse.ts'
import type { Env } from './app.ts'
import { requestClientKey } from './client-key.ts'
import { ACCOUNT_HEADER, authenticate } from './session.ts'
import { turnstileSiteKey, verifyTurnstile } from './turnstile.ts'

/** Tries this many fresh ids before giving up (a collision at ~59 bits is not expected at all) */
const CREATE_ATTEMPTS = 3

const ROOM_PATH = /^\/api\/rooms\/([^/]+)(\/ws)?$/

const noStore = { 'cache-control': 'no-store' }

export interface RoomsDeps {
  guard: GuardDeps
  /** Keeps a promise running after the answer (ExecutionContext.waitUntil) */
  waitUntil(promise: Promise<unknown>): void
  /** siteverify goes through this (tests pass a fake) */
  fetch?: typeof fetch
}

/**
 * /api/rooms/*: POST /api/rooms creates a room and answers its id; GET /api/rooms/<id> answers
 * its RoomSummary (pre-join screen); GET /api/rooms/<id>/ws is the room's WebSocket, handed to
 * its RoomDO (protocol in shared/protocol.ts). `<id>` is a random id or a persistent room's slug
 * (I2, shared/slug.ts). For a signed-in browser (I2) the summary says who it is (`viewer`: its
 * account's name, and whether it owns the room), and a persistent room's upgrade carries the
 * account to the room in ACCOUNT_HEADER (its owner is the host there).
 *
 * Abuse protection first (I1, e11-t05): a blocked network gets 403 `blocked` on every one of
 * these; the lookups and upgrades have a per-isolate rate (429); creating a room may need a
 * Turnstile token and is counted per network worldwide by GuardDO. Nothing is limited without a
 * client address (local development).
 */
export async function handleRooms(
  request: Request,
  env: Env,
  url: URL,
  deps: RoomsDeps,
): Promise<Response> {
  const key = await requestClientKey(request, env)
  if (key && (await isBlocked(key, deps.guard))) return refuse({ error: 'blocked' }, 403)
  if (url.pathname === '/api/rooms') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return createRoom(request, env, key, deps)
  }
  if (key && !takeIsolateRate(key)) {
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { ...noStore, 'retry-after': '10' } },
    )
  }
  const match = ROOM_PATH.exec(url.pathname)
  if (!match || !isRoomKey(match[1])) return notFound()
  const roomId = match[1]
  if (!match[2]) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const signedIn = await signedInAccount(request, env, true)
    const found = await roomStub(env, roomId).summary(signedIn?.account.id ?? null)
    if (!found) return notFound()
    const { owner, ...summary } = found
    const viewer: RoomViewer | null = signedIn ? { name: signedIn.account.name, owner } : null
    const headers: Record<string, string> = { ...noStore }
    if (signedIn?.setCookie) headers['set-cookie'] = signedIn.setCookie
    return Response.json({ ...summary, viewer }, { headers })
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return Response.json({ error: 'expected_websocket' }, { status: 426 })
  }
  // Cross-site WebSocket hijacking: browsers always send Origin on a WebSocket, and a page on
  // another site must not open a socket that acts as its visitor. Non-browser clients (no Origin)
  // could forge any header anyway, so they are let through.
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 })
  }
  // The account goes to the room only as the Worker checked it: whatever a client sent is dropped.
  // Only a persistent room has an owner to recognise, so only its upgrades look the session up
  const headers = new Headers(request.headers)
  headers.delete(ACCOUNT_HEADER)
  if (!isRoomId(roomId)) {
    const signedIn = await signedInAccount(request, env, false)
    if (signedIn) headers.set(ACCOUNT_HEADER, signedIn.account.id)
  }
  return roomStub(env, roomId).fetch(new Request(request, { headers }))
}

/**
 * The signed-in account on this request (I2), or null (no cookie, no D1 binding, or D1 out of
 * reach: a room never fails because accounts do)
 */
async function signedInAccount(request: Request, env: Env, rotate: boolean) {
  if (!env.DB || !request.headers.has('Cookie')) return null
  try {
    return await authenticate(new AccountDb(env.DB), request, Date.now(), { rotate })
  } catch (error) {
    console.error('session lookup failed', error)
    return null
  }
}

/**
 * POST /api/rooms: Turnstile when it is on (403 `turnstile_required` with the site key when the
 * request has no token, 403 `turnstile_failed` when siteverify says no), then GuardDO's creation
 * limit (429 `rate_limited` with the seconds to wait), then the room.
 */
async function createRoom(
  request: Request,
  env: Env,
  key: string | null,
  deps: RoomsDeps,
): Promise<Response> {
  const siteKey = turnstileSiteKey(env)
  if (siteKey) {
    const token = request.headers.get(TURNSTILE_HEADER)
    if (!token) return refuse({ error: 'turnstile_required', siteKey }, 403)
    const ip = request.headers.get('CF-Connecting-IP')
    if (!(await verifyTurnstile(env, token, ip, deps.fetch))) {
      if (key) deps.waitUntil(deps.guard.note(key, 'turnstile').catch(() => {}))
      return refuse({ error: 'turnstile_failed' }, 403)
    }
  }
  if (key) {
    // GuardDO out of reach lets the room through: Turnstile and the room limits still stand
    const decision = await deps.guard.create(key).catch((error: unknown) => {
      console.error('guard create failed', error)
      return { ok: true } as const
    })
    if (!decision.ok) {
      const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      return refuse({ error: 'rate_limited', retryAfter }, 429, {
        'retry-after': String(retryAfter),
      })
    }
  }
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const id = newRoomId()
    if (await roomStub(env, id).create(id)) {
      const body: CreateRoomResponse = { id }
      return Response.json(body, { status: 201, headers: noStore })
    }
  }
  return Response.json({ error: 'unavailable' }, { status: 503 })
}

function roomStub(env: Env, roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId))
}

function refuse(
  body: CreateRoomRefusal,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...noStore, ...headers } })
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404 })
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow } })
}
