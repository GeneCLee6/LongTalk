import { useSyncExternalStore } from 'react'
import { en } from './i18n/en.ts'
import type { Strings } from './i18n/types.ts'
import { zhTW } from './i18n/zh-TW.ts'

// The only place interface text comes from (CLAUDE.md rule 5). Two dictionaries with the same
// keys (G1, e4-t15): Traditional Chinese (Taiwan), the default, in i18n/zh-TW.ts, and English in
// i18n/en.ts; `Strings` is derived from the Chinese one, so a key missing from (or extra in) the
// English one is a type error. The product name is English only in both.
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

const DICTIONARIES: Record<Locale, Strings> = { 'zh-TW': zhTW, en }

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

let locale: Locale = pickLocale(readSaved(), browserLanguages())

/** The active dictionary (see above: read it where the text is used, never keep a piece) */
export let strings: Strings = DICTIONARIES[locale]

const listeners = new Set<() => void>()

function applyHtmlLang(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[locale]
}
applyHtmlLang()

export const getLocale = (): Locale => locale

/** One locale's dictionary (tests; the static index.html and manifest use the Chinese one) */
export const dictionary = (which: Locale): Strings => DICTIONARIES[which]

/**
 * Switches the language: the dictionary, <html lang>, and every component on screen (through
 * useLocale in App). `remember: false` leaves localStorage alone (tests).
 */
export function setLocale(next: Locale, remember = true): void {
  if (remember) save(next)
  if (next === locale) return
  locale = next
  strings = DICTIONARIES[next]
  applyHtmlLang()
  for (const listener of listeners) listener()
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
