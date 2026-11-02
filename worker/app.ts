import type { HealthResponse } from '../shared/health.ts'
import type { UsageState } from '../shared/usage.ts'
import type { RoomDO } from './room.ts'
import { handleRooms } from './rooms.ts'
import { handleSfu, type SfuEnv } from './sfu.ts'
import type { UsageDO } from './usage-do.ts'
import { USAGE_OBJECT, type UsageEnv } from './usage.ts'

export interface Env extends SfuEnv, UsageEnv {
  ASSETS: Fetcher
  ROOM: DurableObjectNamespace<RoomDO>
  /** One object for the whole deployment: the month's Realtime egress (e11-t13) */
  USAGE: DurableObjectNamespace<UsageDO>
  // Set at deploy time (wrangler deploy --var APP_VERSION:<commit>)
  APP_VERSION?: string
}

const noStore = { 'cache-control': 'no-store' }

/** The SFU proxy reads the month's state at most this often per isolate */
const USAGE_CACHE_MS = 30_000
let usageCache: { at: number; state: UsageState } | null = null

function usageStub(env: Env) {
  return env.USAGE.get(env.USAGE.idFromName(USAGE_OBJECT))
}

/**
 * The month's usage state for the SFU proxy, cached briefly. When UsageDO cannot be reached the
 * call goes ahead (a transient failure must not cut video); the next flush catches up.
 */
async function cachedUsageState(env: Env, now = Date.now()): Promise<UsageState> {
  if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.state
  try {
    const { state } = await usageStub(env).status()
    usageCache = { at: now, state }
    return state
  } catch (error) {
    console.error('usage status failed', error)
    return usageCache?.state ?? 'normal'
  }
}

/** For tests: forget the cached usage state */
export function resetUsageCache(): void {
  usageCache = null
}

// The Worker answers /api/* and hands everything else to the static assets (the React app).
// /r/:roomId is a client route: assets answer it with index.html (single-page-application);
// the room's WebSocket is /api/rooms/<id>/ws (worker/rooms.ts).
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/health') {
    const body: HealthResponse = { ok: true, version: env.APP_VERSION ?? 'local' }
    return Response.json(body, { headers: noStore })
  }
  if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/')) {
    return handleRooms(request, env, url)
  }
  if (url.pathname.startsWith('/api/sfu/')) {
    return handleSfu(request, env, {
      room: (roomId) => env.ROOM.get(env.ROOM.idFromName(roomId)),
      usage: () => cachedUsageState(env),
    })
  }
  if (url.pathname === '/api/usage') {
    if (request.method !== 'GET') {
      return Response.json(
        { error: 'method_not_allowed' },
        { status: 405, headers: { allow: 'GET' } },
      )
    }
    return Response.json(await usageStub(env).status(), { headers: noStore })
  }
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  return env.ASSETS.fetch(request)
}
