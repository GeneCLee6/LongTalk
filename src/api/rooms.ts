import { TURNSTILE_HEADER, type CreateRoomRefusal } from '../../shared/abuse.ts'
import type { RoomViewer } from '../../shared/account.ts'
import { roomInfoPath, type CreateRoomResponse, type RoomSummary } from '../../shared/protocol.ts'
import { isRoomId } from '../../shared/room-id.ts'

/**
 * Why POST /api/rooms gave no room (I1, e11-t05): it wants a Turnstile token (`siteKey` is the
 * widget's), the token did not pass, this network made too many rooms (`retryAfter` seconds),
 * this network is blocked, or anything else (`failed`)
 */
export type CreateRoomProblem =
  | { reason: 'turnstile'; siteKey: string }
  | { reason: 'turnstileFailed' }
  | { reason: 'rateLimited'; retryAfter: number }
  | { reason: 'blocked' }
  | { reason: 'failed' }

export class CreateRoomError extends Error {
  readonly problem: CreateRoomProblem
  constructor(problem: CreateRoomProblem) {
    super(`POST /api/rooms: ${problem.reason}`)
    this.problem = problem
  }
}

/** This network is on the owner's blocklist (I1): every room answers 403 `blocked` */
export class BlockedError extends Error {
  constructor() {
    super('blocked')
  }
}

async function refusal(res: Response): Promise<Partial<CreateRoomRefusal> | null> {
  try {
    return (await res.json()) as Partial<CreateRoomRefusal>
  } catch {
    return null
  }
}

/**
 * POST /api/rooms: a new room's id. `turnstileToken` is the widget's answer when the server
 * asked for one. Throws CreateRoomError when the server does not answer with a room.
 */
export async function createRoom(turnstileToken?: string): Promise<string> {
  let res: Response
  try {
    res = await fetch('/api/rooms', {
      method: 'POST',
      headers: turnstileToken ? { [TURNSTILE_HEADER]: turnstileToken } : undefined,
    })
  } catch {
    throw new CreateRoomError({ reason: 'failed' })
  }
  if (!res.ok) {
    const body = await refusal(res)
    if (body?.error === 'turnstile_required' && typeof body.siteKey === 'string') {
      throw new CreateRoomError({ reason: 'turnstile', siteKey: body.siteKey })
    }
    if (body?.error === 'turnstile_failed') throw new CreateRoomError({ reason: 'turnstileFailed' })
    if (body?.error === 'blocked') throw new CreateRoomError({ reason: 'blocked' })
    if (body?.error === 'rate_limited') {
      const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : 60
      throw new CreateRoomError({ reason: 'rateLimited', retryAfter })
    }
    throw new CreateRoomError({ reason: 'failed' })
  }
  const body = (await res.json()) as Partial<CreateRoomResponse>
  if (!isRoomId(body.id)) throw new CreateRoomError({ reason: 'failed' })
  return body.id
}

/**
 * GET /api/rooms/<id>: the room, or null when there is no such room. Throws BlockedError when
 * this network is blocked, an Error on other failures.
 */
export async function getRoom(
  roomId: string,
): Promise<(RoomSummary & { viewer?: RoomViewer | null }) | null> {
  const res = await fetch(roomInfoPath(roomId))
  if (res.status === 404) return null
  if (res.status === 403 && (await refusal(res))?.error === 'blocked') throw new BlockedError()
  if (!res.ok) throw new Error(`GET ${roomInfoPath(roomId)}: ${res.status}`)
  const body = (await res.json()) as Partial<RoomSummary>
  if (body.id !== roomId || typeof body.memberCount !== 'number') {
    throw new Error(`GET ${roomInfoPath(roomId)}: unexpected body`)
  }
  // `viewer` (I2): this browser's account, when it is signed in
  return body as RoomSummary & { viewer?: RoomViewer | null }
}
