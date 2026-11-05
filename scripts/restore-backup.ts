// Turns a D1 backup from R2 (I5, e11-t08; worker/backup.ts has the format) into SQL for
// `wrangler d1 execute`. DEPLOY.md §12 has the whole procedure; the restore drill in
// tests/worker/backup.test.ts runs the same code on every commit.
//
//   node scripts/restore-backup.ts 2026-11-05.jsonl.gz > restore.sql
//   npx wrangler d1 migrations apply longtalk --local
//   npx wrangler d1 execute longtalk --local --file restore.sql
//
// It prints how many rows each table has to stderr, and stops if the file is cut off.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseBackup, restoreSql } from '../shared/backup.ts'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/restore-backup.ts <backup.jsonl.gz> > restore.sql')
  process.exit(1)
}
const backup = parseBackup(gunzipSync(readFileSync(path)).toString('utf8'))
console.error(`Backup of ${new Date(backup.at).toISOString()}`)
for (const [table, rows] of Object.entries(backup.tables)) {
  console.error(`  ${table}: ${rows.length} rows`)
}
process.stdout.write(restoreSql(backup))
