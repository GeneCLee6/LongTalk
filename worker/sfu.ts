import { isSessionToken, isSfuId } from '../shared/protocol.ts'
import { isRoomId } from '../shared/room-id.ts'
import type { SfuProxyError, TracksRequest } from '../shared/sfu.ts'
import { isVideoKind, type UsageState } from '../shared/usage.ts'
import type { SfuAccess, SfuTrackRef } from './room-host.ts'

// Proxy for the Cloudflare Realtime SFU HTTPS API (docs/adr-001-media-layer.md). The App Secret
// stays here (CLAUDE.md rule 3); the browser only sees its own session's SDP and track ids.
//
// Bound to room membership (B1, e2-t03): every call names a room and carries the member's session
// token (`Authorization: Bearer <token>`, from RoomDO's `welcome`). RoomDO decides (sfuAccess):
// the token must be a member's, the SFU session must be the one that member created here, and a
// track to pull must be published in that room. Creating a session records it as the member's
// (bindSfu). So nobody outside a room can spend the SFU, and a member cannot drive anyone else's
// session. Only the handful of calls the client needs are forwarded.
//
// The free-tier guard (e11-t13): once the month reaches the audio-only threshold, a call that
// would push or pull a new video track is refused with 403 `usage_audio_only`.

export interface SfuEnv {
  // Realtime dashboard → SFU app → App ID (not secret, but kept next to the secret)
  REALTIME_APP_ID?: string
  // Realtime dashboard → SFU app → App Secret (API token). `wrangler secret put` only
  REALTIME_APP_SECRET?: string
}

/** The room's side of the check, RPC to its RoomDO (RoomHost.sfuAccess / bindSfu) */
export interface SfuRoom {
  sfuAccess(token: string, sessionId: string | null, pulls: SfuTrackRef[]): Promise<SfuAccess>
  bindSfu(token: string, sessionId: string): Promise<boolean>
}

export interface SfuDeps {
  room(roomId: string): SfuRoom
  /** The month's usage state (UsageDO), only asked when a call adds video */
  usage(): Promise<UsageState>
  fetch?: typeof fetch
}

export const REALTIME_API_BASE = 'https://rtc.live.cloudflare.com/v1'

// Largest body we forward: an SDP offer with a handful of transceivers is a few kB
const MAX_BODY_BYTES = 64 * 1024
/** Tracks one call may add (the client adds one at a time) */
const MAX_TRACKS_PER_CALL = 8

const PATH = /^\/api\/sfu\/([^/]+)\/sessions(?:\/([^/]+)(\/.*)?)?$/

interface Route {
  method: 'POST' | 'PUT'
  // Path on the Realtime API under /apps/{appId}
  upstream: (sessionId: string) => string
  hasBody: boolean
  /** POST …/tracks: the body is inspected for what it pushes and pulls */
  addsTracks?: boolean
}

const createRoute: Route = { method: 'POST', upstream: () => '/sessions/new', hasBody: false }

// Keyed by `${method} ${suffix}`, where suffix is the part after /api/sfu/<room>/sessions/:id
const sessionRoutes: Record<string, Route> = {
  'POST /tracks': {
    method: 'POST',
    upstream: (id) => `/sessions/${id}/tracks/new`,
    hasBody: true,
    addsTracks: true,
  },
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

const STATUS: Record<SfuProxyError['error'], number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  usage_audio_only: 403,
  not_found: 404,
  track_not_in_room: 404,
  upstream_error: 502,
  sfu_not_configured: 503,
}

function fail(error: SfuProxyError['error']): Response {
  const body: SfuProxyError = { error }
  return Response.json(body, { status: STATUS[error], headers: { 'cache-control': 'no-store' } })
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The media type (`audio`, `video`, …) of each m-section in an SDP, by its mid */
export function sdpMidKinds(sdp: string): Map<string, string> {
  const kinds = new Map<string, string>()
  for (const section of sdp.split(/\r?\n(?=m=)/)) {
    if (!section.startsWith('m=')) continue
    const kind = section.slice(2, section.indexOf(' '))
    const mid = /(?:^|\n)a=mid:(\S+)/.exec(section)?.[1]
    if (mid) kinds.set(mid, kind)
  }
  return kinds
}

type TrackPlan = { pushesVideo: boolean; pulls: SfuTrackRef[] }

const noTracks = (): TrackPlan => ({ pushesVideo: false, pulls: [] })

/**
 * What a POST …/tracks body adds: the local tracks it pushes (their kind read from the offer's
 * m-sections) and the remote tracks it pulls. Null when the body is not one the client sends.
 */
export function planTracks(body: Record<string, unknown>): TrackPlan | null {
  const request = body as Partial<TracksRequest>
  if (request.autoDiscover) return null
  if (!Array.isArray(request.tracks) || request.tracks.length === 0) return null
  if (request.tracks.length > MAX_TRACKS_PER_CALL) return null
  const sdp = request.sessionDescription?.sdp
  const midKinds = sdpMidKinds(typeof sdp === 'string' ? sdp : '')
  const plan = noTracks()
  for (const track of request.tracks as unknown[]) {
    if (typeof track !== 'object' || track === null) return null
    const { location, mid, sessionId, trackName } = track as Record<string, unknown>
    if (location === 'local') {
      const kind = typeof mid === 'string' ? midKinds.get(mid) : undefined
      if (kind !== 'audio' && kind !== 'video') return null
      if (kind === 'video') plan.pushesVideo = true
    } else if (location === 'remote') {
      if (!isSfuId(sessionId) || !isSfuId(trackName)) return null
      plan.pulls.push({ sessionId, trackName })
    } else {
      return null
    }
  }
  return plan
}

function bearer(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  return match && isSessionToken(match[1]) ? match[1] : null
}

/**
 * Handles /api/sfu/<roomId>/*, each with `Authorization: Bearer <member session token>`:
 * - POST /sessions                        → POST sessions/new (the session becomes the member's)
 * - POST /sessions/:id/tracks             → POST sessions/:id/tracks/new
 * - PUT  /sessions/:id/tracks/update      → PUT  sessions/:id/tracks/update
 * - PUT  /sessions/:id/tracks/close       → PUT  sessions/:id/tracks/close
 * - PUT  /sessions/:id/renegotiate        → PUT  sessions/:id/renegotiate
 * Realtime's status and JSON body are passed through unchanged.
 */
export async function handleSfu(request: Request, env: SfuEnv, deps: SfuDeps): Promise<Response> {
  const match = PATH.exec(new URL(request.url).pathname)
  if (!match || !isRoomId(match[1])) return fail('not_found')
  const roomId = match[1]
  const sessionId = match[2] ?? null
  let route: Route | undefined
  if (sessionId === null) {
    if (request.method === 'POST') route = createRoute
  } else {
    if (!isSfuId(sessionId)) return fail('bad_request')
    route = sessionRoutes[`${request.method} ${match[3] ?? ''}`]
  }
  if (!route) return fail('not_found')

  const token = bearer(request)
  if (!token) return fail('unauthorized')

  let body: Record<string, unknown> | null = null
  let plan = noTracks()
  if (route.hasBody) {
    body = await readJsonObject(request)
    if (body === null) return fail('bad_request')
    if (route.addsTracks) {
      const tracks = planTracks(body)
      if (!tracks) return fail('bad_request')
      plan = tracks
    }
  }

  const room = deps.room(roomId)
  const access = await room.sfuAccess(token, sessionId, plan.pulls)
  if (!access.ok) {
    return fail(access.reason === 'not_found' ? 'track_not_in_room' : access.reason)
  }

  const appId = env.REALTIME_APP_ID
  const secret = env.REALTIME_APP_SECRET
  if (!appId || !secret) return fail('sfu_not_configured')

  const addsVideo = plan.pushesVideo || access.pulls.some(isVideoKind)
  if (addsVideo && (await deps.usage()) === 'audioOnly') return fail('usage_audio_only')

  let upstream: Response
  try {
    upstream = await (deps.fetch ?? fetch)(
      `${REALTIME_API_BASE}/apps/${encodeURIComponent(appId)}${route.upstream(sessionId ?? '')}`,
      {
        method: route.method,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
      },
    )
  } catch {
    return fail('upstream_error')
  }

  const text = await upstream.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return fail('upstream_error')
  }
  if (route === createRoute && upstream.ok) {
    const created = (json as { sessionId?: unknown } | null)?.sessionId
    if (!isSfuId(created)) return fail('upstream_error')
    // The member left between the check and now: the session is never handed out
    if (!(await room.bindSfu(token, created))) return fail('unauthorized')
  }
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
