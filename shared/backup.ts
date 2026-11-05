// The D1 backup's format (I5, e11-t08), and turning a backup back into SQL: the Worker writes it
// (worker/backup.ts), and the restore script (scripts/restore-backup.ts) and the restore drill
// (tests/worker/backup.test.ts) run the same code.
//
//   {"format":"longtalk-d1-backup","version":1,"at":<ms>,"tables":["accounts",…]}
//   {"t":"accounts","r":{"id":"…","name":"…","created_at":…}}
//   …
//   {"end":true,"rows":{"accounts":1,…}}

export const BACKUP_FORMAT = 'longtalk-d1-backup'

export type BackupRow = Record<string, string | number | null>

export type Backup = {
  at: number
  /** Table name → rows, in BACKUP_TABLES order */
  tables: Record<string, BackupRow[]>
}

/** One row per line; the header and the footer make a cut-off file detectable */
export function backupLines(at: number, tables: Backup['tables']): string {
  const lines = [
    JSON.stringify({ format: BACKUP_FORMAT, version: 1, at, tables: Object.keys(tables) }),
  ]
  const rows: Record<string, number> = {}
  for (const [table, list] of Object.entries(tables)) {
    rows[table] = list.length
    for (const row of list) lines.push(JSON.stringify({ t: table, r: row }))
  }
  lines.push(JSON.stringify({ end: true, rows }))
  return `${lines.join('\n')}\n`
}

/** A backup's text back as rows; throws on anything but a whole file of this format */
export function parseBackup(text: string): Backup {
  const lines = text.split('\n').filter((line) => line !== '')
  const header = JSON.parse(lines[0] ?? 'null') as {
    format?: string
    version?: number
    at?: number
    tables?: string[]
  } | null
  if (header?.format !== BACKUP_FORMAT || header.version !== 1 || !Array.isArray(header.tables)) {
    throw new Error('not a LongTalk D1 backup')
  }
  const tables: Backup['tables'] = {}
  for (const table of header.tables) tables[table] = []
  let footer: Record<string, number> | null = null
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as {
      t?: string
      r?: BackupRow
      end?: boolean
      rows?: Record<string, number>
    }
    if (entry.end && entry.rows) footer = entry.rows
    else if (entry.t && entry.r && tables[entry.t]) tables[entry.t].push(entry.r)
    else throw new Error(`unexpected line in the backup: ${line.slice(0, 80)}`)
  }
  if (!footer) throw new Error('the backup is cut off: no end line')
  for (const [table, count] of Object.entries(footer)) {
    if (tables[table]?.length !== count) {
      throw new Error(`the backup is cut off: ${table} has ${tables[table]?.length}, not ${count}`)
    }
  }
  return { at: header.at ?? 0, tables }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function sqlValue(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('a number that SQL cannot hold')
    return String(value)
  }
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new Error(`a value of an unexpected type: ${typeof value}`)
}

/**
 * SQL that makes a migrated database hold exactly the backup: empties the backed-up tables
 * (children first; sessions go with their accounts), then inserts, parents first. For
 * `wrangler d1 execute <db> --file`.
 */
export function restoreSql(backup: Backup): string {
  const tables = Object.keys(backup.tables)
  const lines: string[] = []
  for (const table of [...tables].reverse()) {
    if (!IDENTIFIER.test(table)) throw new Error(`a strange table name: ${table}`)
    lines.push(`DELETE FROM ${table};`)
  }
  for (const table of tables) {
    for (const row of backup.tables[table]) {
      const columns = Object.keys(row)
      for (const column of columns) {
        if (!IDENTIFIER.test(column)) throw new Error(`a strange column name: ${column}`)
      }
      lines.push(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
          .map((column) => sqlValue(row[column]))
          .join(', ')});`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}
