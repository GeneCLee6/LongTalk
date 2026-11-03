// How a room keeps its password and limits guessing (F3, e1-t15, AC-1.8). The shape of a password
// is shared/password.ts.
//
// The room stores a salted SHA-256 of the password (16 random bytes of salt per password), never
// the password itself, and compares digests in constant time. Why not a slow hash (PBKDF2):
// a room password is 4–12 characters, so a slow hash would not stop an offline search of a leaked
// digest anyway, while it would spend CPU on every join attempt. What protects the password is
// that guessing happens online, against the room: PASSWORD_MAX_FAILS wrong guesses in a row from
// a browser or from a network address mean waiting PASSWORD_WAIT_MS (PasswordGuard). The digest
// only lives in the room's own storage and goes with the room. The password itself is never
// logged, never put in a URL the Worker sees, and never sent back to anyone.
import { PASSWORD_MAX_FAILS, PASSWORD_WAIT_MS } from '../shared/password.ts'

/** A stored password: base64 salt and digest */
export type PasswordRecord = { salt: string; hash: string }

const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function digest(salt: Uint8Array, password: string): Promise<Uint8Array> {
  const secret = encoder.encode(password)
  const input = new Uint8Array(salt.length + secret.length)
  input.set(salt)
  input.set(secret, salt.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

/** A new record for `password` (already normalized), with a fresh salt */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  return { salt: toBase64(salt), hash: toBase64(await digest(salt, password)) }
}

/** Whether `password` matches the record; the digests are compared in constant time */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const expected = fromBase64(record.hash)
  const actual = await digest(fromBase64(record.salt), password)
  return constantTimeEqual(actual, expected)
}

/** Every byte is looked at whatever the first difference, so timing says nothing */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * A network address as the room keeps it for the guess limit: a digest bound to the room, never
 * the address itself. Null without one (local development).
 */
export async function addressKey(ip: string | null, roomId: string): Promise<string | null> {
  if (!ip) return null
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`longtalk:${roomId}:${ip}`))
  return toBase64(new Uint8Array(bytes).slice(0, 12))
}

/** One browser's or address's wrong guesses, as stored */
export type GuessRecord = {
  key: string
  /** Wrong guesses in a row (since the last right one, or the last wait) */
  fails: number
  /** When the last wrong guess was */
  at: number
  /** Until when it must wait (null: it may guess) */
  until: number | null
}

/** Wrong guesses older than this no longer count */
export const GUESS_MEMORY_MS = 10 * 60_000
/** The most browsers and addresses kept at once (the oldest goes first) */
export const MAX_GUESS_RECORDS = 500

/**
 * The wrong-guess limit (AC-1.8): PASSWORD_MAX_FAILS wrong passwords in a row from one browser
 * (its client id) or one network address (addressKey) make both wait PASSWORD_WAIT_MS. Kept in
 * the room's storage (the object may sleep between two guesses). Pure: the clock is passed in.
 */
export class PasswordGuard {
  private readonly records = new Map<string, GuessRecord>()

  constructor(saved: readonly GuessRecord[] = []) {
    for (const record of saved) this.records.set(record.key, { ...record })
  }

  /** Until when any of `keys` must wait, or null when they may guess now */
  waitUntil(keys: readonly string[], now: number): number | null {
    let until: number | null = null
    for (const key of keys) {
      const record = this.records.get(key)
      if (record?.until != null && record.until > now) until = Math.max(until ?? 0, record.until)
    }
    return until
  }

  /**
   * A wrong guess from `keys`: until when they must wait now (the PASSWORD_MAX_FAILS-th wrong
   * guess in a row), or null when they may try again
   */
  fail(keys: readonly string[], now: number): number | null {
    let until: number | null = null
    for (const key of keys) {
      const previous = this.records.get(key)
      const fresh = previous && now - previous.at <= GUESS_MEMORY_MS && previous.until === null
      const fails = (fresh ? previous.fails : 0) + 1
      const record: GuessRecord =
        fails >= PASSWORD_MAX_FAILS
          ? { key, fails: 0, at: now, until: now + PASSWORD_WAIT_MS }
          : { key, fails, at: now, until: null }
      this.records.delete(key)
      this.records.set(key, record)
      if (record.until !== null) until = Math.max(until ?? 0, record.until)
    }
    while (this.records.size > MAX_GUESS_RECORDS) {
      this.records.delete(this.records.keys().next().value!)
    }
    // Every key waits as long as the longest: the browser and its address count together
    if (until !== null) {
      for (const key of keys) this.records.set(key, { key, fails: 0, at: now, until })
    }
    return until
  }

  /** The right password: the count starts again */
  succeed(keys: readonly string[]): void {
    for (const key of keys) this.records.delete(key)
  }

  /** Forgets what no longer matters at `now`; true when anything went */
  prune(now: number): boolean {
    let changed = false
    for (const [key, record] of this.records) {
      const ends = Math.max(record.until ?? 0, record.at + GUESS_MEMORY_MS)
      if (ends > now) continue
      this.records.delete(key)
      changed = true
    }
    return changed
  }

  /** When the next record runs out (for the scheduler), or null when there is none */
  nextExpiry(): number | null {
    let next: number | null = null
    for (const record of this.records.values()) {
      const ends = Math.max(record.until ?? 0, record.at + GUESS_MEMORY_MS)
      if (next === null || ends < next) next = ends
    }
    return next
  }

  clear(): void {
    this.records.clear()
  }

  get size(): number {
    return this.records.size
  }

  toJSON(): GuessRecord[] {
    return [...this.records.values()]
  }
}
