// Chat text in the browser (D3, e5-t02): finding links, deciding when Enter sends, and which
// messages are unread. Pure, so Vitest runs them directly.
import type { ChatMessage } from '../../shared/chat.ts'

/** A piece of a message: plain text, or a link to open (http and https only) */
export type ChatSegment =
  { type: 'text'; text: string } | { type: 'link'; text: string; href: string }

// A URL starts at http:// or https:// and runs to whitespace or a character that cannot be
// part of one in running text (quotes, angle brackets, CJK punctuation)
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。、；：！？「」『』（）【】《》]+/giu
// Punctuation that ends a sentence rather than the URL
const TRAILING = /[.,;:!?)\]}'"]$/u

const count = (text: string, char: string): number => text.split(char).length - 1

/** The href a link may have: an absolute http(s) URL, or null (never javascript:, data:, …) */
export function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Splits a message into text and links. Only http:// and https:// URLs become links; the text
 * around them, and anything that only looks like markup, stays text (rendered as text, never as
 * HTML). Trailing sentence punctuation is not part of the link, but a closing bracket that has
 * its opening one inside the URL is (Wikipedia-style links).
 */
export function splitLinks(text: string): ChatSegment[] {
  const segments: ChatSegment[] = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0]
    while (TRAILING.test(url)) {
      // A closing parenthesis that balances an opening one in the URL belongs to it
      if (url.endsWith(')') && count(url, '(') >= count(url, ')')) break
      url = url.slice(0, -1)
    }
    const start = match.index
    const href = safeHref(url)
    if (!href) continue
    if (start > last) segments.push({ type: 'text', text: text.slice(last, start) })
    segments.push({ type: 'link', text: url, href })
    last = start + url.length
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) })
  return segments
}

/** The bits of a keydown event the composer looks at */
export interface ComposeKey {
  key: string
  shiftKey: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  /** True while an input method (Chinese, Japanese, …) is composing */
  isComposing?: boolean
  /** 229 is what browsers report for a key that goes to an input method (Safari's isComposing lags) */
  keyCode?: number
}

/**
 * An Enter this soon after `compositionend` picked a candidate; it did not ask to send. Safari
 * (macOS and iOS) ends the composition before the Enter's keydown, which then has isComposing
 * false and, on some versions, keyCode 13 instead of 229.
 */
export const COMPOSITION_GRACE_MS = 200

export interface SendKeyContext {
  /**
   * Whether Enter sends at all. Off where a touch screen is the main input (`media.touchPrimary`):
   * a phone keyboard's Enter also picks 注音 candidates and does not always say so, so there Enter
   * is a new line and only the send button sends (like LINE and WhatsApp).
   */
  enterSends: boolean
  /** A composition is in progress (compositionstart seen, compositionend not yet) */
  composing?: boolean
  /** When the last composition ended (ms, the same clock as `now`), or null */
  compositionEndedAt?: number | null
  now?: number
}

/**
 * Whether this keydown sends the message: Enter without Shift (Shift+Enter is a new line), only
 * where Enter sends (not on touch screens), and never while an input method is composing or
 * within COMPOSITION_GRACE_MS after it ended: there Enter picks the candidate (注音、倉頡、拼音),
 * and sending would cut the sentence in half.
 */
export function isSendKey(
  event: ComposeKey,
  context: SendKeyContext = { enterSends: true },
): boolean {
  if (event.key !== 'Enter' || !context.enterSends) return false
  if (event.isComposing || event.keyCode === 229 || context.composing) return false
  const ended = context.compositionEndedAt ?? null
  if (ended !== null && (context.now ?? 0) - ended < COMPOSITION_GRACE_MS) return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/** Messages from others after `seen` (an id): what the unread badge counts */
export function countUnread(
  messages: readonly ChatMessage[],
  seen: number,
  you: string | null,
): number {
  let count = 0
  for (const message of messages) if (message.id > seen && message.from !== you) count++
  return count
}

/** The newest message's id, or 0 */
export const latestId = (messages: readonly ChatMessage[]): number => messages.at(-1)?.id ?? 0

/** A message's time as the list shows it: 21:04 (24-hour, the browser's time zone) */
export function chatTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
