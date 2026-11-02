// ICE servers for a room member's PeerConnection (e2-t07, AC-2.4). The browser asks the Worker
// (POST /api/turn/<roomId>, `Authorization: Bearer <member session token>`) before every SFU
// session it opens; the Worker asks Cloudflare Realtime TURN for short-lived credentials with
// the TURN key that never leaves the Worker (worker/turn.ts, docs/adr-001-media-layer.md).
//
// Without the TURN secrets, or when Cloudflare does not answer, the Worker answers Cloudflare's
// STUN server only (`turn: false`): calls still work wherever UDP gets through.

/** One entry of RTCConfiguration.iceServers (shared has no DOM types) */
export type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

/** What POST /api/turn/<roomId> answers */
export type TurnResponse = {
  iceServers: IceServer[]
  /** True when the list holds TURN servers with credentials; false: STUN only */
  turn: boolean
  /** How long the credentials last, seconds (null without TURN); the browser refreshes before */
  ttlSeconds: number | null
}

/** Cloudflare's public STUN server: the fallback, and part of every list */
export const STUN_SERVER: IceServer = { urls: 'stun:stun.cloudflare.com:3478' }

/**
 * How long TURN credentials last. Long enough for a long call (the browser also refreshes them
 * at TURN_REFRESH_FRACTION through RTCPeerConnection.setConfiguration, and a rebuilt
 * PeerConnection asks again), short enough that a leaked credential soon stops working.
 */
export const TURN_TTL_SECONDS = 3 * 60 * 60

/** The browser asks for new credentials once this much of the TTL has passed */
export const TURN_REFRESH_FRACTION = 2 / 3

/** POST: this room's TurnResponse, for a member of the room */
export const turnPath = (roomId: string): string => `/api/turn/${roomId}`

/**
 * The servers a browser can use: URLs on port 53 removed (browsers block it, and without trickle
 * ICE a URL that times out holds up gathering), entries left without URLs dropped. Null when the
 * value is not a list of servers.
 */
export function usableIceServers(value: unknown): IceServer[] | null {
  if (!Array.isArray(value)) return null
  const servers: IceServer[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const { urls, username, credential } = item as Record<string, unknown>
    const list = typeof urls === 'string' ? [urls] : urls
    if (!Array.isArray(list) || !list.every((url) => typeof url === 'string')) return null
    const kept = (list as string[]).filter((url) => !/:53(?:[?/]|$)/.test(url))
    if (kept.length === 0) continue
    const server: IceServer = { urls: kept }
    if (typeof username === 'string') server.username = username
    if (typeof credential === 'string') server.credential = credential
    servers.push(server)
  }
  return servers
}
