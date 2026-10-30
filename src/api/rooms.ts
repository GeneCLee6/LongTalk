import { roomInfoPath, type CreateRoomResponse, type RoomSummary } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'

/** POST /api/rooms: a new room's id. Throws when the server does not answer with one. */
export async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/rooms: ${res.status}`)
  const body = (await res.json()) as Partial<CreateRoomResponse>
  if (!isRoomId(body.id)) throw new Error('POST /api/rooms: no room id')
  return body.id
}

/** GET /api/rooms/<id>: the room, or null when there is no such room. Throws on other failures. */
export async function getRoom(roomId: string): Promise<RoomSummary | null> {
  const res = await fetch(roomInfoPath(roomId))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${roomInfoPath(roomId)}: ${res.status}`)
  const body = (await res.json()) as Partial<RoomSummary>
  if (body.id !== roomId || typeof body.memberCount !== 'number') {
    throw new Error(`GET ${roomInfoPath(roomId)}: unexpected body`)
  }
  return body as RoomSummary
}
