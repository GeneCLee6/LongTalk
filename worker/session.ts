import { toBase64url } from '../shared/base64url.ts'
import {
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_ROTATE_GRACE_MS,
  SESSION_ROTATE_MS,
} from '../shared/account.ts'
import type { AccountDb, AccountRow, NewSession, SessionRow } from './account-db.ts'

// Signed-in browsers (I2, e1-t12). The cookie holds an opaque random token (32 bytes); D1 keeps
// only its SHA-256, so a copy of the database signs nobody in, and no secret is needed. The
// cookie is __Host- (this host only, path /, Secure), HttpOnly (no script reads it) and
// SameSite=Lax; state-changing calls also check Origin (worker/accounts.ts). The token is
// replaced once a day it is used (rotation; the one before keeps working a couple of minutes for
// requests already on their way); a session ends after SESSION_IDLE_MS unused or SESSION_MAX_MS
// after signing in.

export const SESSION_COOKIE = '__Host-lt_session'

/** The header the Worker hands a room's WebSocket upgrade the signed-in account in (never trusted from a browser) */
export const ACCOUNT_HEADER = 'x-longtalk-account'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** A new random token: 32 bytes, base64url */
export function newToken(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** A new random id (accounts, sessions): 16 bytes, base64url */
export function newId(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(16)))
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return toBase64url(digest)
}

/** The session token in the request's cookie, or null */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== SESSION_COOKIE) continue
    const value = part.slice(at + 1).trim()
    return TOKEN_PATTERN.test(value) ? value : null
  }
  return null
}

/** The Set-Cookie for a session token, valid until `expiresAt` */
export function sessionCookie(token: string, expiresAt: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

/** The Set-Cookie that removes the session cookie */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** When a session last used at `now` ends: SESSION_IDLE_MS on, but never past SESSION_MAX_MS */
export function sessionExpiry(createdAt: number, now: number): number {
  return Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_MAX_MS)
}

/** A new session (its token for the cookie, its row's id and hash) */
export async function startSession(now: number): Promise<{ token: string; session: NewSession }> {
  const token = newToken()
  return {
    token,
    session: { id: newId(), tokenHash: await hashToken(token), expiresAt: now + SESSION_IDLE_MS },
  }
}

export type Authenticated = {
  account: AccountRow
  session: SessionRow
  /** The rotated token's cookie, to send with the answer (null: the cookie stays) */
  setCookie: string | null
}

/** Last-seen times are written at most this often (a write per request would be wasteful) */
const TOUCH_MS = 60 * 60_000

/**
 * The account signed in on this request, or null. With `rotate`, a token older than
 * SESSION_ROTATE_MS is replaced and the answer must carry `setCookie`; without it (a WebSocket
 * upgrade, which cannot), the session is only read.
 */
export async function authenticate(
  db: AccountDb,
  request: Request,
  now: number,
  { rotate }: { rotate: boolean },
): Promise<Authenticated | null> {
  const token = readSessionToken(request)
  if (!token) return null
  const hash = await hashToken(token)
  const row = await db.session(hash, now)
  if (!row) return null
  const account = await db.account(row.account_id)
  if (!account) return null
  const { previous, ...session } = row
  if (previous) return { account, session, setCookie: null }
  const expiresAt = sessionExpiry(session.created_at, now)
  if (rotate && now - session.rotated_at >= SESSION_ROTATE_MS) {
    const next = newToken()
    const nextHash = await hashToken(next)
    if (
      await db.rotateSession(
        session.id,
        hash,
        nextHash,
        now + SESSION_ROTATE_GRACE_MS,
        now,
        expiresAt,
      )
    ) {
      return {
        account,
        session: { ...session, token_hash: nextHash, rotated_at: now, last_seen_at: now, expires_at: expiresAt },
        setCookie: sessionCookie(next, expiresAt, now),
      }
    }
    // Another request rotated it first: this one carries on with the old token's grace
    return { account, session, setCookie: null }
  }
  if (now - session.last_seen_at >= TOUCH_MS) {
    await db.touchSession(session.id, now, expiresAt)
    return { account, session: { ...session, last_seen_at: now, expires_at: expiresAt }, setCookie: null }
  }
  return { account, session, setCookie: null }
}
