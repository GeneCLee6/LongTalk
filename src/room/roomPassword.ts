import { PASSWORD_PARAM, normalizePassword } from '../../shared/password.ts'

// The room password in the browser (F3, e1-t15). Privacy rules:
// - a link's `?pwd=` is read once, before anything else runs (main.tsx), and taken out of the
//   address bar at once (history.replaceState): it is not left in the history, not sent as a
//   Referer, not seen by telemetry or a screenshot;
// - the password goes to the room only inside the `join` message on the WebSocket, never in a
//   URL the Worker sees;
// - what this tab knows of a room's password (from the link, typed on the pre-join screen, or
//   set by the host here) stays in this tab's sessionStorage, next to the session token, so
//   「複製含密碼的連結」 still works after a reload; closing the tab forgets it.

const ROOM_PATH = /^\/r\/([^/]+)\/?$/
const knownKey = (roomId: string) => `longtalk.password.${roomId}`

/** The password a link brought, for the room it was for */
let fromLink: { roomId: string; password: string } | null = null

/**
 * Reads `?pwd=` from the address and removes it from the address bar (keeping everything else),
 * before React or telemetry run. Returns the password (normalized), or null when the link had
 * none or it is not a valid one (removed all the same).
 */
export function takePasswordFromUrl(
  win: Pick<Window, 'location' | 'history'> = window,
): string | null {
  const url = new URL(win.location.href)
  fromLink = null
  if (!url.searchParams.has(PASSWORD_PARAM)) return null
  const raw = url.searchParams.get(PASSWORD_PARAM)
  url.searchParams.delete(PASSWORD_PARAM)
  win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash)
  const password = normalizePassword(raw)
  const roomId = ROOM_PATH.exec(url.pathname)?.[1] ?? null
  fromLink = password !== null && roomId !== null ? { roomId, password } : null
  return password
}

/** The password the link to this room brought, if any */
export function linkPassword(roomId: string): string | null {
  return fromLink?.roomId === roomId ? fromLink.password : null
}

/**
 * What this tab knows of the room's password: the password and the `RoomInfo.passwordSetAt` it
 * belongs to. `setAt` null: not confirmed by the room yet (typed on the pre-join screen, or just
 * set here); `after` is then the room's `passwordSetAt` when it was set here, so the change the
 * room reports next is the one it belongs to.
 */
export type KnownPassword = { password: string; setAt: number | null; after?: number | null }

export function loadKnownPassword(roomId: string): KnownPassword | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(knownKey(roomId)) ?? 'null') as unknown
    if (typeof saved !== 'object' || saved === null) return null
    const { password, setAt, after } = saved as Record<string, unknown>
    const valid = normalizePassword(password)
    if (valid === null) return null
    const known: KnownPassword = {
      password: valid,
      setAt: typeof setAt === 'number' ? setAt : null,
    }
    if (typeof after === 'number' || after === null) known.after = after
    return known
  } catch {
    return null
  }
}

export function saveKnownPassword(roomId: string, known: KnownPassword | null): void {
  try {
    if (known === null) sessionStorage.removeItem(knownKey(roomId))
    else sessionStorage.setItem(knownKey(roomId), JSON.stringify(known))
  } catch {
    // Blocked storage: 「複製含密碼的連結」 lasts until a reload
  }
}

/**
 * What the known password becomes once the room reports `passwordSetAt`: confirmed (tied to that
 * time), forgotten (the room has none, or another one), or unchanged (the same object)
 */
export function reconcileKnown(
  known: KnownPassword | null,
  passwordSetAt: number | null,
): KnownPassword | null {
  if (known === null) return null
  if (known.setAt === null) {
    // Set here, and the room has not reported the change yet
    if (known.after !== undefined && passwordSetAt === known.after) return known
    return passwordSetAt === null ? null : { password: known.password, setAt: passwordSetAt }
  }
  return passwordSetAt === known.setAt ? known : null
}

/** The known password if it is the room's current one; null otherwise */
export function currentPassword(
  known: KnownPassword | null,
  passwordSetAt: number | null,
): string | null {
  if (known === null || passwordSetAt === null) return null
  return known.setAt === passwordSetAt ? known.password : null
}

/** The room's link with its password, for 「複製含密碼的連結」 */
export function linkWithPassword(link: string, password: string): string {
  const url = new URL(link)
  url.searchParams.set(PASSWORD_PARAM, password)
  return url.toString()
}
