// The room's text chat (D3, e5-t01): what a message is, how long it may be, how much the room
// keeps and how fast a member may send. Shared by the Worker (RoomHost decides) and the browser
// (which checks the same limits before sending, so a refused message stays in the box).
import type { ChatFile } from './files.ts'
import { isPollResult, type PollResult } from './interact.ts'

/** A message's length in characters (code points), after normalizeChatText (E5: ≤ 2000 字) */
export const MAX_CHAT_CHARS = 2_000
/** The room keeps this many of the latest messages; someone joining gets all of them */
export const CHAT_HISTORY = 200
/** History goes to a joiner in chunks of this many, so no frame gets large (CJK is 3 bytes) */
export const CHAT_CHUNK = 50
/** Each member may send at most CHAT_RATE.count messages in any CHAT_RATE.windowMs */
export const CHAT_RATE = { count: 10, windowMs: 10_000 } as const

/** One message as the room keeps it and everyone sees it */
export type ChatMessage = {
  /** Increases by one with every message in the room (never reused while the room lives) */
  id: number
  /** The sender's member id (who is "you" is decided by comparing it) */
  from: string
  /** The sender's name when it was sent: a member who leaves or renames keeps old messages */
  name: string
  /** Plain text: newlines kept, never HTML (the browser renders it as text, links as anchors) */
  text: string
  /** When the room accepted it (ms since the epoch, the server's clock) */
  at: number
  /**
   * A file a member shared (I5, e5-t05): the room writes this message itself when the upload
   * finishes; `text` is then the file's name, for previews and older readers
   */
  file?: ChatFile
  /**
   * A poll that ended (L5, e5-t07): the room writes this message itself, from who ended it; `text`
   * is then the question, for previews and older readers
   */
  poll?: PollResult
  /**
   * The breakout room the sender was in (L3, e10-t04; shared/breakout.ts chatVisible); absent: the
   * main room. Only members of that room are sent it
   */
  group?: string
}

// Control characters (but the newline) and the bidirectional overrides that could make text
// render as something else (U+202A–202E, U+2066–2069)
const UNSAFE_CHAT_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu

/**
 * A message as the room stores it: line breaks unified to \n, tabs to spaces, every other
 * control character and bidi override removed, more than two blank lines in a row squeezed,
 * trimmed; null when nothing is left or it is longer than MAX_CHAT_CHARS. The browser uses it
 * before sending, the server again on receipt.
 */
export function normalizeChatText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(UNSAFE_CHAT_CHARS, (char) => (char === '\n' ? '\n' : ''))
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (text === '' || [...text].length > MAX_CHAT_CHARS) return null
  return text
}

/**
 * Who sent what when, for the rate limit: a sliding window of send times per sender. The room
 * keeps one (in memory: an eviction forgets it, which only ever lets a member send sooner); the
 * browser keeps one for itself to say "too fast" before the room has to.
 */
export class ChatRateLimit {
  private readonly sent = new Map<string, number[]>()
  private readonly count: number
  private readonly windowMs: number

  constructor(limit: { count: number; windowMs: number } = CHAT_RATE) {
    this.count = limit.count
    this.windowMs = limit.windowMs
  }

  /** Whether `sender` may send at `now`; when it may, the send is counted */
  take(sender: string, now: number): boolean {
    const recent = (this.sent.get(sender) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.count) {
      this.sent.set(sender, recent)
      return false
    }
    recent.push(now)
    this.sent.set(sender, recent)
    return true
  }

  forget(sender: string): void {
    this.sent.delete(sender)
  }

  clear(): void {
    this.sent.clear()
  }
}

/** A shared file in a message, as far as the browser checks it (the server is trusted) */
function isChatFile(value: unknown): value is ChatFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    typeof file.id === 'string' &&
    typeof file.name === 'string' &&
    typeof file.size === 'number' &&
    typeof file.mime === 'string' &&
    (file.kind === 'image' || file.kind === 'file') &&
    typeof file.thumb === 'boolean' &&
    typeof file.expiresAt === 'number'
  )
}

/** A message the room sent, as far as the browser checks it (the server is trusted) */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    Number.isSafeInteger(message.id) &&
    typeof message.from === 'string' &&
    typeof message.name === 'string' &&
    typeof message.text === 'string' &&
    typeof message.at === 'number' &&
    (message.file === undefined || isChatFile(message.file)) &&
    (message.poll === undefined || isPollResult(message.poll)) &&
    (message.group === undefined || typeof message.group === 'string')
  )
}
