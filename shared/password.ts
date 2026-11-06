// A room's password (F3, e1-t15, AC-1.8): what one looks like, shared by the browser (checks it
// before sending) and the Worker (checks it again on receipt). How the room keeps it (a salted
// hash, never the password) and the wrong-guess limit are worker/password.ts.

/** A password's length in characters */
export const MIN_PASSWORD_CHARS = 4
export const MAX_PASSWORD_CHARS = 12
/** Wrong guesses in a row, per browser and per network address, before having to wait */
export const PASSWORD_MAX_FAILS = 3
/** How long to wait after PASSWORD_MAX_FAILS wrong guesses */
export const PASSWORD_WAIT_MS = 30_000
/** Wrong guesses older than this no longer count (the retention table on /privacy reads this) */
export const GUESS_MEMORY_MS = 10 * 60_000
/** The link's query parameter that carries the password (stripped from the address bar at once) */
export const PASSWORD_PARAM = 'pwd'

/** Printable ASCII but the space: what a code read out over the phone can be */
const PASSWORD_PATTERN = /^[\x21-\x7E]+$/

/**
 * A password as the room compares it, or null when it is not one: full-width letters and digits
 * (a Chinese IME left in full-width mode) folded to ASCII (NFKC), surrounding spaces trimmed,
 * then MIN_PASSWORD_CHARS–MAX_PASSWORD_CHARS printable ASCII characters. Case-sensitive.
 */
export function normalizePassword(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const password = raw.normalize('NFKC').trim()
  if (password.length < MIN_PASSWORD_CHARS || password.length > MAX_PASSWORD_CHARS) return null
  return PASSWORD_PATTERN.test(password) ? password : null
}
