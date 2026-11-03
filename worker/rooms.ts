import { TURNSTILE_HEADER, type CreateRoomRefusal } from '../shared/abuse.ts'
import { isRoomId, newRoomId } from '../shared/room-id.ts'
import type { CreateRoomResponse } from '../shared/protocol.ts'
import { isBlocked, takeIsolateRate, type GuardDeps } from './abuse.ts'
import type { Env } from './app.ts'
import { requestClientKey } from './client-key.ts'
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
 * its RoomDO (protocol in shared/protocol.ts).
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
  if (!match || !isRoomId(match[1])) return notFound()
  const roomId = match[1]
  if (!match[2]) {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const summary = await roomStub(env, roomId).summary()
    return summary ? Response.json(summary, { headers: noStore }) : notFound()
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
  return roomStub(env, roomId).fetch(request)
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
