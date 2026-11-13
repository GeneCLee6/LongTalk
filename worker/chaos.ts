import { isRoomKey } from '../shared/slug.ts'

// Chaos drills (O2, e11-t12; DEPLOY.md §14): `POST /api/chaos/rooms/<id>/kill` throws a room's
// Durable Object away (DurableObjectState.abort), as a crash or a deploy would: every socket of
// the room closes and the next request builds the object again from storage. e2e/chaos.spec.ts
// uses it on a pull request's preview to check that everyone comes back by themselves.
//
// Only where `CHAOS_DRILLS` is "1": wrangler.jsonc sets it for the previews alone, never at the
// top level (production; tests/worker/chaos.test.ts reads wrangler.jsonc to make sure). Anywhere
// else the path does not exist (404, the same as any unknown path). No token: a preview is
// throwaway and its rooms are the test's own.

export interface ChaosEnv {
  /** "1" turns the drill endpoints on (previews only) */
  CHAOS_DRILLS?: string
}

/** The room's side: RoomDO.chaosKill */
export interface ChaosRoom {
  chaosKill(): Promise<void>
}

export interface ChaosDeps {
  room(roomId: string): ChaosRoom
}

export const CHAOS_PATH = '/api/chaos/'
const KILL = /^\/api\/chaos\/rooms\/([^/]+)\/kill$/

const noStore = { 'cache-control': 'no-store' }

export function chaosEnabled(env: ChaosEnv): boolean {
  return env.CHAOS_DRILLS === '1'
}

export async function handleChaos(
  request: Request,
  env: ChaosEnv,
  url: URL,
  deps: ChaosDeps,
): Promise<Response> {
  const match = KILL.exec(url.pathname)
  if (!chaosEnabled(env) || !match) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: noStore })
  }
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { ...noStore, allow: 'POST' } },
    )
  }
  const roomId = match[1]
  if (!isRoomKey(roomId)) {
    return Response.json({ error: 'bad_request' }, { status: 400, headers: noStore })
  }
  try {
    await deps.room(roomId).chaosKill()
  } catch {
    // abort() fails the call that made it: that is the object going away
  }
  return Response.json({ killed: roomId }, { headers: noStore })
}
