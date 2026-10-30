import type { SfuProxyError } from '../shared/sfu.ts'

// Proxy for the Cloudflare Realtime SFU HTTPS API (docs/adr-001-media-layer.md). The App Secret
// stays here (CLAUDE.md rule 3); the browser only sees its own session's SDP and track ids.
// Only the handful of calls the client needs are forwarded, with the session id validated, so
// the browser cannot reach any other part of the Realtime API through this route.
//
// A2 spike: the routes are not yet tied to room membership. B1 (e2-t03) makes the client ask
// RoomDO for its session and checks the member's session token here before forwarding.

export interface SfuEnv {
  // Realtime dashboard → SFU app → App ID (not secret, but kept next to the secret)
  REALTIME_APP_ID?: string
  // Realtime dashboard → SFU app → App Secret (API token). `wrangler secret put` only
  REALTIME_APP_SECRET?: string
}

export const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1'

// Largest body we forward: an SDP offer with a handful of transceivers is a few kB
const MAX_BODY_BYTES = 64 * 1024
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

interface Route {
  method: 'GET' | 'POST' | 'PUT'
  // Path on the Realtime API under /apps/{appId}
  upstream: (sessionId: string) => string
  hasBody: boolean
}

// Keyed by `${method} ${suffix}`, where suffix is the part after /api/sfu/sessions/:id
const sessionRoutes: Record<string, Route> = {
  'GET ': { method: 'GET', upstream: (id) => `/sessions/${id}`, hasBody: false },
  'POST /tracks': { method: 'POST', upstream: (id) => `/sessions/${id}/tracks/new`, hasBody: true },
  'PUT /tracks/update': {
    method: 'PUT',
    upstream: (id) => `/sessions/${id}/tracks/update`,
    hasBody: true,
  },
  'PUT /tracks/close': {
    method: 'PUT',
    upstream: (id) => `/sessions/${id}/tracks/close`,
    hasBody: true,
  },
  'PUT /renegotiate': {
    method: 'PUT',
    upstream: (id) => `/sessions/${id}/renegotiate`,
    hasBody: true,
  },
}

function fail(error: SfuProxyError['error'], status: number): Response {
  const body: SfuProxyError = { error }
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function readJsonObject(request: Request): Promise<string | null> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? text : null
  } catch {
    return null
  }
}

/**
 * Handles /api/sfu/*:
 * - POST /api/sfu/sessions                       → POST sessions/new
 * - GET  /api/sfu/sessions/:id                   → GET  sessions/:id
 * - POST /api/sfu/sessions/:id/tracks            → POST sessions/:id/tracks/new
 * - PUT  /api/sfu/sessions/:id/tracks/update     → PUT  sessions/:id/tracks/update
 * - PUT  /api/sfu/sessions/:id/tracks/close      → PUT  sessions/:id/tracks/close
 * - PUT  /api/sfu/sessions/:id/renegotiate       → PUT  sessions/:id/renegotiate
 * Realtime's status and JSON body are passed through unchanged.
 */
export async function handleSfu(
  request: Request,
  env: SfuEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/api\/sfu/, '')

  let route: Route | undefined
  let sessionId = ''
  if (path === '/sessions') {
    if (request.method === 'POST') {
      route = { method: 'POST', upstream: () => '/sessions/new', hasBody: false }
    }
  } else {
    const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path)
    if (match) {
      sessionId = match[1]
      if (!SESSION_ID.test(sessionId)) return fail('bad_request', 400)
      route = sessionRoutes[`${request.method} ${match[2] ?? ''}`]
    }
  }
  if (!route) return fail('not_found', 404)

  const appId = env.REALTIME_APP_ID
  const secret = env.REALTIME_APP_SECRET
  if (!appId || !secret) return fail('sfu_not_configured', 503)

  let body: string | undefined
  if (route.hasBody) {
    const json = await readJsonObject(request)
    if (json === null) return fail('bad_request', 400)
    body = json
  }

  let upstream: Response
  try {
    upstream = await fetchImpl(
      `${REALTIME_API_BASE}/apps/${encodeURIComponent(appId)}${route.upstream(sessionId)}`,
      {
        method: route.method,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body,
      },
    )
  } catch {
    return fail('upstream_error', 502)
  }

  const text = await upstream.text()
  try {
    JSON.parse(text)
  } catch {
    return fail('upstream_error', 502)
  }
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
