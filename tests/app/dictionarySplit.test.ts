// J4 (RULES.md §1): each language's dictionary is two parts, so the home page's first load carries
// only what it reads. Nothing but this test stops someone using a key from the rest in something the
// first load runs (the type cannot tell), which would be `undefined` only on the real site.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enHome } from '../../src/i18n/en.home.ts'
import { en, enRoom } from '../../src/i18n/en.ts'
import { mergeDictionaries } from '../../src/i18n/merge.ts'
import { zhTWHome } from '../../src/i18n/zh-TW.home.ts'
import { zhTW, zhTWRoom } from '../../src/i18n/zh-TW.ts'

// Node's fs and path without @types/node in this tsconfig (like tests/app/security.test.ts)
const builtin = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } })
  .process
const fs = builtin.getBuiltinModule('node:fs') as { readFileSync(path: string, enc: 'utf8'): string }
const path = builtin.getBuiltinModule('node:path') as {
  dirname(p: string): string
  join(...parts: string[]): string
}

type Dict = Record<string, unknown>

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The files that run in the first load, and what else they load without waiting for a dictionary */
function firstLoad(): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    const source = stripComments(fs.readFileSync(file, 'utf8'))
    files.set(file, source)
    const here = path.dirname(file)
    for (const match of source.matchAll(
      /^(?:import|export)\s+(?!type\b)(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm,
    )) {
      visit(path.join(here, match[1]))
    }
    // A chunk loaded lazily from here runs before any dictionary too, unless it asks for one. The
    // dictionaries themselves are what is being split
    for (const match of source.matchAll(/(withDictionary\(\(\) => )?import\(['"](\.[^'"]+)['"]\)/g)) {
      if (match[1] || match[2].includes('/i18n/')) continue
      visit(path.join(here, match[2]))
    }
  }
  visit('src/main.tsx')
  return files
}

describe('what the first load reads', () => {
  it('every strings.x.y it uses is in the home part of the dictionary', () => {
    const home = zhTWHome as unknown as Dict
    const rest = zhTWRoom as unknown as Dict
    const bad: string[] = []
    for (const [file, source] of firstLoad()) {
      for (const [, section, key] of source.matchAll(/\bstrings\.(\w+)(?:\.(\w+))?/g)) {
        if (section === 'ts') continue // the import's path
        const part = home[section]
        if (part === undefined) {
          bad.push(`${file}: strings.${section}${key ? `.${key}` : ''}`)
        } else if (typeof part === 'object' && key === undefined && section in rest) {
          // The whole section kept in a variable, and only part of it is here
          bad.push(`${file}: strings.${section} is split between the parts`)
        } else if (typeof part === 'object' && key !== undefined && !(key in (part as Dict))) {
          bad.push(`${file}: strings.${section}.${key}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('finds the home page and more, so the check above checks something', () => {
    const files = [...firstLoad().keys()].map((file) => file.replaceAll('\\', '/'))
    expect(files).toContain('src/pages/HomePage.tsx')
    expect(files).toContain('src/components/LoadFailed.tsx')
    expect(files).toContain('src/components/LanguageSelect.tsx')
    expect(files).not.toContain('src/pages/RoomPage.tsx')
    expect(files).not.toContain('src/pages/MePage.tsx')
  })

  it('no page but the first load is opened without its dictionary', () => {
    const app = stripComments(fs.readFileSync('src/App.tsx', 'utf8'))
    const lazies = [...app.matchAll(/lazy\((.*)\)$/gm)].map((match) => match[1])
    expect(lazies.length).toBeGreaterThanOrEqual(5)
    for (const lazy of lazies) expect(lazy).toContain('withDictionary(')
  })
})

describe('the parts', () => {
  const keysOf = (dict: unknown, prefix = ''): string[] =>
    Object.entries(dict as Dict).flatMap(([key, value]) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? keysOf(value, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )

  it('a key is in one part or the other, never both, in either language', () => {
    for (const [home, rest] of [
      [zhTWHome, zhTWRoom],
      [enHome, enRoom],
    ] as const) {
      const here = new Set(keysOf(home))
      expect(keysOf(rest).filter((key) => here.has(key))).toEqual([])
    }
  })

  it('the home parts have the same keys in both languages', () => {
    expect(keysOf(enHome).sort()).toEqual(keysOf(zhTWHome).sort())
  })

  it('whole dictionaries have both parts, sections that are split included', () => {
    expect(zhTW.account.homeLink).toBe(zhTWHome.account.homeLink)
    expect(zhTW.account.deleteAccount).toBe(zhTWRoom.account.deleteAccount)
    expect(en.record.leftoverDelete).toBe(enHome.record.leftoverDelete)
    expect(en.record.start).toBe(enRoom.record.start)
    expect(keysOf(en).sort()).toEqual(keysOf(zhTW).sort())
  })

  it('merging leaves its inputs alone', () => {
    const home = { a: { x: 1 } }
    const rest = { a: { y: 2 }, b: 3 }
    expect(mergeDictionaries(home, rest)).toEqual({ a: { x: 1, y: 2 }, b: 3 })
    expect(home).toEqual({ a: { x: 1 } })
  })
})

describe('in a browser, with nothing installed', () => {
  afterEach(() => {
    vi.doUnmock('../../src/i18n/en.ts')
    vi.resetModules()
    localStorage.clear()
  })

  /** src/strings.ts as a page starts it: tests/setupStrings.ts did not run on this copy */
  async function fresh() {
    vi.resetModules()
    return import('../../src/strings.ts')
  }

  it('starts with the home text at once, in either language, and nothing else yet', async () => {
    const module = await fresh()
    expect(module.strings.home.createRoom).toBe(zhTWHome.home.createRoom)
    expect(module.strings.prejoin).toBeUndefined()
    let notified = 0
    module.subscribeLocale(() => (notified += 1))
    // On the home page a language is at once: no chunk to wait for, nothing flashes
    module.setLocale('en', false)
    expect(notified).toBe(1)
    expect(module.getLocale()).toBe('en')
    expect(module.strings.home.createRoom).toBe(enHome.home.createRoom)
    expect(document.documentElement.lang).toBe('en')
    module.setLocale('zh-TW', false)
  })

  it('a lazy page can be evaluated before its text is here: nothing reads it at module level', async () => {
    // withDictionary loads the two side by side, and a page's code may well come first. A table of
    // strings at module level would throw here (and freeze the language besides: RULES.md §1)
    vi.resetModules()
    for (const load of [
      () => import('../../src/pages/AdminPage.tsx'),
      () => import('../../src/pages/MePage.tsx'),
      () => import('../../src/pages/MeetingPage.tsx'),
      () => import('../../src/pages/PrivacyPage.tsx'),
      () => import('../../src/pages/RoomPage.tsx'),
    ]) {
      await expect(load()).resolves.toBeDefined()
    }
    const module = await import('../../src/strings.ts')
    expect(module.strings.admin).toBeUndefined()
  }, 60_000)

  it('a lazy page renders only when its text has arrived with its code', async () => {
    const module = await fresh()
    let textWhenLoaded: unknown
    const load = module.withDictionary(async () => 'page')
    const page = await load().then((value) => {
      textWhenLoaded = module.strings.prejoin.title
      return value
    })
    expect(page).toBe('page')
    expect(textWhenLoaded).toBe(zhTWRoom.prejoin.title)
    // The home part is still there, sections in both parts whole
    expect(module.strings.home.createRoom).toBe(zhTWHome.home.createRoom)
    expect(module.strings.account.homeLink).toBe(zhTWHome.account.homeLink)
    expect(module.strings.account.deleteAccount).toBe(zhTWRoom.account.deleteAccount)
  })

  it('in a room, a language changes only once all of it is here, with no remount in between', async () => {
    const module = await fresh()
    await module.loadDictionary()
    let notified = 0
    module.subscribeLocale(() => (notified += 1))
    module.setLocale('en', false)
    // The screen stays Chinese and whole until the chunk arrives
    expect(notified).toBe(0)
    expect(module.getLocale()).toBe('zh-TW')
    expect(module.strings.prejoin.title).toBe(zhTWRoom.prejoin.title)
    await vi.waitFor(() => expect(notified).toBe(1))
    expect(module.getLocale()).toBe('en')
    expect(module.strings.prejoin.title).toBe(enRoom.prejoin.title)
    // Back again: already here, so at once
    module.setLocale('zh-TW', false)
    expect(notified).toBe(2)
    expect(module.strings.prejoin.title).toBe(zhTWRoom.prejoin.title)
  })

  it('a language chosen while the page is loading is the one it opens in', async () => {
    const module = await fresh()
    const loading = module.loadDictionary()
    module.setLocale('en', false)
    await loading
    expect(module.getLocale()).toBe('en')
    expect(module.strings.prejoin.title).toBe(enRoom.prejoin.title)
  })

  it('the last of two quick choices wins', async () => {
    const module = await fresh()
    await module.loadDictionary()
    module.setLocale('en', false)
    module.setLocale('zh-TW', false)
    await vi.waitFor(() => expect(module.dictionary('en').prejoin).toBeDefined())
    expect(module.getLocale()).toBe('zh-TW')
  })

  it('a chunk that cannot be loaded leaves the language as it was, and can be tried again', async () => {
    const module = await fresh()
    await module.loadDictionary()
    vi.doMock('../../src/i18n/en.ts', () => {
      throw new Error('offline')
    })
    let notified = 0
    module.subscribeLocale(() => (notified += 1))
    module.setLocale('en', false)
    await vi.waitFor(() => expect(notified).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(module.getLocale()).toBe('zh-TW')
    expect(module.strings.prejoin.title).toBe(zhTWRoom.prejoin.title)
    vi.doUnmock('../../src/i18n/en.ts')
    module.setLocale('en', false)
    await vi.waitFor(() => expect(module.getLocale()).toBe('en'))
  })

  it('a page whose text cannot be loaded fails like a chunk that cannot be loaded', async () => {
    localStorage.setItem('longtalk.locale', 'en')
    vi.doMock('../../src/i18n/en.ts', () => {
      throw new Error('offline')
    })
    const module = await fresh()
    await expect(module.withDictionary(async () => 'page')()).rejects.toThrow()
    // LoadFailed still has what it needs
    expect(module.strings.loadFailed.reload).toBe(enHome.loadFailed.reload)
  })
})
