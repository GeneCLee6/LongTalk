// I6 (e11-t07, AC-11.8): the privacy page. Its numbers come from the code's constants; the pins
// below fail when a constant changes, so whoever changes one rereads the policy's wording too.
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_SECURITY_POLICY } from '../../shared/security-headers.ts'
import { PRIVACY_CONTACT, SOURCE_URL } from '../../shared/privacy.ts'
import { HomePage } from '../../src/pages/HomePage.tsx'
import PrivacyPage from '../../src/pages/PrivacyPage.tsx'
import {
  APP_CACHES,
  COOKIE_NAME,
  FACTS,
  LOCAL_STORAGE_KEYS,
  RECORDINGS_DATABASE,
  SESSION_STORAGE_KEYS,
} from '../../src/privacy/facts.ts'
import { policy as en } from '../../src/privacy/policy.en.ts'
import { policy as zh } from '../../src/privacy/policy.zh-TW.ts'
import { SECTION_IDS, type PolicyDocument } from '../../src/privacy/types.ts'
import { dictionary, setLocale } from '../../src/strings.ts'

// Node's fs without @types/node in this tsconfig (like tests/app/security.test.ts)
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }
).process.getBuiltinModule('node:fs') as {
  readFileSync(path: string, enc: 'utf8'): string
  readdirSync(path: string): string[]
  statSync(path: string): { isDirectory(): boolean }
}

const docs: [string, PolicyDocument][] = [
  ['zh-TW', zh(FACTS)],
  ['en', en(FACTS)],
]

const tables = (doc: PolicyDocument) =>
  doc.sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.kind === 'table' ? [block] : [])),
  )

afterEach(() => {
  cleanup()
  setLocale('zh-TW', false)
})

describe('the retention numbers', () => {
  // Changed a constant? Reread src/privacy/policy.*.ts (the sentence may no longer be true: "an
  // hourly job", "the next visit"), then update the pin here and POLICY_UPDATED.
  it('are pinned: a changed constant fails until the policy is reread', () => {
    expect(FACTS).toEqual({
      chatMessages: 200,
      emptyRoomMinutes: 10,
      reconnectSeconds: 60,
      banMinutes: 10,
      denySeconds: 60,
      waitingMinutes: 15,
      guessMinutes: 10,
      consentSeconds: 60,
      fileHours: 24,
      fileGoneHours: 25,
      backupDays: 7,
      sessionIdleDays: 30,
      sessionMaxDays: 90,
      challengeMinutes: 5,
      meetingDays: 90,
      telemetryDays: 90,
      telemetryHours: 48,
      errorSamples: 20,
      networkCountHours: 24,
      blockMaxDays: 30,
      offenders: 50,
      recordingKeepMinutes: 5,
      cloudflareLogDays: 3,
      cloudflareD1RecoveryDays: 7,
      cloudflareRoomRecoveryDays: 30,
    })
    expect(COOKIE_NAME).toBe('__Host-lt_session')
  })

  it.each(docs)('every number reaches the page, not a copy typed in (%s)', (name) => {
    const write = name === 'en' ? en : zh
    for (const key of Object.keys(FACTS) as (keyof typeof FACTS)[]) {
      const text = JSON.stringify(write({ ...FACTS, [key]: 98765 }))
      expect(text, key).toContain('98765')
    }
  })
})

describe('the two languages', () => {
  it('have the same sections, in the order the page lists them', () => {
    for (const [, doc] of docs) {
      expect(doc.sections.map((section) => section.id)).toEqual([...SECTION_IDS])
    }
  })

  it('have the same blocks, tables and rows', () => {
    const shape = (doc: PolicyDocument) =>
      doc.sections.map((section) =>
        section.blocks.map((block) =>
          block.kind === 'table'
            ? { columns: block.columns.length, rows: block.rows.map((row) => row.key) }
            : block.kind === 'list'
              ? block.items.length
              : block.kind,
        ),
      )
    expect(shape(docs[1][1])).toEqual(shape(docs[0][1]))
    for (const [, doc] of docs) {
      for (const table of tables(doc)) {
        for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length)
      }
    }
  })

  it('English has no Chinese in it, and the product name stays English', () => {
    expect(JSON.stringify(docs[1][1])).not.toMatch(/[　-〿㐀-鿿＀-￯]/)
    expect(JSON.stringify(docs[0][1])).toContain('LongTalk')
  })
})

describe('what the page must not say', () => {
  it.each(docs)('claims no compliance, certification, company or age limit (%s)', (_, doc) => {
    // The one sentence that says it makes no such claim
    const text = JSON.stringify(doc).replace('不表示 LongTalk 符合任何特定的法律、標準或認證', '')
    expect(text).not.toMatch(
      /GDPR|Privacy Act|個資法|個人資料保護法|compliant|complies|certified|認證通過|符合/i,
    )
    expect(text).not.toMatch(/Pty|Ltd|Inc\.|有限公司|ABN/)
    expect(text).not.toMatch(/\b(13|16|18) ?(years|歲)|years old|未滿/)
    // No email address anywhere: where to write comes only from PRIVACY_CONTACT
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
    expect(text).not.toContain(PRIVACY_CONTACT.url)
  })

  it.each(docs)('says what it is, and links the notices and the account page (%s)', (_, doc) => {
    const text = JSON.stringify(doc)
    expect(text).toContain('/third-party-notices.txt')
    expect(text).toContain('/me')
    expect(text).toContain(SOURCE_URL)
    expect(text).toContain('localStorage')
    expect(text).toContain('sessionStorage')
    expect(text).toContain(COOKIE_NAME)
    expect(text).toContain(RECORDINGS_DATABASE)
    expect(text).toContain(APP_CACHES)
  })
})

describe('what the page lists against the code', () => {
  function sources(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`
      return fs.statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
    })
  }

  it('lists every storage key the app uses', () => {
    const found = new Set<string>()
    for (const file of sources('src')) {
      if (file.startsWith('src/privacy/')) continue
      const code = fs.readFileSync(file, 'utf8')
      for (const match of code.matchAll(/['"`](longtalk[.:][A-Za-z.:]+)(\$\{[^}]*\})?/g)) {
        found.add(match[2] ? `${match[1]}<room>` : match[1])
      }
    }
    // A Web Lock's name (src/record/store.ts lockName): not storage
    found.delete('longtalk.recording.<room>')
    expect([...found].sort()).toEqual([...LOCAL_STORAGE_KEYS, ...SESSION_STORAGE_KEYS].sort())
  })

  it('names the IndexedDB database and the caches the code uses', () => {
    expect(fs.readFileSync('src/record/store.ts', 'utf8')).toContain(`'${RECORDINGS_DATABASE}'`)
    const routing = fs.readFileSync('src/pwa/swRouting.ts', 'utf8')
    expect(routing).toContain(`CACHE_PREFIX = 'longtalk-shell-'`)
    expect(routing).toContain(`META_CACHE = 'longtalk-meta'`)
  })

  it('"no trackers": pages may connect only to LongTalk and load only Turnstile from outside', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'")
    const hosts = new Set(CONTENT_SECURITY_POLICY.match(/https:\/\/[^\s;]+/g) ?? [])
    expect([...hosts]).toEqual(['https://challenges.cloudflare.com'])
  })
})

describe('the page', () => {
  const renderPage = () =>
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    )

  it('shows the policy with its retention table, contact and links', async () => {
    renderPage()
    const text = dictionary('zh-TW')
    expect(await screen.findByRole('heading', { level: 1, name: text.privacy.link })).toBeVisible()
    const retention = screen.getByRole('table', { name: '資料保留表' })
    expect(within(retention).getByRole('row', { name: /每日備份/ })).toHaveTextContent('7 天')
    const contact = screen.getByRole('link', { name: '開啟 LongTalk 的聯絡頁面' })
    expect(contact).toHaveAttribute('href', PRIVACY_CONTACT.url)
    expect(screen.getByRole('note')).toHaveTextContent('公開')
    expect(screen.getByRole('link', { name: '第三方授權聲明' })).toHaveAttribute(
      'href',
      '/third-party-notices.txt',
    )
    expect(screen.getByRole('link', { name: '在你的帳號頁面' })).toHaveAttribute('href', '/me')
  })

  it('is linked from the home page footer', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: dictionary('zh-TW').privacy.link })).toHaveAttribute(
      'href',
      '/privacy',
    )
  })

  it('follows the language, English included', async () => {
    setLocale('en', false)
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible()
    expect(screen.getByRole('table', { name: 'Data retention' })).toBeVisible()
  })

  it('drops the public warning when the contact is private', async () => {
    vi.resetModules()
    vi.doMock('../../shared/privacy.ts', async (original) => ({
      ...(await original<typeof import('../../shared/privacy.ts')>()),
      PRIVACY_CONTACT: { url: 'https://example.org/ask', isPublic: false },
    }))
    const { default: Page } = await import('../../src/pages/PrivacyPage.tsx')
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: '開啟 LongTalk 的聯絡頁面' })
    expect(link).toHaveAttribute('href', 'https://example.org/ask')
    expect(screen.queryByRole('note')).toBeNull()
    vi.doUnmock('../../shared/privacy.ts')
    vi.resetModules()
  })
})
