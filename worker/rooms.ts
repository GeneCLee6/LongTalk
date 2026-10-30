import { isRoomId, newRoomId } from '../shared/room-id.ts'
import type { CreateRoomResponse } from '../shared/protocol.ts'
import type { Env } from './app.ts'

/** Tries this many fresh ids before giving up (a collision at ~59 bits is not expected at all) */
const CREATE_ATTEMPTS = 3

const ROOM_PATH = /^\/api\/rooms\/([^/]+)(\/ws)?$/

const noStore = { 'cache-control': 'no-store' }

/**
 * /api/rooms/*: POST /api/rooms creates a room and answers its id; GET /api/rooms/<id> answers
 * its RoomSummary (pre-join screen); GET /api/rooms/<id>/ws is the room's WebSocket, handed to
 * its RoomDO (protocol in shared/protocol.ts).
 */
export async function handleRooms(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/rooms') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return createRoom(env)
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

async function createRoom(env: Env): Promise<Response> {
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

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404 })
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow } })
}
