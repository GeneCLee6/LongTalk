import { MAX_SESSIONS } from '../shared/account.ts'
import type { NewCredential } from './webauthn.ts'

// The accounts' tables in D1 (I2, e1-t12, e1-t13; migrations/0001_accounts.sql): every query the
// Worker makes, in one place. Times are epoch milliseconds. Tests run these against SQLite
// (tests/worker/d1.ts) with the same migrations.

export type AccountRow = { id: string; name: string; created_at: number }

export type CredentialRow = {
  id: string
  account_id: string
  public_key: string
  alg: number
  sign_count: number
  transports: string | null
  aaguid: string | null
  backed_up: number
  created_at: number
  last_used_at: number | null
}

export type SessionRow = {
  id: string
  token_hash: string
  prev_hash: string | null
  prev_until: number | null
  account_id: string
  created_at: number
  last_seen_at: number
  rotated_at: number
  expires_at: number
}

export type ChallengeKind = 'register' | 'login' | 'add'

export type ChallengeRow = {
  challenge: string
  kind: ChallengeKind
  account_id: string | null
  name: string | null
  expires_at: number
}

export type RoomRow = { slug: string; account_id: string; created_at: number }

/** A new session: its public id, the hash of its token and when it ends */
export type NewSession = { id: string; tokenHash: string; expiresAt: number }

export class AccountDb {
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  // Challenges

  /** Stores an issued challenge; expired ones go at the same time */
  async putChallenge(row: ChallengeRow, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now),
      this.db
        .prepare(
          'INSERT INTO challenges (challenge, kind, account_id, name, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(row.challenge, row.kind, row.account_id, row.name, row.expires_at),
    ])
  }

  /** Takes the challenge (single use: it is gone after this) if it is of `kind` and unexpired */
  async takeChallenge(challenge: string, kind: ChallengeKind, now: number) {
    return this.db
      .prepare(
        'DELETE FROM challenges WHERE challenge = ? AND kind = ? AND expires_at > ? RETURNING account_id, name',
      )
      .bind(challenge, kind, now)
      .first<{ account_id: string | null; name: string | null }>()
  }

  // Accounts

  async account(id: string): Promise<AccountRow | null> {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>()
  }

  /** A new account with its first passkey and its first session, all or nothing */
  async createAccount(
    account: AccountRow,
    credential: NewCredential,
    session: NewSession,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)')
        .bind(account.id, account.name, account.created_at),
      this.insertCredential(account.id, credential, account.created_at),
      this.insertSession(account.id, session, account.created_at),
    ])
  }

  async renameAccount(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run()
  }

  /** Everything the account has, gone (its rooms' own storage is the caller's to clear first) */
  async deleteAccount(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM rooms WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM credentials WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM challenges WHERE account_id = ?').bind(id),
      this.db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
    ])
  }

  // Passkeys

  async credential(id: string): Promise<CredentialRow | null> {
    return this.db.prepare('SELECT * FROM credentials WHERE id = ?').bind(id).first<CredentialRow>()
  }

  async credentials(accountId: string): Promise<CredentialRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM credentials WHERE account_id = ? ORDER BY created_at')
      .bind(accountId)
      .all<CredentialRow>()
    return results
  }

  private insertCredential(accountId: string, credential: NewCredential, now: number) {
    return this.db
      .prepare(
        'INSERT INTO credentials (id, account_id, public_key, alg, sign_count, transports, aaguid, backed_up, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        credential.id,
        accountId,
        credential.publicKey,
        credential.alg,
        credential.signCount,
        JSON.stringify(credential.transports),
        credential.aaguid,
        credential.backedUp ? 1 : 0,
        now,
        now,
      )
  }

  async addCredential(accountId: string, credential: NewCredential, now: number): Promise<void> {
    await this.insertCredential(accountId, credential, now).run()
  }

  /** After a sign-in: the new counter and backup state, and when it was used */
  async useCredential(id: string, signCount: number, backedUp: boolean, now: number) {
    await this.db
      .prepare('UPDATE credentials SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?')
      .bind(signCount, backedUp ? 1 : 0, now, id)
      .run()
  }

  /** False when the account has no such passkey */
  async deleteCredential(accountId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM credentials WHERE id = ? AND account_id = ?')
      .bind(id, accountId)
      .run()
    return result.meta.changes > 0
  }

  // Sessions

  private insertSession(accountId: string, session: NewSession, now: number) {
    return this.db
      .prepare(
        'INSERT INTO sessions (id, token_hash, account_id, created_at, last_seen_at, rotated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(session.id, session.tokenHash, accountId, now, now, now, session.expiresAt)
  }

  /**
   * A new session for the account; past MAX_SESSIONS the least recently used go, and so does
   * every expired session of anyone's
   */
  async createSession(accountId: string, session: NewSession, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      this.insertSession(accountId, session, now),
      this.db
        .prepare(
          'DELETE FROM sessions WHERE account_id = ? AND id NOT IN (SELECT id FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC, created_at DESC LIMIT ?)',
        )
        .bind(accountId, accountId, MAX_SESSIONS),
    ])
  }

  /**
   * The unexpired session whose token hashes to `hash`, or whose token before its last rotation
   * did and is still in its grace (`previous` true then)
   */
  async session(hash: string, now: number): Promise<(SessionRow & { previous: number }) | null> {
    return this.db
      .prepare(
        'SELECT *, token_hash <> ? AS previous FROM sessions WHERE (token_hash = ? OR (prev_hash = ? AND prev_until > ?)) AND expires_at > ? LIMIT 1',
      )
      .bind(hash, hash, hash, now, now)
      .first<SessionRow & { previous: number }>()
  }

  /** A new token for the session (the old one still works SESSION_ROTATE_GRACE_MS) */
  async rotateSession(
    id: string,
    oldHash: string,
    newHash: string,
    prevUntil: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE sessions SET prev_hash = token_hash, prev_until = ?, token_hash = ?, rotated_at = ?, last_seen_at = ?, expires_at = ? WHERE id = ? AND token_hash = ?',
      )
      .bind(prevUntil, newHash, now, now, expiresAt, id, oldHash)
      .run()
    return result.meta.changes > 0
  }

  async touchSession(id: string, now: number, expiresAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(now, expiresAt, id)
      .run()
  }

  async sessions(accountId: string, now: number): Promise<SessionRow[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
      )
      .bind(accountId, now)
      .all<SessionRow>()
    return results
  }

  /** False when the account has no such session */
  async deleteSession(accountId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?')
      .bind(id, accountId)
      .run()
    return result.meta.changes > 0
  }

  /** Signs every other browser of the account out; how many */
  async deleteOtherSessions(accountId: string, keepId: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE account_id = ? AND id <> ?')
      .bind(accountId, keepId)
      .run()
    return result.meta.changes
  }

  // Persistent rooms

  async rooms(accountId: string): Promise<RoomRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM rooms WHERE account_id = ? ORDER BY created_at')
      .bind(accountId)
      .all<RoomRow>()
    return results
  }

  async room(slug: string): Promise<RoomRow | null> {
    return this.db.prepare('SELECT * FROM rooms WHERE slug = ?').bind(slug).first<RoomRow>()
  }

  /** False when the slug is taken (by anyone) */
  async addRoom(slug: string, accountId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO rooms (slug, account_id, created_at) VALUES (?, ?, ?)')
      .bind(slug, accountId, now)
      .run()
    return result.meta.changes > 0
  }

  async deleteRoom(slug: string, accountId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM rooms WHERE slug = ? AND account_id = ?')
      .bind(slug, accountId)
      .run()
    return result.meta.changes > 0
  }
}
