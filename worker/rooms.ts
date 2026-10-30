import { isRoomId, newRoomId } from '../shared/room-id.ts'
import type { CreateRoomResponse } from '../shared/protocol.ts'
import type { Env } from './app.ts'

/** Tries this many fresh ids before giving up (a collision at ~59 bits is not expected at all) */
const CREATE_ATTEMPTS = 3

const SOCKET_PATH = /^\/api\/rooms\/([^/]+)\/ws$/

/**
 * /api/rooms/*: POST /api/rooms creates a room and answers its id; GET /api/rooms/<id>/ws is the
 * room's WebSocket, handed to its RoomDO (protocol in shared/protocol.ts).
 */
export async function handleRooms(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/rooms') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    return createRoom(env)
  }
  const socket = SOCKET_PATH.exec(url.pathname)
  if (socket) {
    const roomId = socket[1]
    if (!isRoomId(roomId)) return Response.json({ error: 'not_found' }, { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ error: 'expected_websocket' }, { status: 426 })
    }
    return roomStub(env, roomId).fetch(request)
  }
  return Response.json({ error: 'not_found' }, { status: 404 })
}

async function createRoom(env: Env): Promise<Response> {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const id = newRoomId()
    if (await roomStub(env, id).create(id)) {
      const body: CreateRoomResponse = { id }
      return Response.json(body, { status: 201, headers: { 'cache-control': 'no-store' } })
    }
  }
  return Response.json({ error: 'unavailable' }, { status: 503 })
}

function roomStub(env: Env, roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId))
}

function methodNotAllowed(allow: string): Response {
  return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow } })
}
