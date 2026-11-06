import { useSyncExternalStore } from 'react'
import { enHome } from './i18n/en.home.ts'
import { mergeDictionaries } from './i18n/merge.ts'
import type { HomeStrings, RoomStrings, Strings } from './i18n/types.ts'
import { zhTWHome } from './i18n/zh-TW.home.ts'

// The only place interface text comes from (CLAUDE.md rule 5). Two dictionaries with the same
// keys (G1, e4-t15): Traditional Chinese (Taiwan), the default, and English; `Strings` is derived
// from the Chinese one, so a key missing from (or extra in) the English one is a type error. The
// product name is English only in both.
//
// Each language comes in two parts (J4, RULES.md §1), because a dictionary is the largest thing a
// home page would otherwise load and has no use for: i18n/*.home.ts, the few keys the first load
// reads, are here for both languages, so the page starts at once in either with nothing to wait
// for and nothing to flash; i18n/zh-TW.ts and en.ts, everything else, are a chunk per language. The
// lazy pages ask for theirs through `withDictionary` (App.tsx), so they only render once it is
// there. What the first load may read is checked: tests/app/dictionarySplit.test.ts.
//
// `strings` is the active dictionary, a live binding: `strings.room.title(id)` always reads the
// language chosen now. So never keep a piece of it at module level (`const text = strings.room`
// would freeze the language the page started in): read `strings.…` where the text is used.
// Switching language re-renders from <App> down (App calls useLocale), without remounting, so a
// call in progress keeps going.

export type { Strings } from './i18n/types.ts'

export type Locale = 'zh-TW' | 'en'

/** In the order the language menus list them */
export const LOCALES: readonly Locale[] = ['zh-TW', 'en']

const HOME: Record<Locale, HomeStrings> = { 'zh-TW': zhTWHome, en: enHome }

const LOADERS: Record<Locale, () => Promise<RoomStrings>> = {
  'zh-TW': () => import('./i18n/zh-TW.ts').then((module) => module.zhTWRoom),
  en: () => import('./i18n/en.ts').then((module) => module.enRoom),
}

/** The chunks that have arrived */
const rests: Partial<Record<Locale, RoomStrings>> = {}
/** And those on their way, so two pages asking fetch one */
const loading: Partial<Record<Locale, Promise<RoomStrings>>> = {}
/** A page reading the whole dictionary has opened: a language now only changes once it is whole */
let wholeWanted = false

/** <html lang> per locale (index.html starts as zh-Hant-TW) */
const HTML_LANG: Record<Locale, string> = { 'zh-TW': 'zh-Hant-TW', en: 'en' }

const LOCALE_KEY = 'longtalk.locale'

export const isLocale = (value: unknown): value is Locale => value === 'zh-TW' || value === 'en'

/**
 * The language to start in: the one chosen before (remembered in localStorage); otherwise
 * Chinese when any of the browser's languages is Chinese (zh, zh-TW, zh-Hant-HK, zh-CN…) or when
 * the browser says nothing, and English when its languages are all something else. LongTalk is
 * Chinese first (CLAUDE.md): only a browser that clearly does not read Chinese starts in English.
 */
export function pickLocale(saved: string | null, languages: readonly string[]): Locale {
  if (isLocale(saved)) return saved
  const named = languages.filter((language) => language.trim() !== '')
  if (named.length === 0) return 'zh-TW'
  return named.some((language) => /^zh(-|_|$)/i.test(language)) ? 'zh-TW' : 'en'
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages?.length) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

function readSaved(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_KEY) ?? null
  } catch {
    return null
  }
}

function save(which: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_KEY, which)
  } catch {
    // Storage blocked: the choice lasts for this page only
  }
}

/**
 * What is known of a language. Until its chunk has arrived that is the home part alone, which is
 * all the first load reads: the type stays `Strings` so nothing else has to know about the parts
 */
function dictionaryOf(which: Locale): Strings {
  const rest = rests[which]
  return rest ? mergeDictionaries(HOME[which], rest) : (HOME[which] as Strings)
}

let locale: Locale = pickLocale(readSaved(), browserLanguages())
/** The language asked for last: its chunk may still be on its way */
let wanted: Locale = locale

/** The active dictionary (see above: read it where the text is used, never keep a piece) */
export let strings: Strings = dictionaryOf(locale)

const listeners = new Set<() => void>()

function applyHtmlLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[locale]
}
applyHtmlLang()

export const getLocale = (): Locale => locale

/** One locale's dictionary, as far as it has arrived (tests load both whole: installDictionaries) */
export const dictionary = (which: Locale): Strings => dictionaryOf(which)

/** A language's chunk, once */
function loadRest(which: Locale): Promise<RoomStrings> {
  const started = loading[which]
  if (started) return started
  const load = LOADERS[which]().then(
    (rest) => {
      rests[which] = rest
      if (which === locale) strings = dictionaryOf(which)
      return rest
    },
    (error: unknown) => {
      // Tried again the next time someone asks
      delete loading[which]
      throw error
    },
  )
  loading[which] = load
  return load
}

/**
 * Whole dictionaries put in place without loading anything: tests and only tests, where every
 * test reads every key and switches language synchronously (tests/setupStrings.ts)
 */
export function installDictionaries(all: Record<Locale, RoomStrings>): void {
  Object.assign(rests, all)
  strings = dictionaryOf(locale)
}

function applyLocale(next: Locale): void {
  if (next === locale) return
  locale = next
  strings = dictionaryOf(next)
  applyHtmlLang()
  for (const listener of listeners) listener()
}

/**
 * Switches the language: the dictionary, <html lang>, and every component on screen (through
 * useLocale in App). On the home page that is at once; on a page that reads the rest of the
 * dictionary, the moment the other language's chunk is here, and the screen stays as it is until
 * then: nothing remounts, and a call in progress carries on. Should the chunk not come (offline,
 * and never cached), the language stays. `remember: false` leaves localStorage alone (tests).
 */
export function setLocale(next: Locale, remember = true): void {
  if (remember) save(next)
  wanted = next
  if (next === locale) return
  if (!wholeWanted || rests[next]) {
    applyLocale(next)
    return
  }
  void loadRest(next).then(
    () => {
      if (wanted === next) applyLocale(next)
    },
    () => {
      if (wanted === next) wanted = locale
    },
  )
}

/**
 * Resolves when the whole dictionary of the language in use is here. A language chosen in the
 * meantime is waited for too. Rejects when the chunk cannot be loaded: the page's lazy() rejects
 * with it, and LoadFailed (its text is in the home part) offers to reload
 */
export async function loadDictionary(): Promise<void> {
  wholeWanted = true
  while (!rests[wanted]) await loadRest(wanted)
  applyLocale(wanted)
}

/** For lazy(): the page's code and the text it reads arrive together, so nothing flashes */
export function withDictionary<T>(load: () => Promise<T>): () => Promise<T> {
  return async () => {
    const [page] = await Promise.all([load(), loadDictionary()])
    return page
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The active locale; the component re-renders when it changes */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

/**
 * The BCP 47 tag dates and times are formatted with: zh-TW, or for English the browser's own
 * English (en-AU, en-US…) so day and month come in the order the person is used to; en-GB when
 * the browser names no regional English.
 */
export function intlLocale(
  which: Locale = locale,
  languages: readonly string[] = browserLanguages(),
): string {
  if (which === 'zh-TW') return 'zh-TW'
  const english = languages.find((language) => /^en(-|$)/i.test(language))
  if (!english || english.toLowerCase() === 'en') return 'en-GB'
  try {
    return Intl.getCanonicalLocales(english)[0] ?? 'en-GB'
  } catch {
    return 'en-GB'
  }
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = intlLocale()
  const id = `${tag}|${key}`
  let found = formats.get(id)
  if (!found) {
    found = new Intl.DateTimeFormat(tag, options)
    formats.set(id, found)
  }
  return found
}

/**
 * A time of day in the browser's time zone, as chat messages show it: 21:04 in Chinese (24-hour,
 * as before D3 had it); the English locale's own clock otherwise (9:04 pm in en-AU)
 */
export function formatClock(at: number | Date): string {
  return locale === 'zh-TW'
    ? format('clock', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
    : format('clock', { hour: 'numeric', minute: '2-digit' }).format(at)
}

/** A date and time (the /admin page): 2026/11/3 21:04:05; 3 Nov 2026, 9:04:05 pm */
export function formatDateTime(at: number | Date): string {
  return locale === 'zh-TW'
    ? format('datetime', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(at)
    : format('datetime', { dateStyle: 'medium', timeStyle: 'medium' }).format(at)
}

/** A day written YYYY-MM-DD (UTC), as /admin's daily table shows it: 11/3（週二）; Tue 3 Nov */
export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return day
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return format('day', {
    timeZone: 'UTC',
    year: 'numeric',
    month: locale === 'zh-TW' ? 'numeric' : 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(at)
}

/** The browser's own IANA time zone (UTC when it names none) */
export function browserTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A scheduled meeting's day in `timeZone` (the browser's when left out): 2026年11月10日 週二; Tue 10 Nov 2026 */
export function formatMeetingDate(at: number, timeZone?: string): string {
  return format(`meetingDate|${timeZone ?? ''}`, {
    timeZone,
    year: 'numeric',
    month: locale === 'zh-TW' ? 'long' : 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(at)
}

/** A scheduled meeting's time of day in `timeZone`: 14:00; 2:00 pm */
export function formatMeetingClock(at: number, timeZone?: string): string {
  return locale === 'zh-TW'
    ? format(`meetingClock|${timeZone ?? ''}`, {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at)
    : format(`meetingClock|${timeZone ?? ''}`, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
}

/**
 * A time zone as people read it at `at` (daylight saving included): its name in the current
 * language and its offset, e.g. 澳洲東部時間 and GMT+11. The IANA id stands in for a name the
 * runtime does not have
 */
export function formatZone(at: number, timeZone?: string): { name: string; offset: string } {
  const zone = timeZone ?? browserTimeZone()
  const part = (style: 'longGeneric' | 'shortOffset') => {
    try {
      return format(`zone|${style}|${zone}`, { timeZone: zone, timeZoneName: style })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value
    } catch {
      return undefined
    }
  }
  const offset = part('shortOffset') ?? zone
  const name = part('longGeneric')
  return { name: name && name !== offset ? name : zone, offset }
}
