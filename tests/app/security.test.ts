import { describe, expect, it } from 'vitest'
import { PAGE_HEADERS } from '../../shared/security-headers.ts'
import { scan, withoutComments } from '../../scripts/secretScan.ts'

// I1 (e11-t06): public/_headers matches the policy in code, and the secrets lint catches what it
// should (scripts/secrets.ts runs it over src/, public/ and the built client)

// Node's fs without @types/node in this tsconfig
const node = (
  globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }
).process
const fs = node.getBuiltinModule('node:fs') as { readFileSync(path: string, enc: 'utf8'): string }

describe('security headers', () => {
  it('public/_headers gives every path exactly PAGE_HEADERS', () => {
    const file = fs.readFileSync('public/_headers', 'utf8')
    const block = file.slice(file.indexOf('\n/*\n') + 4)
    const lines = block
      .split('\n')
      .filter((line: string) => line.startsWith('  '))
      .map((line: string) => line.trim())
    expect(lines).toEqual(Object.entries(PAGE_HEADERS).map(([name, value]) => `${name}: ${value}`))
  })

})

describe('secrets lint', () => {
  it('finds secret names in code but not in comments', () => {
    expect(scan('a.ts', withoutComments('const x = env.REALTIME_APP_SECRET'))).toHaveLength(1)
    expect(scan('a.ts', withoutComments('// reads ADMIN_TOKEN in the Worker only'))).toEqual([])
    expect(scan('a.ts', 'const ADMIN_TOKEN = 1 // secret-ok: documented exception')).toEqual([])
  })

  it('finds secret-shaped values', () => {
    const samples = [
      '-----BEGIN PRIVATE KEY-----',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'ghp_' + 'a'.repeat(36),
      'sk-ant-' + 'a'.repeat(30),
      '1x' + '0'.repeat(31) + 'AA',
      '0x4AAAAAAA' + 'b'.repeat(25),
      `apiKey: '${'Z'.repeat(32)}'`,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.x',
    ]
    for (const sample of samples) expect(scan('a.js', sample), sample).toHaveLength(1)
  })

  it('leaves public values alone: site keys, session-token shapes, hashes in names', () => {
    for (const sample of [
      "const siteKey = '1x00000000000000000000BB'",
      "assets/index-bHfutsff.js",
      "token: 'abc'",
      "const passwordLabel = strings.admin.tokenLabel",
    ]) {
      expect(scan('a.js', sample), sample).toEqual([])
    }
  })
})
