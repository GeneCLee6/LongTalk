// What the join form accepts (f-remote-control-security.md §5.8: the agent talks to one domain
// only): a room id or slug, or a link to a room on that domain. A link to any other host is
// refused with 「這不是 LongTalk 的連結」: the room id is never sent anywhere but the origin built
// into the agent (src-tauri/src/origin.rs). Pure, so tests/agent can run it.
import { parseRoomAddress } from '../../../shared/slug.ts'

export type JoinTarget =
  { ok: true; room: string } | { ok: false; problem: 'foreignLink' | 'badRoom' }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
// `host.tld/…` typed without a scheme
const BARE_HOST = /^[^\s/]+\.[^\s/]+\//

export function parseJoinTarget(input: string, origin: string): JoinTarget {
  const text = input.trim()
  if (SCHEME.test(text) || BARE_HOST.test(text)) {
    let url: URL
    try {
      url = new URL(SCHEME.test(text) ? text : `https://${text}`)
    } catch {
      return { ok: false, problem: 'badRoom' }
    }
    const ours = new URL(origin)
    if (!/^https?:$/.test(url.protocol) || url.hostname !== ours.hostname) {
      return { ok: false, problem: 'foreignLink' }
    }
    if (url.port !== ours.port) return { ok: false, problem: 'foreignLink' }
    const room = url.pathname.startsWith('/r/') ? parseRoomAddress(url.pathname) : null
    return room ? { ok: true, room } : { ok: false, problem: 'badRoom' }
  }
  const room = parseRoomAddress(text)
  return room ? { ok: true, room } : { ok: false, problem: 'badRoom' }
}

/** Why the session ended when the room closed the socket (shared/protocol.ts CloseCode) */
export type CloseProblem =
  | 'pairingFailed'
  | 'expired'
  | 'replaced'
  | 'versionMismatch'
  | 'roomNotFound'
  | 'roomFull'
  | 'rateLimited'
  | 'removed'
  | 'ended'
  | 'failed'

/**
 * The problem to show when a socket closed and the session is over (the codes as shared/control.ts
 * lists them for agent sockets). `welcomed`: whether the room had accepted the pairing on this
 * session; any other 44xx close before that is taken as the code.
 */
export function closeProblem(code: number, welcomed: boolean): CloseProblem {
  switch (code) {
    case 4402:
      return 'pairingFailed'
    case 4401:
      return 'expired'
    case 4410:
      return 'replaced'
    case 4400:
      return 'versionMismatch'
    case 4404:
      return 'roomNotFound'
    case 4409:
      return 'roomFull'
    case 4420:
      return 'rateLimited'
    case 4403:
      return 'removed'
    case 4411:
      return 'ended'
  }
  if (!welcomed && code >= 4400 && code <= 4499) return 'pairingFailed'
  return 'failed'
}
