import type { HealthResponse } from '../shared/health.ts'
import type { RoomDO } from './room.ts'
import { handleRooms } from './rooms.ts'

export interface Env {
  ASSETS: Fetcher
  ROOM: DurableObjectNamespace<RoomDO>
  // Set at deploy time (wrangler deploy --var APP_VERSION:<commit>)
  APP_VERSION?: string
}

// The Worker answers /api/* and hands everything else to the static assets (the React app).
// /r/:roomId is a client route: assets answer it with index.html (single-page-application);
// the room's WebSocket is /api/rooms/<id>/ws (worker/rooms.ts).
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/health') {
    const body: HealthResponse = { ok: true, version: env.APP_VERSION ?? 'local' }
    return Response.json(body, { headers: { 'cache-control': 'no-store' } })
  }
  if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/')) {
    return handleRooms(request, env, url)
  }
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  return env.ASSETS.fetch(request)
}
