// @vitest-environment node
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  BACKUP_RETENTION_DAYS,
  BACKUP_STALE_MS,
  FILE_TTL_MS,
  backupExpired,
  backupKey,
  uploadKey,
} from '../../shared/files.ts'
import { backupLines, parseBackup, restoreSql } from '../../shared/backup.ts'
import { BACKUP_EXCLUDED, BACKUP_TABLES, writeBackup } from '../../worker/backup.ts'
import { FileLedger } from '../../worker/file-ledger.ts'
import { backupDue, runScheduled, runSweep } from '../../worker/scheduled.ts'
import { sweepUploads } from '../../worker/sweep.ts'
import { MIGRATIONS, fakeD1 } from './d1.ts'
import { asBucket, FakeBucket } from './files.fakes.ts'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 5, 18, 0)

function sized(bucket: FakeBucket, key: string, size = 10) {
  bucket.objects.set(key, { bytes: new Uint8Array(size) })
}

function ledgerDeps(ledger: FileLedger, now: () => number) {
  return {
    reconcile: async (
      live: { bytes: number; objects: number },
      deleted: { objects: number; bytes: number },
    ) => ledger.reconcile(live, deleted, now()),
    backupDone: async (backup: Parameters<FileLedger['backupDone']>[0]) =>
      ledger.backupDone(backup),
    status: async () => ledger.status(now()),
  }
}

describe('the hourly sweep, on a fake clock (AC-5.4, AC-11.8 排程測試)', () => {
  it('deletes exactly what is past 24 hours, thumbnails too, and counts the rest', async () => {
    const bucket = new FakeBucket()
    const upload = Date.UTC(2026, 10, 4, 13, 20)
    const hourOf = (at: number, id: string) => uploadKey(at, id)
    sized(bucket, hourOf(upload, 'old'), 100)
    sized(bucket, `${hourOf(upload, 'old')}.thumb`, 5)
    sized(bucket, hourOf(upload + HOUR, 'younger'), 30)
    sized(bucket, hourOf(upload + 2 * HOUR, 'young'), 7)
    sized(bucket, 'elsewhere/keep', 1)

    // Just under 24 hours since 13:20, and still under for the whole hour's sake
    let result = await sweepUploads(asBucket(bucket), Date.UTC(2026, 10, 5, 13, 0))
    expect(result.deleted.objects).toBe(0)
    expect(result.live).toEqual({ bytes: 142, objects: 4 })

    // 14:00 the next day: the 13:xx hour is entirely past 24 hours
    result = await sweepUploads(asBucket(bucket), Date.UTC(2026, 10, 5, 14, 0))
    expect(result.deleted).toEqual({ bytes: 105, objects: 2 })
    expect(result.live).toEqual({ bytes: 37, objects: 2 })
    expect(bucket.objects.has(hourOf(upload, 'old'))).toBe(false)
    expect(bucket.objects.has(`${hourOf(upload, 'old')}.thumb`)).toBe(false)
    expect(bucket.objects.has(hourOf(upload + HOUR, 'younger'))).toBe(true)

    // Run again: nothing more, and what is not an upload is never touched
    result = await sweepUploads(asBucket(bucket), Date.UTC(2026, 10, 5, 14, 30))
    expect(result.deleted.objects).toBe(0)
    expect(bucket.objects.has('elsewhere/keep')).toBe(true)
  })

  it('walks every page of a long list', async () => {
    const bucket = new FakeBucket()
    bucket.pageSize = 2
    for (let i = 0; i < 5; i++) sized(bucket, uploadKey(NOW - 3 * DAY, `old${i}`))
    for (let i = 0; i < 3; i++) sized(bucket, uploadKey(NOW, `new${i}`))
    const result = await sweepUploads(asBucket(bucket), NOW)
    expect(result.deleted.objects).toBe(5)
    expect(result.live.objects).toBe(3)
    expect(bucket.calls.list).toBe(4)
  })

  it('never keeps a file past 25 hours, whenever in its hour it came', async () => {
    for (const minute of [0, 1, 30, 59]) {
      const at = Date.UTC(2026, 10, 4, 13, minute)
      const bucket = new FakeBucket()
      sized(bucket, uploadKey(at, 'f'))
      // The cron's next run after 25 hours
      await sweepUploads(asBucket(bucket), Date.UTC(2026, 10, 5, 14 + (minute === 0 ? 0 : 1)))
      expect(bucket.objects.size, `minute ${minute}`).toBe(0)
    }
    // And never before its 24 hours (the room refuses it from then on: room-files.ts)
    const at = Date.UTC(2026, 10, 4, 13, 59)
    const bucket = new FakeBucket()
    sized(bucket, uploadKey(at, 'f'))
    await sweepUploads(asBucket(bucket), at + FILE_TTL_MS - 1)
    expect(bucket.objects.size).toBe(1)
  })

  it('reconciles the ledger with the bucket', async () => {
    const bucket = new FakeBucket()
    sized(bucket, uploadKey(NOW, 'a'), 40)
    sized(bucket, uploadKey(NOW - 2 * DAY, 'b'), 1000)
    const ledger = new FileLedger(null)
    ledger.record.bytes = 5_000_000 // Counted wrong: a crash, a failed delete
    ledger.record.objects = 99
    await runSweep({ FILES_BUCKET: asBucket(bucket) }, ledgerDeps(ledger, () => NOW), NOW)
    expect(ledger.status(NOW)).toMatchObject({
      bytes: 40,
      objects: 1,
      sweep: { at: NOW, deletedObjects: 1, deletedBytes: 1000 },
    })
  })

  it('does nothing without a bucket', async () => {
    const ledger = new FileLedger(null)
    await runSweep({}, ledgerDeps(ledger, () => NOW), NOW)
    expect(ledger.status(NOW).sweep).toBeNull()
  })
})

describe('the backup schedule', () => {
  it('backs up in its hour, or when the last one is too old', () => {
    expect(backupDue(NOW, NOW - DAY)).toBe(true)
    expect(backupDue(NOW + HOUR, NOW)).toBe(false)
    expect(backupDue(NOW + HOUR, null)).toBe(true)
    expect(backupDue(NOW + BACKUP_STALE_MS - 1, NOW)).toBe(false)
    expect(backupDue(NOW + BACKUP_STALE_MS, NOW)).toBe(true)
  })

  it('runs both parts in one cron run; a day of cron makes one backup', async () => {
    const files = new FakeBucket()
    const backups = new FakeBucket()
    const { db } = fakeD1()
    sized(files, uploadKey(NOW - 2 * DAY, 'old'))
    let clock = Date.UTC(2026, 10, 5, 18, 0)
    const ledger = new FileLedger(null)
    const env = { FILES_BUCKET: asBucket(files), BACKUPS_BUCKET: asBucket(backups), DB: db }
    for (let hour = 0; hour < 24; hour++) {
      await runScheduled(env, ledgerDeps(ledger, () => clock), clock)
      clock += HOUR
    }
    expect(files.objects.size).toBe(0)
    expect([...backups.objects.keys()]).toEqual(['d1/2026-11-05.jsonl.gz'])
    expect(backups.calls.put).toBe(1)
    expect(ledger.status(clock).backup).toMatchObject({ key: 'd1/2026-11-05.jsonl.gz' })
  })

  it('a preview (no backup bucket, no database) only sweeps', async () => {
    const files = new FakeBucket()
    const ledger = new FileLedger(null)
    await runScheduled({ FILES_BUCKET: asBucket(files) }, ledgerDeps(ledger, () => NOW), NOW)
    expect(ledger.status(NOW).backup).toBeNull()
    expect(ledger.status(NOW).sweep).not.toBeNull()
  })

  it('a failing sweep still lets the backup run, and the run fails so the log says so', async () => {
    const files = new FakeBucket()
    files.list = () => Promise.reject(new Error('R2 down'))
    const backups = new FakeBucket()
    const { db } = fakeD1()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new FileLedger(null)
    await expect(
      runScheduled(
        { FILES_BUCKET: asBucket(files), BACKUPS_BUCKET: asBucket(backups), DB: db },
        ledgerDeps(ledger, () => NOW),
        NOW,
      ),
    ).rejects.toThrow('R2 down')
    expect(backups.objects.size).toBe(1)
    error.mockRestore()
  })
})

/** A database with a bit of everything, the awkward strings too */
function seeded() {
  const { db, sqlite } = fakeD1()
  const run = (sql: string, ...values: (string | number | null)[]) =>
    sqlite.prepare(sql).run(...values)
  const name = `O'Reilly; DROP TABLE accounts; -- 小潔\n"第二行" 😀`
  run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'acct-1', name, 1)
  run('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)', 'acct-2', 'Bob', 2)
  run(
    `INSERT INTO credentials (id, account_id, public_key, alg, sign_count, transports, aaguid, backed_up, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'cred-1',
    'acct-1',
    'pQECAyYg',
    -7,
    3,
    '["internal"]',
    null,
    1,
    1,
    null,
  )
  run('INSERT INTO rooms (slug, account_id, created_at) VALUES (?, ?, ?)', 'gene-weekly', 'acct-1', 5)
  run(
    `INSERT INTO meetings (id, account_id, room_slug, title, description, starts_at, duration_min, ends_at, time_zone, sequence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'meet-1',
    'acct-1',
    'gene-weekly',
    "週會, it's; here",
    null,
    1000,
    45,
    2000,
    'Asia/Taipei',
    2,
    10,
    11,
  )
  // What must not leave: a session's hash, and a challenge
  run(
    `INSERT INTO sessions (id, token_hash, prev_hash, prev_until, account_id, created_at, last_seen_at, rotated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'sess-1',
    'hash-of-the-session-token',
    'hash-of-the-previous-token',
    5,
    'acct-1',
    1,
    1,
    1,
    9,
  )
  run(
    'INSERT INTO challenges (challenge, kind, account_id, name, expires_at) VALUES (?, ?, ?, ?, ?)',
    'challenge-value',
    'login',
    null,
    null,
    9,
  )
  return { db, sqlite, name }
}

const dump = (sqlite: ReturnType<typeof fakeD1>['sqlite'], table: string) =>
  sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()

describe('the D1 backup (e11-t08)', () => {
  it('writes gzipped JSON lines under the day, with a header and an end line', async () => {
    const { db } = seeded()
    const bucket = new FakeBucket()
    const result = await writeBackup(db, asBucket(bucket), NOW)
    expect(result.key).toBe('d1/2026-11-05.jsonl.gz')
    expect(result.rows).toBe(5)
    const object = bucket.objects.get(result.key)!
    expect(object.contentType).toBe('application/gzip')
    expect(result.bytes).toBe(object.bytes.byteLength)
    const lines = gunzipSync(object.bytes).toString('utf8').trim().split('\n')
    expect(JSON.parse(lines[0])).toEqual({
      format: 'longtalk-d1-backup',
      version: 1,
      at: NOW,
      tables: [...BACKUP_TABLES],
    })
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      end: true,
      rows: { accounts: 2, credentials: 1, rooms: 1, meetings: 1 },
    })
  })

  it('holds no session token, hash or challenge', async () => {
    const { db } = seeded()
    const bucket = new FakeBucket()
    const { key } = await writeBackup(db, asBucket(bucket), NOW)
    const text = gunzipSync(bucket.objects.get(key)!.bytes).toString('utf8')
    for (const secret of [
      'hash-of-the-session-token',
      'hash-of-the-previous-token',
      'sess-1',
      'challenge-value',
      'token_hash',
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('every table of every migration is either backed up or left out on purpose', () => {
    const { sqlite } = fakeD1()
    const tables = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort()
    expect(tables).toEqual([...BACKUP_TABLES, ...BACKUP_EXCLUDED].sort())
  })

  it('reads every table in one batch, so the copy is consistent', async () => {
    const { db } = seeded()
    const batch = vi.spyOn(db, 'batch')
    await writeBackup(db, asBucket(new FakeBucket()), NOW)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toHaveLength(BACKUP_TABLES.length)
  })

  it('keeps BACKUP_RETENTION_DAYS days and deletes older ones; only backups', async () => {
    expect(BACKUP_RETENTION_DAYS).toBe(7)
    const { db } = fakeD1()
    const bucket = new FakeBucket()
    for (let days = 1; days <= 10; days++) sized(bucket, backupKey(NOW - days * DAY))
    sized(bucket, 'd1/notes.txt')
    await writeBackup(db, asBucket(bucket), NOW)
    const kept = [...bucket.objects.keys()].sort()
    expect(kept).toEqual([
      'd1/2026-10-30.jsonl.gz',
      'd1/2026-10-31.jsonl.gz',
      'd1/2026-11-01.jsonl.gz',
      'd1/2026-11-02.jsonl.gz',
      'd1/2026-11-03.jsonl.gz',
      'd1/2026-11-04.jsonl.gz',
      'd1/2026-11-05.jsonl.gz',
      'd1/notes.txt',
    ])
    expect(backupExpired('d1/2026-10-29.jsonl.gz', NOW)).toBe(true)
    expect(backupExpired('d1/2026-10-30.jsonl.gz', NOW)).toBe(false)
  })

  it('restore drill: a backup restored into a new database has the same rows', async () => {
    const { db, sqlite, name } = seeded()
    const bucket = new FakeBucket()
    const { key } = await writeBackup(db, asBucket(bucket), NOW)

    // What the owner does: download, turn it into SQL (scripts/restore-backup.ts), run that on a
    // database with the migrations applied (fakeD1 applies the real ones, in order)
    const text = gunzipSync(bucket.objects.get(key)!.bytes).toString('utf8')
    const sql = restoreSql(parseBackup(text))
    const restored = fakeD1(MIGRATIONS)
    restored.sqlite.exec(sql)

    for (const table of BACKUP_TABLES) {
      expect(dump(restored.sqlite, table), table).toEqual(dump(sqlite, table))
    }
    expect(dump(restored.sqlite, 'accounts')).toHaveLength(2)
    expect((dump(restored.sqlite, 'accounts')[0] as { name: string }).name).toBe(name)
    expect(dump(restored.sqlite, 'sessions')).toEqual([])
    expect(dump(restored.sqlite, 'challenges')).toEqual([])
    // Foreign keys hold in the copy
    expect(restored.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('restoring over a database replaces what was there', async () => {
    const { db, sqlite } = seeded()
    const bucket = new FakeBucket()
    const { key } = await writeBackup(db, asBucket(bucket), NOW)
    // After the backup: someone new, and a meeting gone
    sqlite.prepare('INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)').run('new', 'N', 3)
    sqlite.prepare('DELETE FROM meetings').run()
    sqlite.exec(restoreSql(parseBackup(gunzipSync(bucket.objects.get(key)!.bytes).toString('utf8'))))
    expect(dump(sqlite, 'accounts')).toHaveLength(2)
    expect(dump(sqlite, 'meetings')).toHaveLength(1)
    // Sessions go with their accounts: everyone signs in again
    expect(dump(sqlite, 'sessions')).toEqual([])
  })

  it('refuses a file that is not whole', () => {
    const text = backupLines(1, { accounts: [{ id: 'a', name: 'A', created_at: 1 }] })
    expect(parseBackup(text).tables.accounts).toHaveLength(1)
    const lines = text.trim().split('\n')
    expect(() => parseBackup(lines.slice(0, -1).join('\n'))).toThrow('cut off')
    expect(() => parseBackup([lines[0], lines[2]].join('\n'))).toThrow('cut off')
    expect(() => parseBackup('{"format":"other","version":1}')).toThrow('not a LongTalk')
    expect(() => parseBackup('')).toThrow('not a LongTalk')
  })

  it('refuses names that could not come from us', () => {
    expect(() => restoreSql({ at: 0, tables: { 'x; DROP': [] } })).toThrow('strange table')
    expect(() =>
      restoreSql({ at: 0, tables: { accounts: [{ 'id) --': 'a' }] } }),
    ).toThrow('strange column')
  })
})
