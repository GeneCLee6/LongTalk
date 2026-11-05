import { DatabaseSync } from 'node:sqlite'
import accounts from '../../migrations/0001_accounts.sql?raw'
import meetings from '../../migrations/0002_meetings.sql?raw'

// A D1 stand-in on Node's SQLite (I2): the real migrations, the real SQL, so the account tests run
// what production runs. Only what worker/account-db.ts calls: prepare/bind/first/all/run and
// batch (one transaction, like D1's).

/** Every migration, in order (wrangler applies them the same way) */
export const MIGRATIONS = [accounts, meetings]

type Params = unknown[]

export function fakeD1(migrations = MIGRATIONS): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const sql of migrations) sqlite.exec(sql)
  const statement = (sql: string, params: Params = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values.map((v) => (v === undefined ? null : v))),
    first: async <T>(column?: string): Promise<T | null> => {
      const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined
      if (!row) return null
      return (column ? row[column] : { ...row }) as T
    },
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...params).map((row) => ({ ...(row as object) })) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const { changes } = sqlite.prepare(sql).run(...params)
      return { success: true, meta: { changes: Number(changes) } }
    },
  })
  type Statement = ReturnType<typeof statement>
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        // Like D1, a batch's reads answer with their rows
        for (const s of statements) {
          results.push(/^\s*SELECT/i.test(s.sql) ? await s.all() : await s.run())
        }
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db: db as unknown as D1Database, sqlite }
}
