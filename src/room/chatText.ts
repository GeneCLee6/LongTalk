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
 * Whether this keydown sends the message: Enter without Shift (Shift+Enter is a new line), and
 * never while an input method is composing: there Enter picks the candidate (注音、倉頡、拼音),
 * and sending would cut the sentence in half.
 */
export function isSendKey(event: ComposeKey): boolean {
  if (event.key !== 'Enter') return false
  if (event.isComposing || event.keyCode === 229) return false
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
