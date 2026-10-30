import type { CreateRoomResponse } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'

/** POST /api/rooms: a new room's id. Throws when the server does not answer with one. */
export async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/rooms: ${res.status}`)
  const body = (await res.json()) as Partial<CreateRoomResponse>
  if (!isRoomId(body.id)) throw new Error('POST /api/rooms: no room id')
  return body.id
}
