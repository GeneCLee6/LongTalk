import type { Facts, StorageKey } from './facts.ts'

// The shape of the privacy policy's text (I6, e11-t07). One module per language
// (policy.zh-TW.ts, policy.en.ts), lazily loaded: the text is long and must stay out of the home
// page's JS budget, so it does not live in the main dictionaries. PrivacyPage draws these blocks.

/** A piece of a sentence: text, or a link (`/...` stays in the app; others open a new tab) */
export type Inline = string | { text: string; href: string }

export type TableRow = {
  /** The same in both languages (a test compares them) */
  key: string
  cells: readonly string[]
}

export type Block =
  | { kind: 'p'; text: readonly Inline[] }
  | { kind: 'list'; items: readonly (readonly Inline[])[] }
  | {
      kind: 'table'
      caption: string
      columns: readonly string[]
      rows: readonly TableRow[]
    }
  /** Where to send a request: PRIVACY_CONTACT, with the warning when it is public */
  | { kind: 'contact' }

export const SECTION_IDS = [
  'about',
  'stored',
  'media',
  'retention',
  'chat-files',
  'accounts',
  'backups',
  'telemetry',
  'abuse',
  'processors',
  'browser',
  'recording',
  'deletion',
  'notices',
  'changes',
] as const

export type SectionId = (typeof SECTION_IDS)[number]

export type Section = { id: SectionId; title: string; blocks: readonly Block[] }

export type PolicyDocument = {
  title: string
  updated: (date: string) => string
  contentsTitle: string
  /** The link to PRIVACY_CONTACT, and the warning shown when it is public */
  contactLink: string
  contactPublicWarning: string
  sections: readonly Section[]
}

/** What one language's module exports */
export type PolicyText = (facts: Facts) => PolicyDocument

/** One row per browser storage key: a compile error when a language misses one */
export type StorageDescriptions = Readonly<Record<StorageKey, string>>
