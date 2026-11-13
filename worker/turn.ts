import { isSessionToken } from '../shared/protocol.ts'
import { isRoomKey } from '../shared/slug.ts'
import {
  STUN_SERVER,
  TURN_TTL_SECONDS,
  usableIceServers,
  type TurnResponse,
} from '../shared/turn.ts'
import { REALTIME_API_BASE, type SfuRoom } from './sfu.ts'

// Short-lived TURN credentials for a room member (e2-t07, shared/turn.ts). The TURN key's API
// token stays here (CLAUDE.md rule 3); the browser only gets credentials that expire after
// TURN_TTL_SECONDS. Bound to room membership like the SFU proxy: the call carries the member's
// session token and the room's RoomDO decides (sfuAccess), so nobody outside a room can make the
// Worker hand out relay credentials.
//
// Cloudflare Realtime TURN API: POST /v1/turn/keys/<key id>/credentials/generate-ice-servers,
// `Authorization: Bearer <key API token>`, body `{"ttl": seconds}` → 201 `{"iceServers": [...]}`.

export interface TurnEnv {
  // Realtime dashboard → TURN → TURN key → Turn Token ID. `wrangler secret put`
  REALTIME_TURN_KEY_ID?: string
  // The same TURN key's API token (shown once). `wrangler secret put` only
  REALTIME_TURN_KEY_API_TOKEN?: string
}

export interface TurnDeps {
  room(roomId: string): Pick<SfuRoom, 'sfuAccess'>
  fetch?: typeof fetch
  /** For tests: TURN_API_TIMEOUT_MS */
  timeoutMs?: number
}

/**
 * Longest wait for Cloudflare's TURN credentials API (O2 chaos drill, e11-t12): when it hangs the
 * member gets STUN only at once instead of waiting, since media waits for the ICE servers
 */
export const TURN_API_TIMEOUT_MS = 5_000

const PATH = /^\/api\/turn\/([^/]+)$/

const headers = { 'cache-control': 'no-store' }

const stunOnly = (): TurnResponse => ({ iceServers: [STUN_SERVER], turn: false, ttlSeconds: null })

function bearer(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  return match && isSessionToken(match[1]) ? match[1] : null
}

/** Asks Cloudflare for credentials; null when it cannot (the caller falls back to STUN) */
async function generate(env: TurnEnv, deps: TurnDeps): Promise<TurnResponse | null> {
  const keyId = env.REALTIME_TURN_KEY_ID
  const apiToken = env.REALTIME_TURN_KEY_API_TOKEN
  if (!keyId || !apiToken) return null
  try {
    const res = await (deps.fetch ?? fetch)(
      `${REALTIME_API_BASE}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? TURN_API_TIMEOUT_MS),
      },
    )
    if (!res.ok) {
      console.error('TURN credentials failed', res.status)
      return null
    }
    const body = (await res.json()) as { iceServers?: unknown }
    const servers = usableIceServers(body.iceServers)
    if (!servers?.some((server) => server.username && server.credential)) {
      console.error('TURN credentials: unexpected answer')
      return null
    }
    // Cloudflare's list carries its STUN server already; make sure it is there either way
    const hasStun = servers.some((server) =>
      [server.urls].flat().some((url) => url.startsWith('stun:')),
    )
    return {
      iceServers: hasStun ? servers : [STUN_SERVER, ...servers],
      turn: true,
      ttlSeconds: TURN_TTL_SECONDS,
    }
  } catch (error) {
    console.error('TURN credentials failed', error)
    return null
  }
}

/**
 * POST /api/turn/<roomId> with `Authorization: Bearer <member session token>`: the ICE servers
 * for the member's next PeerConnection. 401 for anyone who is not a member of the room; STUN only
 * (200, `turn: false`) when TURN is not configured or Cloudflare fails.
 */
export async function handleTurn(
  request: Request,
  env: TurnEnv,
  deps: TurnDeps,
): Promise<Response> {
  const match = PATH.exec(new URL(request.url).pathname)
  if (!match || !isRoomKey(match[1])) {
    return Response.json({ error: 'not_found' }, { status: 404, headers })
  }
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { ...headers, allow: 'POST' } },
    )
  }
  const token = bearer(request)
  const access = token ? await deps.room(match[1]).sfuAccess(token, null, []) : null
  if (!access?.ok) return Response.json({ error: 'unauthorized' }, { status: 401, headers })
  return Response.json((await generate(env, deps)) ?? stunOnly(), { headers })
}
