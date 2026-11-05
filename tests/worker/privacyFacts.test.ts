// I6 (e11-t07): what /privacy says about the deployment, checked against the deployment's own
// files. A failure here means the policy (src/privacy/policy.*.ts) needs rereading, not only this.
import { describe, expect, it } from 'vitest'
import { BACKUP_EXCLUDED, BACKUP_TABLES } from '../../worker/backup.ts'
import { GUESS_MEMORY_MS } from '../../worker/password.ts'
import { clearSessionCookie, sessionCookie, SESSION_COOKIE } from '../../worker/session.ts'
import { MAX_ERROR_SAMPLES, TELEMETRY_DAYS, TELEMETRY_HOURS } from '../../worker/telemetry.ts'

// Node's fs without @types/node in this tsconfig (like tests/app/security.test.ts)
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }
).process.getBuiltinModule('node:fs') as {
  readFileSync(path: string, enc: 'utf8'): string
  readdirSync(path: string): string[]
}

const wrangler = fs.readFileSync('wrangler.jsonc', 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

/** The production part of wrangler.jsonc (env.preview has its own bindings) */
const production = wrangler.slice(0, wrangler.indexOf('"env"'))

describe('what /privacy says about the deployment', () => {
  it('the worker reads the constants the page quotes', () => {
    expect(GUESS_MEMORY_MS).toBe(10 * 60_000)
    expect([TELEMETRY_DAYS, TELEMETRY_HOURS, MAX_ERROR_SAMPLES]).toEqual([90, 48, 20])
  })

  it('backups hold these tables, and leave out signed-in browsers and challenges', () => {
    expect(BACKUP_TABLES).toEqual(['accounts', 'credentials', 'rooms', 'meetings'])
    expect(BACKUP_EXCLUDED).toEqual(['sessions', 'challenges'])
  })

  it('the session cookie is the only cookie, HttpOnly, Secure and __Host-', () => {
    const cookie = sessionCookie('t', 2000, 1000)
    expect(cookie.startsWith(`${SESSION_COOKIE}=t;`)).toBe(true)
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true)
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      expect(cookie).toContain(attribute)
    }
    expect(clearSessionCookie()).toContain('Max-Age=0')
    // Nothing else in the Worker writes a Set-Cookie except through these two
    const setters = fs
      .readdirSync('worker')
      .filter((name) => fs.readFileSync(`worker/${name}`, 'utf8').match(/set-cookie'/i))
      .sort()
    expect(setters).toEqual(['accounts.ts', 'rooms.ts'])
  })

  it('Analytics Engine stays off, and Workers Logs stay on, as the policy says', () => {
    expect(production).not.toContain('analytics_engine_datasets')
    expect(production).toMatch(/"observability":\s*\{\s*"enabled":\s*true/)
  })

  it('no region is pinned for any data', () => {
    expect(production).not.toMatch(/jurisdiction|location_hint|locationHint/)
  })

  it('every store is one the policy describes: a new binding needs a new row', () => {
    const names = (pattern: RegExp) => [...production.matchAll(pattern)].map((m) => m[1]).sort()
    expect(names(/"class_name":\s*"(\w+)"/g)).toEqual([
      'FileLedgerDO',
      'GuardDO',
      'RoomDO',
      'TelemetryDO',
      'UsageDO',
    ])
    expect(names(/"bucket_name":\s*"([\w-]+)"/g)).toEqual(['longtalk-backups', 'longtalk-files'])
    expect(names(/"database_name":\s*"([\w-]+)"/g)).toEqual(['longtalk'])
  })
})
