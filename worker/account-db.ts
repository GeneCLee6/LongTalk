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

export type MeetingRow = {
  id: string
  account_id: string
  room_slug: string
  title: string
  description: string | null
  starts_at: number
  duration_min: number
  ends_at: number
  time_zone: string
  sequence: number
  created_at: number
  updated_at: number
}

/** A meeting's values as a create or an edit saves them */
export type MeetingValues = Pick<
  MeetingRow,
  'room_slug' | 'title' | 'description' | 'starts_at' | 'duration_min' | 'time_zone'
>

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
      this.db.prepare('DELETE FROM meetings WHERE account_id = ?').bind(id),
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

  /** The room's row and its meetings with it (their links stop working) */
  async deleteRoom(slug: string, accountId: string): Promise<boolean> {
    const [, result] = await this.db.batch([
      this.db.prepare('DELETE FROM meetings WHERE room_slug = ? AND account_id = ?').bind(slug, accountId),
      this.db.prepare('DELETE FROM rooms WHERE slug = ? AND account_id = ?').bind(slug, accountId),
    ])
    return result!.meta.changes > 0
  }

  // Scheduled meetings (I3, e1-t14; migrations/0002_meetings.sql). A meeting that ended more than
  // MEETING_RETENTION_MS ago is gone: `keptAfter` is now minus that; older rows are never read,
  // and are deleted whenever anyone saves a meeting

  /** The account's meetings still kept, soonest first */
  async meetings(accountId: string, keptAfter: number): Promise<MeetingRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM meetings WHERE account_id = ? AND ends_at > ? ORDER BY starts_at, created_at')
      .bind(accountId, keptAfter)
      .all<MeetingRow>()
    return results
  }

  async meetingCount(accountId: string, keptAfter: number): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS count FROM meetings WHERE account_id = ? AND ends_at > ?')
      .bind(accountId, keptAfter)
      .first<{ count: number }>()
    return row?.count ?? 0
  }

  async meeting(id: string, keptAfter: number): Promise<MeetingRow | null> {
    return this.db
      .prepare('SELECT * FROM meetings WHERE id = ? AND ends_at > ?')
      .bind(id, keptAfter)
      .first<MeetingRow>()
  }

  /** A meeting and its organizer's display name (the public page shows nothing else of theirs) */
  async publicMeeting(id: string, keptAfter: number) {
    return this.db
      .prepare(
        'SELECT m.*, a.name AS organizer FROM meetings m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.ends_at > ?',
      )
      .bind(id, keptAfter)
      .first<MeetingRow & { organizer: string }>()
  }

  /** A new meeting; meetings past retention (anyone's) go at the same time */
  async addMeeting(row: MeetingRow, keptAfter: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM meetings WHERE ends_at <= ?').bind(keptAfter),
      this.db
        .prepare(
          'INSERT INTO meetings (id, account_id, room_slug, title, description, starts_at, duration_min, ends_at, time_zone, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          row.id,
          row.account_id,
          row.room_slug,
          row.title,
          row.description,
          row.starts_at,
          row.duration_min,
          row.ends_at,
          row.time_zone,
          row.sequence,
          row.created_at,
          row.updated_at,
        ),
    ])
  }

  /** The owner's edit: every value replaced, one more in `sequence`. False when it is not theirs */
  async updateMeeting(id: string, accountId: string, values: MeetingValues, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE meetings SET room_slug = ?, title = ?, description = ?, starts_at = ?, duration_min = ?, ends_at = ?, time_zone = ?, sequence = sequence + 1, updated_at = ? WHERE id = ? AND account_id = ?',
      )
      .bind(
        values.room_slug,
        values.title,
        values.description,
        values.starts_at,
        values.duration_min,
        values.starts_at + values.duration_min * 60_000,
        values.time_zone,
        now,
        id,
        accountId,
      )
      .run()
    return result.meta.changes > 0
  }

  /** False when the account has no such meeting */
  async deleteMeeting(id: string, accountId: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM meetings WHERE id = ? AND account_id = ?')
      .bind(id, accountId)
      .run()
    return result.meta.changes > 0
  }
}
