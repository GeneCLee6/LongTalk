import {
  TURN_REFRESH_FRACTION,
  turnPath,
  usableIceServers,
  type TurnResponse,
} from '../../shared/turn.ts'
import type { IceConfig } from '../room/RoomMedia.ts'

/**
 * POST /api/turn/<roomId> (e2-t07): the ICE servers for the member's next PeerConnection, with
 * short-lived TURN credentials when the Worker has a TURN key. Null when there is no token yet or
 * the call fails (the transport then uses Cloudflare's STUN server).
 *
 * `relayOnly` forces every path through TURN (iceTransportPolicy `relay`): a debugging aid for
 * checking TURN works, from the `?ice=relay` query (RoomPage).
 */
export async function fetchIceConfig(
  roomId: string,
  token: string | null,
  relayOnly = false,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<IceConfig | null> {
  if (!token) return null
  const res = await fetcher(turnPath(roomId), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const body = (await res.json()) as Partial<TurnResponse>
  const iceServers = usableIceServers(body.iceServers)
  if (!iceServers || iceServers.length === 0) return null
  const ttl = typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0 ? body.ttlSeconds : null
  return {
    connect: {
      iceServers: iceServers as RTCIceServer[],
      iceTransportPolicy: relayOnly && body.turn ? 'relay' : 'all',
    },
    refreshAfterMs: ttl === null ? null : Math.round(ttl * 1000 * TURN_REFRESH_FRACTION),
  }
}
