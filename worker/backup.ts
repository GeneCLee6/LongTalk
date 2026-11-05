import { backupLines, type Backup, type BackupRow } from '../shared/backup.ts'
import { BACKUP_PREFIX, backupExpired, backupKey, type FilesStatus } from '../shared/files.ts'

// The daily D1 backup to R2 (I5, e11-t08). A Worker cannot call D1's export through the binding, so
// it reads the tables itself: one `batch` (one transaction, so foreign keys hold in the copy) into
// gzipped JSON lines (the format: shared/backup.ts). DEPLOY.md §12 has the procedure.

/** What is backed up, parents before children: the order to insert them in */
export const BACKUP_TABLES = ['accounts', 'credentials', 'rooms', 'meetings'] as const

/**
 * What is left out on purpose. `sessions` only holds SHA-256 hashes, so a copy signs nobody in
 * (worker/session.ts), but nothing needs them after a disaster: everyone signs in again with a
 * passkey. `challenges` live five minutes. A test fails when a migration adds a table that is in
 * neither list, so somebody decides.
 */
export const BACKUP_EXCLUDED = ['sessions', 'challenges'] as const

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/**
 * Today's backup to `bucket` (`d1/<day>.jsonl.gz`, written again if the day already has one), then
 * days past BACKUP_RETENTION_DAYS deleted. Answers what /admin shows of it.
 */
export async function writeBackup(
  db: Pick<D1Database, 'prepare' | 'batch'>,
  bucket: Pick<R2Bucket, 'put' | 'list' | 'delete'>,
  now: number,
): Promise<NonNullable<FilesStatus['backup']>> {
  const results = await db.batch<BackupRow>(
    BACKUP_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`)),
  )
  const tables: Backup['tables'] = {}
  let rows = 0
  BACKUP_TABLES.forEach((table, index) => {
    const list = results[index].results ?? []
    tables[table] = list
    rows += list.length
  })
  const body = await gzip(backupLines(now, tables))
  const key = backupKey(now)
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { rows: String(rows) },
  })
  const old: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor })
    for (const object of page.objects) if (backupExpired(object.key, now)) old.push(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  if (old.length > 0) await bucket.delete(old)
  return { at: now, key, bytes: body.byteLength, rows }
}
